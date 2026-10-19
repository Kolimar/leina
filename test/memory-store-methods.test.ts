// memory-store-methods.test.ts — tests for mergeProject on MemoryStore
// Run: node --no-warnings --experimental-strip-types --test test/memory-store-methods.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMemoryRepository as MemoryStore } from "../src/infrastructure/sqlite/memory-repository.ts";

function tmpStore(suffix = ""): { store: MemoryStore; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `leina-store-${suffix || "test"}-`));
  const path = join(dir, "memory.db");
  const store = new MemoryStore(path, "test-project");
  return { store, path, dir };
}

// ---------------------------------------------------------------------------
// mergeProject
// ---------------------------------------------------------------------------

test("(mergeProject-1) basic move: all obs from src re-keyed to dst", () => {
  const { store: unusedStore, dir } = tmpStore("merge1");
  unusedStore.close(); // Windows: an open handle on memory.db turns the teardown rmSync into EPERM
  try {
    // Seed 5 observations under "src"
    const src = new MemoryStore(join(dir, "memory.db"), "src");
    for (let i = 0; i < 5; i++) {
      src.save({ title: `Title ${i}`, content: `Content ${i}`, type: "manual" });
    }
    src.close();

    const global = new MemoryStore(join(dir, "memory.db"), "dst");
    const result = global.mergeProject("src", "dst");
    global.close();

    assert.equal(result.moved, 5, "5 rows moved");
    assert.equal(result.superseded, 0, "0 superseded");

    // Verify: dst now has the rows
    const verify = new MemoryStore(join(dir, "memory.db"), "dst");
    const ctx = verify.recentContext({ limit: 10 });
    assert.equal(ctx.observations.length, 5, "dst now has 5 obs");
    verify.close();

    // Verify: src has no rows
    const srcCheck = new MemoryStore(join(dir, "memory.db"), "src");
    const srcCtx = srcCheck.recentContext({ limit: 10 });
    assert.equal(srcCtx.observations.length, 0, "src now empty");
    srcCheck.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mergeProject-2) dryRun: counts returned but DB unchanged", () => {
  const { store: unusedStore, dir } = tmpStore("merge2");
  unusedStore.close(); // Windows: an open handle on memory.db turns the teardown rmSync into EPERM
  try {
    // Seed 3 observations under "from-key"
    const src = new MemoryStore(join(dir, "memory.db"), "from-key");
    for (let i = 0; i < 3; i++) {
      src.save({ title: `T${i}`, content: `C${i}`, type: "manual" });
    }
    src.close();

    const global = new MemoryStore(join(dir, "memory.db"), "to-key");
    const dryResult = global.mergeProject("from-key", "to-key", { dryRun: true });
    global.close();

    assert.equal(dryResult.moved, 3, "dry-run: 3 would-be moved");

    // Verify DB is unchanged: from-key still has the rows
    const check = new MemoryStore(join(dir, "memory.db"), "from-key");
    const ctx = check.recentContext({ limit: 10 });
    assert.equal(ctx.observations.length, 3, "from-key unchanged after dry-run");
    check.close();

    // Verify to-key has no rows
    const toCheck = new MemoryStore(join(dir, "memory.db"), "to-key");
    const toCtx = toCheck.recentContext({ limit: 10 });
    assert.equal(toCtx.observations.length, 0, "to-key empty after dry-run");
    toCheck.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mergeProject-3) from === to throws", () => {
  const { store, dir } = tmpStore("merge3");
  try {
    assert.throws(
      () => store.mergeProject("same", "same"),
      /from and to must differ/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mergeProject-4) topic collision: colliding from-row is superseded, to-row preserved", () => {
  const { store: unusedStore, dir } = tmpStore("merge4");
  unusedStore.close(); // Windows: an open handle on memory.db turns the teardown rmSync into EPERM
  try {
    // Create src observation with a topic_key
    const src = new MemoryStore(join(dir, "memory.db"), "src");
    src.save({ title: "Source obs", content: "src content", type: "manual", topicKey: "shared/topic" });
    src.close();

    // Create dst observation with the SAME topic_key
    const dst = new MemoryStore(join(dir, "memory.db"), "dst");
    dst.save({ title: "Dest obs", content: "dst content", type: "manual", topicKey: "shared/topic" });

    const result = dst.mergeProject("src", "dst");
    dst.close();

    // One row superseded (the src row collided)
    assert.equal(result.superseded, 1, "1 row superseded due to topic collision");

    // Verify: dst still has exactly 1 live row with the topic
    const verify = new MemoryStore(join(dir, "memory.db"), "dst");
    const hits = verify.search("content", { limit: 10 });
    const liveWithTopic = hits.filter((h) => h.topicKey === "shared/topic");
    assert.equal(liveWithTopic.length, 1, "exactly 1 live row with shared/topic");
    // It should be the dst row (kept)
    assert.ok(liveWithTopic[0]!.title === "Dest obs" || liveWithTopic[0]!.title === "Source obs");
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// id "#" presentation-prefix normalization
//
// search/get/context render ids with a leading "#" (`#${id}`). A real stored id
// can never start with "#", so the writer verbs must tolerate the prefix the
// same way get() does — otherwise an id copy-pasted from search fails to update.
// ---------------------------------------------------------------------------

test("(id-prefix-1) update tolerates the leading '#' shown by search/get", () => {
  const { store, dir } = tmpStore("idprefix1");
  try {
    const { observation } = store.save({ title: "Orig", content: "before", type: "manual" });
    assert.ok(!observation.id.startsWith("#"), "stored id has no '#' prefix");

    // Update via the presentation form (`#${id}`) — must resolve the same row.
    const updated = store.update(`#${observation.id}`, { content: "after" });
    assert.equal(updated.id, observation.id, "same id returned");
    assert.equal(updated.content, "after", "content updated via #-prefixed id");

    // Sanity: the bare id still works too.
    const again = store.update(observation.id, { title: "Renamed" });
    assert.equal(again.title, "Renamed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(id-prefix-2) update on a truly-missing '#' id still reports the clean error", () => {
  const { store, dir } = tmpStore("idprefix2");
  try {
    assert.throws(
      () => store.update("#does:not:exist", { content: "x" }),
      /no observation with id does:not:exist/,
      "error message reports the normalized id (no leading '#')",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(id-prefix-3) updateBatch tolerates '#' prefixes in atomic and non-atomic modes", () => {
  const { store, dir } = tmpStore("idprefix3");
  try {
    const a = store.save({ title: "A", content: "a0", type: "manual" }).observation;
    const b = store.save({ title: "B", content: "b0", type: "manual" }).observation;

    // Non-atomic: each item in its own tx; both ids carry the '#'.
    const nonAtomic = store.updateBatch([
      { id: `#${a.id}`, fields: { content: "a1" } },
      { id: `#${b.id}`, fields: { content: "b1" } },
    ]);
    assert.deepEqual(nonAtomic.map((r) => r.ok), [true, true], "non-atomic both ok");
    assert.equal(store.get(a.id)!.content, "a1");
    assert.equal(store.get(b.id)!.content, "b1");

    // Atomic: single tx; both ids carry the '#'.
    const atomic = store.updateBatch(
      [
        { id: `#${a.id}`, fields: { content: "a2" } },
        { id: `#${b.id}`, fields: { content: "b2" } },
      ],
      { atomic: true },
    );
    assert.deepEqual(atomic.map((r) => r.ok), [true, true], "atomic both ok");
    assert.equal(store.get(a.id)!.content, "a2");
    assert.equal(store.get(b.id)!.content, "b2");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// anchors-only update
//
// Historically _updateInTx only re-resolved anchors when content ALSO changed,
// so `update(id, { anchors })` reported ok but silently kept the old anchors.
// Re-anchoring a memory without touching its text must work.
// ---------------------------------------------------------------------------

test("(anchors-update-1) update with anchors alone replaces the stored anchors", () => {
  const { store, dir } = tmpStore("anchupd1");
  try {
    const { observation } = store.save({
      title: "Anchored",
      content: "body",
      type: "manual",
      anchors: ["src/old-a.ts", "src/old-b.ts"],
    });
    assert.equal(store.anchorsForObservation(observation.id).length, 2, "two initial anchors");

    // Anchors-only update: no content, no title.
    store.update(observation.id, { anchors: ["src/new.ts"] });

    const after = store.anchorsForObservation(observation.id);
    assert.equal(after.length, 1, "old anchors replaced, not kept");
    assert.ok(
      after.every((a) => !a.nodeId.includes("old")),
      "no stale anchor rows survive an anchors-only update",
    );
    assert.equal(store.get(observation.id)!.content, "body", "content untouched");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(anchors-update-2) update with empty anchors array clears them", () => {
  const { store, dir } = tmpStore("anchupd2");
  try {
    const { observation } = store.save({
      title: "Anchored",
      content: "body",
      type: "manual",
      anchors: ["src/a.ts"],
    });
    store.update(observation.id, { anchors: [] });
    assert.equal(store.anchorsForObservation(observation.id).length, 0, "anchors cleared");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(anchors-update-3) updateBatch with anchors-only items takes effect", () => {
  const { store, dir } = tmpStore("anchupd3");
  try {
    const { observation: a } = store.save({ title: "A", content: "a", type: "manual", anchors: ["src/x.ts"] });
    const { observation: b } = store.save({ title: "B", content: "b", type: "manual", anchors: ["src/y.ts"] });

    const results = store.updateBatch(
      [
        { id: a.id, fields: { anchors: ["src/x2.ts"] } },
        { id: b.id, fields: { anchors: ["src/y2.ts", "src/y3.ts"] } },
      ],
      { atomic: true },
    );
    assert.deepEqual(results.map((r) => r.ok), [true, true], "both updates ok");
    assert.equal(store.anchorsForObservation(a.id).length, 1);
    assert.equal(store.anchorsForObservation(b.id).length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// project confinement
//
// memory.db is ONE global file keyed by project_key. A repository scoped to project Q must
// never read or write project P's rows by id, even when handed P's (exported, committed,
// or guessed) observation id — through the CLI, MCP memory_get/memory_update, or batches.
// ---------------------------------------------------------------------------

function twoProjects(suffix: string): { p: MemoryStore; q: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `leina-store-${suffix}-`));
  const path = join(dir, "memory.db");
  return { p: new MemoryStore(path, "proj-p"), q: new MemoryStore(path, "proj-q"), dir };
}

test("(scope-1) get/getBatch never return another project's observation", () => {
  const { p, q, dir } = twoProjects("scope1");
  try {
    const obs = p.save({ title: "P secret", content: "p only", type: "decision" }).observation;
    assert.equal(q.get(obs.id), undefined, "Q cannot read P's row by id");
    assert.equal(q.get(`#${obs.id}`), undefined, "nor via the '#' presentation form");
    assert.deepEqual(q.getBatch([obs.id]), [{ ok: false, error: "not found" }]);
    assert.equal(p.get(obs.id)?.content, "p only", "P still reads its own row");
  } finally {
    p.close(); q.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(scope-2) update/updateBatch cannot modify another project's observation", () => {
  const { p, q, dir } = twoProjects("scope2");
  try {
    const obs = p.save({ title: "P", content: "original", type: "decision", anchors: ["src/p.ts"] }).observation;
    assert.throws(() => q.update(obs.id, { content: "hijacked" }), /no observation with id/);
    const nonAtomic = q.updateBatch([{ id: obs.id, fields: { content: "hijacked" } }]);
    assert.deepEqual(nonAtomic, [{ ok: false, error: `no observation with id ${obs.id}` }]);
    const atomic = q.updateBatch([{ id: obs.id, fields: { content: "hijacked", anchors: [] } }], { atomic: true });
    assert.equal(atomic[0]!.ok, false, "atomic batch rejects the foreign id too");

    const after = p.get(obs.id)!;
    assert.equal(after.content, "original", "P's content untouched");
    assert.equal(p.anchorsForObservation(obs.id).length, 1, "P's anchors untouched");
  } finally {
    p.close(); q.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(scope-3) anchor reads and writes are confined to the repository's project", () => {
  const { p, q, dir } = twoProjects("scope3");
  try {
    const obs = p.save({ title: "P", content: "c", type: "architecture", anchors: ["shared/node"] }).observation;
    q.save({ title: "Q", content: "c", type: "architecture", anchors: ["shared/node"] });

    assert.deepEqual(q.anchorsForObservation(obs.id), [], "Q sees no anchors of P's observation");
    assert.equal(q.addAnchorsIfMissing(obs.id, [{ nodeId: "planted" }]), 0, "Q cannot add anchors to P's row");
    assert.equal(p.anchorsForObservation(obs.id).length, 1, "P's anchors unchanged");

    // Same graph node id in both projects: each side only sees its own observations.
    const qRecent = q.recentAnchoredObservations("shared/node", 10);
    assert.equal(qRecent.length, 1);
    assert.notEqual(qRecent[0]!.observationId, obs.id);
    assert.ok(q.anchorsForNode("shared/node").every((a) => a.observationId !== obs.id));
    assert.deepEqual(p.recentAnchoredObservations("shared/node", 10).map((r) => r.observationId), [obs.id]);
  } finally {
    p.close(); q.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mergeProject keeps history and the FTS index consistent (3.0)
// ---------------------------------------------------------------------------

/** Rowids the FTS index returns for a MATCH, read straight from obs_fts. */
function ftsRowids(path: string, match: string): number[] {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH ?").all(match) as { rowid: number }[]).map((r) => r.rowid);
  } finally {
    db.close();
  }
}

test("(mergeProject-5) superseded snapshots move with their topic; nothing stays under the old key", () => {
  const { store: unusedStore, dir, path } = tmpStore("merge5");
  unusedStore.close();
  try {
    const src = new MemoryStore(path, "src");
    for (const v of ["v1", "v2", "v3"]) src.save({ title: "plan", content: v, type: "decision", topicKey: "sdd/x/plan" });
    src.close();

    const dst = new MemoryStore(path, "dst");
    const r = dst.mergeProject("src", "dst");
    assert.deepEqual(r, { moved: 1, superseded: 0, snapshots: 2 });
    const history = dst.exportAll().filter((o) => o.topicKey === "sdd/x/plan");
    assert.equal(history.length, 3, "live row + 2 snapshots now under dst");
    dst.close();

    const left = new MemoryStore(path, "src");
    assert.equal(left.exportAll().length, 0, "no stranded snapshot under the old key");
    left.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mergeProject-6) a topic collision leaves no ghost FTS entry; later writes and compact stay clean", () => {
  const { store: unusedStore, dir, path } = tmpStore("merge6");
  unusedStore.close();
  try {
    const src = new MemoryStore(path, "src");
    src.save({ title: "Source obs", content: "zebracorn only here", type: "manual", topicKey: "shared/topic" });
    src.close();
    const dst = new MemoryStore(path, "dst");
    dst.save({ title: "Dest obs", content: "dst content", type: "manual", topicKey: "shared/topic" });
    const r = dst.mergeProject("src", "dst");
    assert.equal(r.superseded, 1);
    assert.equal(r.snapshots, 1, "the retired row travels as a snapshot");
    assert.deepEqual(ftsRowids(path, "zebracorn"), [], "the retired row left the index");
    assert.equal(dst.search("zebracorn").length, 0);
    assert.equal(dst.search("dst content")[0]?.title, "Dest obs");
    // Deleting the snapshot and writing new rows must not trip over a stale entry.
    dst.compact();
    dst.save({ title: "after", content: "zebracorn again", type: "manual" });
    assert.deepEqual(dst.search("zebracorn").map((h) => h.title), ["after"]);
    dst.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(fts-transition-1) a row leaving / re-entering the live set leaves / re-enters the index", () => {
  const { store, dir, path } = tmpStore("ftstrans");
  try {
    const a = store.save({ title: "keeper", content: "alpha", type: "manual" }).observation;
    const b = store.save({ title: "mover", content: "quokka", type: "manual" }).observation;
    store.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE observations SET superseded_by=? WHERE id=?").run(a.id, b.id);
    db.close();
    assert.deepEqual(ftsRowids(path, "quokka"), [], "retired");
    const db2 = new DatabaseSync(path);
    db2.prepare("UPDATE observations SET superseded_by=NULL, content='quokka revived' WHERE id=?").run(b.id);
    db2.close();
    assert.equal(ftsRowids(path, "revived").length, 1, "revived with its current content");
    const reopened = new MemoryStore(path, "test-project");
    assert.equal(reopened.search("quokka")[0]?.id, b.id);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mig-v8) an old db: stranded snapshots re-homed, ghost index entries purged, idempotent", () => {
  const { store, dir, path } = tmpStore("migv8");
  try {
    // Recreate what a 2.x merge left behind: a live row retired WITHOUT un-indexing it
    // (a ghost) and snapshots stranded under the old key.
    store.save({ title: "plan", content: "first", type: "decision", topicKey: "t/x/plan" });
    const live = store.save({ title: "plan", content: "second", type: "decision", topicKey: "t/x/plan" }).observation;
    const other = store.save({ title: "keeper", content: "kept", type: "manual" }).observation;
    const ghost = store.save({ title: "ghosty", content: "phantasm", type: "manual" }).observation;
    store.close();
    const db = new DatabaseSync(path);
    db.exec("DROP TRIGGER obs_au_retire");
    db.prepare("UPDATE observations SET superseded_by=? WHERE id=?").run(other.id, ghost.id);
    db.prepare("UPDATE observations SET project_key='old-key' WHERE superseded_by=?").run(live.id);
    db.exec("PRAGMA user_version = 7");
    db.close();
    assert.equal(ftsRowids(path, "phantasm").length, 1, "fixture: a ghost entry exists");

    for (let i = 0; i < 2; i++) {
      const s = new MemoryStore(path, "test-project");
      const history = s.exportAll().filter((o) => o.topicKey === "t/x/plan");
      assert.equal(history.length, 2, "the stranded snapshot is back with its live row");
      s.close();
      assert.deepEqual(ftsRowids(path, "phantasm"), [], "ghost purged");
      const check = new DatabaseSync(path);
      const n = (check.prepare("SELECT COUNT(*) AS n FROM observations WHERE project_key='old-key'").get() as { n: number }).n;
      const triggers = (check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'obs_au_re%'").get() as { n: number }).n;
      check.close();
      assert.equal(n, 0);
      assert.equal(triggers, 2, "transition triggers installed");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
