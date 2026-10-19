// memory-validation.test.ts — closed value sets (type / scope) on every write path, the
// v5→v6 migration that normalises legacy rows, and import of legacy-typed exports.
// Run: node --no-warnings --experimental-strip-types --test test/memory-validation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";
import { fts5Available, MEMORY_SCHEMA_VERSION } from "../src/infrastructure/sqlite/schema.ts";
import {
  InvalidMemoryValueError,
  OBSERVATION_TYPES,
  parseObservationType,
  parseScope,
  type ObservationType,
  type Scope,
} from "../src/domain/memory/model.ts";
import { parseExportedObservation } from "../src/domain/memory/portable.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    env,
    input,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "leina-memval-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The memory schema exactly as v5 (2.x) shipped it — frozen here so the fixture stays an
// OLD db even after the live DDL grows new columns.
const V5_DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
  title TEXT, summary TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE observations (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
  type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  topic_key TEXT, session_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT
);
CREATE UNIQUE INDEX uq_obs_topic ON observations(project_key, scope, topic_key)
  WHERE topic_key IS NOT NULL AND superseded_by IS NULL;
CREATE TABLE memory_anchors (
  observation_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'about',
  anchor_label TEXT, anchor_file TEXT, anchor_hash TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (observation_id, node_id, role)
);
`;
// The v5 FTS5 index + sync triggers (only on Node builds that have FTS5).
const V5_FTS_DDL = `
CREATE VIRTUAL TABLE obs_fts USING fts5(
  title, content, content='observations', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER obs_ai AFTER INSERT ON observations WHEN new.superseded_by IS NULL
BEGIN INSERT INTO obs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
CREATE TRIGGER obs_ad AFTER DELETE ON observations WHEN old.superseded_by IS NULL
BEGIN INSERT INTO obs_fts(obs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); END;
CREATE TRIGGER obs_au AFTER UPDATE ON observations WHEN old.superseded_by IS NULL AND new.superseded_by IS NULL
BEGIN
  INSERT INTO obs_fts(obs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO obs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
`;

/** A v5 db holding rows the old unvalidated CLI could write. */
function makeV5MemoryDb(dbPath: string, rows: { id: string; type: string; scope?: string; topic?: string; supersededBy?: string; title?: string; content?: string }[]): void {
  const db = new DatabaseSync(dbPath);
  db.exec(V5_DDL);
  if (fts5Available(db)) db.exec(V5_FTS_DDL);
  const ins = db.prepare(
    `INSERT INTO observations (id, project_key, scope, type, title, content, topic_key, created_at, updated_at, revision, superseded_by)
     VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  let ts = 1_700_000_000_000;
  for (const r of rows) {
    ts += 1000;
    ins.run(r.id, r.scope ?? "project", r.type, r.title ?? `title ${r.id}`, r.content ?? `content ${r.id}`, r.topic ?? null, ts, ts, r.supersededBy ?? null);
  }
  db.exec("PRAGMA user_version = 5");
  db.close();
}

test("(val-1) domain parsers accept the closed sets and list the valid values otherwise", () => {
  for (const t of OBSERVATION_TYPES) assert.equal(parseObservationType(t), t);
  assert.equal(parseScope("infra"), "infra");
  assert.throws(() => parseObservationType("note"), (e: unknown) => {
    assert.ok(e instanceof InvalidMemoryValueError);
    assert.match(e.message, /invalid type "note": must be one of decision\|bugfix\|/);
    return true;
  });
  assert.equal(parseObservationType("note", { legacy: true }), "discovery", "legacy alias maps on import");
  assert.throws(() => parseObservationType("weird", { legacy: true }), InvalidMemoryValueError);
  assert.throws(() => parseObservationType(42), InvalidMemoryValueError);
  assert.throws(() => parseScope("galaxy"), /invalid scope "galaxy": must be one of project\|personal\|/);
});

test("(val-2) the store rejects an invalid type/scope on save, update and per batch item", () => {
  withDir((dir) => {
    const store = new SQLiteMemoryRepository(join(dir, "memory.db"), "p");
    try {
      assert.throws(
        () => store.save({ title: "t", content: "c", type: "note" as ObservationType }),
        /invalid type "note"/,
      );
      assert.throws(
        () => store.save({ title: "t", content: "c", type: "manual", scope: "galaxy" as Scope }),
        /invalid scope "galaxy"/,
      );
      const { observation } = store.save({ title: "t", content: "c", type: "manual" });
      assert.throws(() => store.update(observation.id, { type: "todo" as ObservationType }), /invalid type "todo"/);
      assert.equal(store.get(observation.id)?.type, "manual", "a rejected update writes nothing");

      const results = store.saveBatch([
        { title: "ok", content: "c", type: "bugfix" },
        { title: "bad", content: "c", type: "note" as ObservationType },
      ]);
      assert.equal(results[0]!.ok, true);
      assert.equal(results[1]!.ok, false);
      assert.match((results[1] as { error: string }).error, /must be one of/);
    } finally {
      store.close();
    }
  });
});

test("(val-3) v5→v6 migration: legacy types map to canonical ones, unknowns become manual, idempotent", () => {
  withDir((dir) => {
    const dbPath = join(dir, "memory.db");
    makeV5MemoryDb(dbPath, [
      { id: "legacy:a", type: "note", topic: "t/a", content: "alpha legacy note" },
      { id: "legacy:b", type: "project", scope: "galaxy" },
      { id: "legacy:c", type: "weird" },
      { id: "legacy:d", type: "decision" },
      { id: "legacy:a-snap", type: "note", topic: "t/a", supersededBy: "legacy:a" },
    ]);
    const store = new SQLiteMemoryRepository(dbPath, "legacy");
    try {
      assert.equal(store.get("legacy:a")?.type, "discovery");
      assert.equal(store.get("legacy:a-snap")?.type, "discovery", "snapshots are normalised too");
      assert.equal(store.get("legacy:b")?.type, "discovery");
      assert.equal(store.get("legacy:b")?.scope, "project", "unknown scope → project");
      assert.equal(store.get("legacy:c")?.type, "manual", "unknown type → manual");
      assert.equal(store.get("legacy:d")?.type, "decision", "valid rows untouched");
      // The FTS index survives the in-place type rewrite (obs_au re-indexed identical text).
      assert.deepEqual(store.search("alpha").map((h) => h.id), ["legacy:a"]);
    } finally {
      store.close();
    }
    const probe = new DatabaseSync(dbPath);
    try {
      assert.equal((probe.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MEMORY_SCHEMA_VERSION);
    } finally {
      probe.close();
    }
    // Re-open: nothing left to rewrite, no error.
    const again = new SQLiteMemoryRepository(dbPath, "legacy");
    assert.equal(again.get("legacy:c")?.type, "manual");
    again.close();
  });
});

test("(val-4) import accepts a legacy-typed export line and maps it; other unknown types still fail", () => {
  const line = {
    schemaVersion: 1, id: "p:x", projectKey: "p", scope: "project", type: "note",
    title: "t", content: "c", createdAt: 1, updatedAt: 1, revision: 1, anchors: [],
  };
  const ok = parseExportedObservation(line);
  assert.ok(ok.ok);
  assert.equal(ok.value.type, "discovery");
  const bad = parseExportedObservation({ ...line, type: "todo" });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /type must be one of decision\|.*\(legacy note\|reference\|suggestion\|project are mapped\)/);
});

test("(val-5) CLI: invalid --type/--scope fail with the valid values; legacy export re-imports in a fresh home", () => {
  const homeA = mkdtempSync(join(tmpdir(), "leina-memval-ha-"));
  const homeB = mkdtempSync(join(tmpdir(), "leina-memval-hb-"));
  const proj = mkdtempSync(join(tmpdir(), "leina-memval-proj-"));
  try {
    const envA = { ...process.env, LEINA_HOME: homeA };
    const bad = runCli(["memory", "save", proj, "--title", "t", "--content", "c", "--type", "note"], envA);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /invalid type "note": must be one of decision\|bugfix\|architecture\|discovery\|pattern\|config\|preference\|manual/);
    assert.doesNotMatch(bad.stderr, /at .*\.ts:\d+/, "no stack trace");
    const badScope = runCli(["memory", "search", proj, "x", "--scope", "galaxy"], envA);
    assert.equal(badScope.code, 1);
    assert.match(badScope.stderr, /invalid scope "galaxy"/);

    // An export written by a 2.x store (legacy `note` type) loads into a fresh home.
    const exportFile = join(proj, "legacy.jsonl");
    writeFileSync(exportFile, `${JSON.stringify({
      schemaVersion: 1, id: "old:1", projectKey: "old", scope: "project", type: "note",
      title: "legacy", content: "legacy body", createdAt: 1, updatedAt: 1, revision: 1, anchors: [],
    })}\n`);
    const imp = runCli(["memory", "import", proj, "--in", exportFile], { ...process.env, LEINA_HOME: homeB });
    assert.equal(imp.code, 0, imp.stderr);
    assert.match(imp.stdout, /imported: 1 new/);
    const got = runCli(["memory", "get", proj, "old:1"], { ...process.env, LEINA_HOME: homeB });
    assert.match(got.stdout, /type: discovery/);
  } finally {
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
