// memory-lifecycle.test.ts — observation status (active | resolved | obsolete): the store
// verbs, the v6→v7 migration, export/import propagation, and the CLI surface
// (resolve / reopen / update --status).
// Run: node --no-warnings --experimental-strip-types --test test/memory-lifecycle.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";
import { MEMORY_SCHEMA_VERSION } from "../src/infrastructure/sqlite/schema.ts";
import type { ObservationStatus } from "../src/domain/memory/model.ts";
import { makeV5MemoryDb } from "./helpers/memory-v5-db.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    env,
    input,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function withStore(fn: (store: SQLiteMemoryRepository, dbPath: string) => void | Promise<void>, key = "p"): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "leina-life-"));
  const dbPath = join(dir, "memory.db");
  const store = new SQLiteMemoryRepository(dbPath, key);
  return (async () => {
    try {
      await fn(store, dbPath);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 3));

test("(life-1) resolve stamps status/date/note without touching updatedAt or revision; reopen clears it", async () => {
  await withStore(async (store) => {
    const { observation: o } = store.save({ title: "Backlog item", content: "do the thing", type: "decision" });
    assert.equal(o.status, "active");
    assert.equal(o.statusChangedAt, undefined);
    await tick();
    const resolved = store.update(o.id, { status: "resolved", resolution: "done in 1a2b3c" });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolution, "done in 1a2b3c");
    assert.ok(resolved.statusChangedAt !== undefined && resolved.statusChangedAt > o.updatedAt);
    assert.equal(resolved.updatedAt, o.updatedAt, "a status change is not an edit");
    assert.equal(resolved.revision, o.revision);

    const reopened = store.update(o.id, { status: "active" });
    assert.equal(reopened.status, "active");
    assert.equal(reopened.resolution, undefined, "reopen clears the resolution");
    assert.equal(reopened.updatedAt, o.updatedAt);

    // A content edit together with a status change IS an edit.
    await tick();
    const edited = store.update(o.id, { status: "obsolete", content: "superseded by the new plan" });
    assert.equal(edited.status, "obsolete");
    assert.ok(edited.updatedAt > o.updatedAt);
  });
});

test("(life-2) context excludes non-active notes (unless asked) and stays newest-first after a resolve", async () => {
  await withStore(async (store) => {
    const a = store.save({ title: "A", content: "a", type: "manual" }).observation;
    await tick();
    const b = store.save({ title: "B", content: "b", type: "manual" }).observation;
    await tick();
    const c = store.save({ title: "C", content: "c", type: "manual" }).observation;
    store.update(a.id, { status: "resolved" });
    store.update(c.id, { status: "obsolete" });

    assert.deepEqual(store.recentContext().observations.map((o) => o.id), [b.id], "only active notes are context");
    const all = store.recentContext({ includeInactive: true }).observations.map((o) => o.id);
    assert.deepEqual(all, [c.id, b.id, a.id], "resolving never reorders by recency");
  });
});

test("(life-3) same-millisecond saves order deterministically (id tie-break)", async () => {
  await withStore((store) => {
    const results = store.saveBatch(
      Array.from({ length: 6 }, (_, i) => ({ title: `n${i}`, content: "x", type: "manual" as const })),
      { atomic: true },
    );
    const ids = results.map((r) => (r.ok ? r.data.observation.id : ""));
    const once = store.recentContext({ limit: 6 }).observations.map((o) => o.id);
    const twice = store.recentContext({ limit: 6 }).observations.map((o) => o.id);
    assert.deepEqual(once, twice);
    assert.deepEqual(new Set(once), new Set(ids));
  });
});

test("(life-4) search and get keep returning non-active notes, labelled and ranked below active ones", async () => {
  await withStore((store) => {
    const old = store.save({ title: "cache invalidation plan", content: "cache invalidation via ttl", type: "decision" }).observation;
    const live = store.save({ title: "cache notes", content: "we use cache invalidation on write", type: "discovery" }).observation;
    store.update(old.id, { status: "resolved", resolution: "replaced by write-through" });
    const hits = store.search("cache invalidation");
    assert.deepEqual(hits.map((h) => h.id), [live.id, old.id], "the resolved note is demoted, not dropped");
    assert.equal(hits[1]!.status, "resolved");
    assert.equal(store.get(old.id)?.resolution, "replaced by write-through");
  });
});

test("(life-5) invalid lifecycle input is rejected with the valid values", async () => {
  await withStore((store) => {
    const { observation: o } = store.save({ title: "t", content: "c", type: "manual" });
    assert.throws(() => store.update(o.id, { status: "done" as ObservationStatus }), /invalid status "done": must be one of active\|resolved\|obsolete/);
    assert.throws(() => store.update(o.id, { resolution: "why" }), /resolution note needs status resolved or obsolete/);
    // On an already-resolved note the note alone may be edited.
    store.update(o.id, { status: "resolved" });
    assert.equal(store.update(o.id, { resolution: "late note" }).resolution, "late note");
  });
});

test("(life-6) re-saving a resolved topic brings it back active; the snapshot keeps the old status", async () => {
  await withStore((store) => {
    const first = store.save({ title: "plan", content: "v1", type: "architecture", topicKey: "sdd/x/plan" }).observation;
    store.update(first.id, { status: "resolved", resolution: "shipped" });
    const { observation: second, evolved } = store.save({ title: "plan", content: "v2", type: "architecture", topicKey: "sdd/x/plan" });
    assert.equal(evolved, true);
    assert.equal(second.id, first.id);
    assert.equal(second.status, "active");
    assert.equal(second.resolution, undefined);
    const snap = store.exportAll().find((o) => o.supersededBy === first.id);
    assert.equal(snap?.status, "resolved");
    assert.equal(snap?.resolution, "shipped");
  });
});

