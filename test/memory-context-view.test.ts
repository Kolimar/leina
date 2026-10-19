// memory-context-view.test.ts — the ranked context view end to end: short ids accepted back by
// the id-keyed verbs, `leina memory context` output, and the SessionStart injection text.
// Run: node --no-warnings --experimental-strip-types --test test/memory-context-view.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";
import { shortObservationId } from "../src/domain/memory/model.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], { encoding: "utf8", env, input });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function withStore(fn: (store: SQLiteMemoryRepository) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "leina-ctxv-"));
  const store = new SQLiteMemoryRepository(join(dir, "memory.db"), "p");
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(ctxv-1) a short id resolves in get / update / getBatch / updateBatch, with or without '#'", () => {
  withStore((store) => {
    const { observation: o } = store.save({ title: "t", content: "c", type: "manual" });
    const short = shortObservationId(o.id);
    assert.equal(short.length, 8);
    assert.equal(store.get(short)?.id, o.id);
    assert.equal(store.get(`#${short.toUpperCase()}`)?.id, o.id, "case-insensitive, '#'-tolerant");
    assert.equal(store.get(short.slice(0, 4))?.id, o.id, "any unique prefix of ≥4 hex chars");
    assert.equal(store.update(short, { status: "resolved" }).status, "resolved");
    assert.equal(store.getBatch([short])[0]!.ok, true);
    assert.equal(store.updateBatch([{ id: short, fields: { status: "active" } }])[0]!.ok, true);
    assert.equal(store.get("ffffffff"), undefined, "an unmatched short id is simply not found");
  });
});

test("(ctxv-2) an ambiguous short id is an error asking for more characters; other projects never match", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-ctxv-amb-"));
  const dbPath = join(dir, "memory.db");
  try {
    const a = new SQLiteMemoryRepository(dbPath, "p");
    const b = new SQLiteMemoryRepository(dbPath, "q");
    // Two ids of project p sharing the first 4 hex chars of their uuid tail; one of q too.
    const rows = [
      ["p", "p:manual:x:1:abcd1111_0000"],
      ["p", "p:manual:y:1:abcd2222_0000"],
      ["q", "q:manual:z:1:beef0000_0000"],
    ] as const;
    for (const [key, id] of rows) {
      (key === "p" ? a : b).importObservations([
        { schemaVersion: 1, id, projectKey: key, scope: "project", type: "manual", title: id, content: "c", createdAt: 1, updatedAt: 1, revision: 1, status: "active", anchors: [] },
      ]);
    }
    assert.throws(() => a.get("abcd"), /ambiguous short id abcd: it matches 2 observations/);
    assert.equal(a.get("abcd1")?.id, "p:manual:x:1:abcd1111_0000");
    assert.equal(a.get("beef0000"), undefined, "project-scoped like every id-keyed verb");
    const batch = a.updateBatch([{ id: "abcd", fields: { status: "resolved" } }, { id: "abcd2", fields: { status: "resolved" } }]);
    assert.deepEqual(batch.map((r) => r.ok), [false, true]);
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ctxv-3) CLI: context prints ranked notes with short ids that get / resolve accept back", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-ctxv-home-"));
  const proj = mkdtempSync(join(tmpdir(), "leina-ctxv-proj-"));
  const env = { ...process.env, LEINA_HOME: home };
  try {
    const items = [
      { title: "free note", content: "line one\n\nline two", type: "manual" },
      { title: "sdd a", content: "a", type: "architecture", topicKey: "sdd/x/a" },
      { title: "sdd b", content: "b", type: "architecture", topicKey: "sdd/x/b" },
      { title: "sdd c", content: "c", type: "architecture", topicKey: "sdd/x/c" },
      { title: "key decision", content: "we chose y", type: "decision" },
    ];
    const saved = runCli(["memory", "save", proj, "--batch", "--atomic"], env, JSON.stringify(items));
    assert.equal(saved.code, 0, saved.stderr);

    const ctx = runCli(["memory", "context", proj], env);
    assert.equal(ctx.code, 0, ctx.stderr);
    assert.match(ctx.stdout, /RECENT OBSERVATIONS: 4 of 5 active notes, ranked by type and recency/);
    const order = [...ctx.stdout.matchAll(/^- \[\w+\] (.+?) \(#/gm)].map((m) => m[1]);
    assert.equal(order[0], "key decision", "decision outranks the rest");
    assert.equal(order.filter((t) => t!.startsWith("sdd ")).length, 2, "two per topic family");
    assert.match(ctx.stdout, /- \[manual\] free note \(#[0-9a-f]{8} · \d{4}-\d{2}-\d{2}\)\n {2}line one\n {2}line two/);

    const short = /- \[decision\] key decision \(#([0-9a-f]{8})/.exec(ctx.stdout)![1]!;
    assert.match(runCli(["memory", "get", proj, short], env).stdout, /title: key decision/);
    assert.equal(runCli(["memory", "resolve", proj, short], env).code, 0);
    assert.doesNotMatch(runCli(["memory", "context", proj], env).stdout, /key decision/);

    const bad = runCli(["memory", "context", proj, "--limit", "zero"], env);
    assert.equal(bad.code, 2, "an invalid flag value is a usage error");
    assert.match(bad.stderr, /--limit must be a positive integer/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("(ctxv-4) SessionStart injection uses the same ranked view and stays within budget", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-ctxv-inj-"));
  const proj = mkdtempSync(join(tmpdir(), "leina-ctxv-injp-"));
  const prev = { LEINA_HOME: process.env.LEINA_HOME, HOME: process.env.HOME };
  process.env.LEINA_HOME = join(home, ".leina");
  process.env.HOME = home;
  try {
    mkdirSync(join(proj, ".leina"), { recursive: true });
    writeFileSync(join(proj, ".leina", "config.json"), JSON.stringify({ project_name: "inj" }));
    const { buildActiveContext } = await import("../src/application/context/active-context.ts");
    const { globalMemoryPath } = await import("../src/infrastructure/install/share-paths.ts");
    const store = new SQLiteMemoryRepository(globalMemoryPath(), "inj");
    for (let i = 0; i < 30; i++) {
      store.save({ title: `backlog item ${i}`, content: `detail ${i} `.repeat(60), type: "decision", topicKey: `backlog/review/item-${i}` });
    }
    const done = store.save({ title: "already shipped", content: "x", type: "decision" }).observation;
    store.update(done.id, { status: "resolved" });
    store.saveSession("wrapped up the review");
    store.close();

    const { text, delivered } = buildActiveContext(proj);
    assert.equal(delivered, true);
    assert.match(text, /## Project memory — 2 of 30 active notes/);
    assert.equal((text.match(/^- \[decision\] backlog item/gm) ?? []).length, 2, "one topic family → two notes");
    assert.doesNotMatch(text, /already shipped/);
    assert.match(text, /Last session \(\d{4}-\d{2}-\d{2}\): wrapped up the review/);
    assert.match(text, /Before ending the session, run `leina memory session <dir>`/);
    assert.ok(text.length < 6500, `budget (${text.length} chars)`);
  } finally {
    if (prev.LEINA_HOME === undefined) delete process.env.LEINA_HOME;
    else process.env.LEINA_HOME = prev.LEINA_HOME;
    if (prev.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = prev.HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
