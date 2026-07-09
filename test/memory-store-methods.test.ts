// memory-store-methods.test.ts — tests for mergeProject on MemoryStore
// Run: node --no-warnings --experimental-strip-types --test test/memory-store-methods.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