test("(life-7) export/import carries the lifecycle; a later resolve propagates through import", async () => {
  await withStore(async (a) => {
    const { observation: o } = a.save({ title: "t", content: "c", type: "manual" });
    await withStore(async (b) => {
      b.importObservations(a.exportAll());
      assert.equal(b.get(o.id)?.status, "active");
      await tick();
      a.update(o.id, { status: "resolved", resolution: "fixed" });
      const report = b.importObservations(a.exportAll());
      assert.equal(report.updated, 1, "same revision + updatedAt, newer status change wins");
      assert.equal(b.get(o.id)?.status, "resolved");
      assert.equal(b.get(o.id)?.resolution, "fixed");
      // An export without lifecycle fields (taken before 3.0) never reopens a resolved note.
      const legacy = a.exportAll().map(({ status: _s, statusChangedAt: _c, resolution: _r, ...rest }) => ({ ...rest, status: "active" as const }));
      assert.equal(b.importObservations(legacy).skippedOlder, 1);
      assert.equal(b.get(o.id)?.status, "resolved");
    }, "p");
  }, "p");
});

test("(life-8) v5 db migrates to the current schema with every row active; reopening is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-life-mig-"));
  try {
    const dbPath = join(dir, "memory.db");
    makeV5MemoryDb(dbPath, [
      { id: "legacy:1", type: "decision", topic: "a/b" },
      { id: "legacy:1-snap", type: "decision", topic: "a/b", supersededBy: "legacy:1" },
    ]);
    for (let i = 0; i < 2; i++) {
      const store = new SQLiteMemoryRepository(dbPath, "legacy");
      assert.equal(store.get("legacy:1")?.status, "active");
      assert.equal(store.get("legacy:1-snap")?.status, "active");
      store.update("legacy:1", { status: "resolved" });
      store.update("legacy:1", { status: "active" });
      store.close();
    }
    const db = new DatabaseSync(dbPath);
    try {
      const cols = (db.prepare("PRAGMA table_info(observations)").all() as { name: string }[]).map((c) => c.name);
      for (const c of ["status", "status_changed_at", "resolution"]) assert.ok(cols.includes(c), `column ${c}`);
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MEMORY_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(life-9) updateBatch carries status per item; an invalid one fails alone (non-atomic)", async () => {
  await withStore((store) => {
    const ids = [1, 2, 3].map((i) => store.save({ title: `n${i}`, content: "c", type: "manual" }).observation.id);
    const r = store.updateBatch([
      { id: ids[0]!, fields: { status: "resolved", resolution: "ok" } },
      { id: ids[1]!, fields: { status: "closed" as ObservationStatus } },
      { id: ids[2]!, fields: { status: "obsolete" } },
    ]);
    assert.deepEqual(r.map((x) => x.ok), [true, false, true]);
    assert.deepEqual(ids.map((id) => store.get(id)?.status), ["resolved", "active", "obsolete"]);
  });
});

test("(life-10) CLI: resolve / reopen / update --status / resolve --batch; context hides, search labels", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-life-home-"));
  const proj = mkdtempSync(join(tmpdir(), "leina-life-proj-"));
  const env = { ...process.env, LEINA_HOME: home };
  try {
    const save = (title: string): string => {
      const r = runCli(["memory", "save", proj, "--title", title, "--content", `${title} body about widgets`], env);
      assert.equal(r.code, 0, r.stderr);
      return /#(\S+)/.exec(r.stdout)![1]!;
    };
    const a = save("alpha");
    const b = save("beta");
    const c = save("gamma");
    const d = save("delta");

    const res = runCli(["memory", "resolve", proj, a, "--note", "fixed in v2"], env);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Resolved #\S+ · resolved \d{4}-\d{2}-\d{2} — fixed in v2\./);

    const upd = runCli(["memory", "update", proj, b, "--status", "obsolete"], env);
    assert.equal(upd.code, 0, upd.stderr);
    assert.match(upd.stdout, /· obsolete/);

    const batch = runCli(["memory", "resolve", proj, "--batch"], env, JSON.stringify([c, { id: d, note: "dup", obsolete: true }]));
    assert.equal(batch.code, 0, batch.stderr);
    assert.match(batch.stdout, /· resolved/);
    assert.match(batch.stdout, /· obsolete \d{4}-\d{2}-\d{2} — dup/);

    const ctx = runCli(["memory", "context", proj], env);
    assert.doesNotMatch(ctx.stdout, /alpha|beta|gamma|delta/, "non-active notes are not context");

    const search = runCli(["memory", "search", proj, "widgets"], env);
    assert.match(search.stdout, /\(resolved\) alpha/);
    assert.match(search.stdout, /\(obsolete\) beta/);

    const get = runCli(["memory", "get", proj, a], env);
    assert.match(get.stdout, /status: resolved \d{4}-\d{2}-\d{2} — fixed in v2/);

    const reopen = runCli(["memory", "reopen", proj, a], env);
    assert.equal(reopen.code, 0, reopen.stderr);
    assert.match(runCli(["memory", "context", proj], env).stdout, /alpha/);

    const bad = runCli(["memory", "update", proj, a, "--status", "done"], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /invalid status "done": must be one of active\|resolved\|obsolete/);
    const unknown = runCli(["memory", "resolve", proj, "nope:1"], env);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no observation with id nope:1/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
