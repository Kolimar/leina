// Memory domain TDD — node:test suite
// Run: node --no-warnings --experimental-strip-types --test test/memory.test.ts
// Also picked up by: npm test (glob test/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMemoryRepository as MemoryStore } from "../src/infrastructure/sqlite/memory-repository.ts";

// ---- helpers ----------------------------------------------------------------

function tmpStore(): { store: MemoryStore; dir: string } {
  const dir = join(tmpdir(), `cg-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "memory.db");
  const store = new MemoryStore(dbPath, "test_project");
  return { store, dir };
}

function cleanup(store: MemoryStore, dir: string): void {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

// ---- (a) save → search → get round-trip ------------------------------------

test("(a) save→search→get round-trip", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation } = store.save({
      title: "Fixed N+1 query in UserList",
      content: "The UserList component was issuing one SQL query per row. Fixed by eager-loading with JOIN.",
      type: "bugfix",
    });

    // search by a term present in the content
    const hits = store.search("eager-loading");
    assert.equal(hits.length > 0, true, "search returned no hits");
    assert.equal(hits[0]!.id, observation.id, "first hit id does not match saved observation");
    assert.equal(hits[0]!.type, "bugfix");

    // get full record
    const full = store.get(observation.id);
    assert.ok(full, "get returned undefined");
    assert.equal(full.id, observation.id);
    assert.equal(full.title, "Fixed N+1 query in UserList");
    assert.ok(full.content.includes("eager-loading"), "content mismatch");
    assert.equal(full.revision, 1);
  } finally {
    cleanup(store, dir);
  }
});

// ---- (a2) get tolerates the "#" presentation prefix -------------------------

test('(a2) get tolerates leading "#" prefix as rendered by mem_search/mem_context', () => {
  const { store, dir } = tmpStore();
  try {
    const { observation } = store.save({
      title: "Prefix tolerance",
      content: "Ids are rendered with a leading # but stored without it.",
      type: "manual",
    });

    // Real stored id never starts with "#".
    assert.equal(observation.id.startsWith("#"), false);

    // Pasting the id exactly as shown (with the "#" prefix) must resolve.
    const viaPrefixed = store.get(`#${observation.id}`);
    assert.ok(viaPrefixed, 'get("#"+id) returned undefined');
    assert.equal(viaPrefixed.id, observation.id);

    // Bare id still works (no regression).
    const viaBare = store.get(observation.id);
    assert.ok(viaBare, "get(id) returned undefined");
    assert.equal(viaBare.id, observation.id);

    // A truly missing id is still a miss (the "#" strip must not over-match).
    assert.equal(store.get("#does-not-exist"), undefined);
    assert.equal(store.get("does-not-exist"), undefined);
  } finally {
    cleanup(store, dir);
  }
});

// ---- (b) topic_key upsert ---------------------------------------------------

test("(b) topic_key upsert: save twice → one row, revision=2, content updated", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation: first, evolved: ev1 } = store.save({
      title: "Auth strategy",
      content: "Using JWT for stateless auth.",
      type: "decision",
      topicKey: "auth/strategy",
    });
    assert.equal(ev1, false, "first save should not be evolved");
    assert.equal(first.revision, 1);

    const { observation: second, evolved: ev2 } = store.save({
      title: "Auth strategy",
      content: "Switched to opaque tokens stored server-side for revocability.",
      type: "decision",
      topicKey: "auth/strategy",
    });
    assert.equal(ev2, true, "second save with same topic_key should be evolved");
    assert.equal(second.id, first.id, "id should be stable across upsert (same row)");
    assert.equal(second.revision, 2, "revision should increment to 2");
    assert.ok(second.content.includes("opaque tokens"), "content should be updated");

    // DB level: count rows for this topic
    const hits = store.search("opaque tokens");
    const topicHits = hits.filter((h) => h.topicKey === "auth/strategy");
    assert.equal(topicHits.length, 1, "should be exactly 1 row for that topic_key");
  } finally {
    cleanup(store, dir);
  }
});

// ---- (c) FTS re-index on evolve ---------------------------------------------

test("(c) FTS re-index after upsert: old term gone, new term findable", () => {
  const { store, dir } = tmpStore();
  try {
    store.save({
      title: "DB connection pool",
      content: "Using pg-pool for connection pooling with maxConnections=20.",
      type: "config",
      topicKey: "config/db-pool",
    });

    // evolve with different content
    store.save({
      title: "DB connection pool",
      content: "Switched to drizzle ORM with built-in pooling; maxConnections removed.",
      type: "config",
      topicKey: "config/db-pool",
    });

    // old term should not appear (FTS re-indexed via trigger)
    const oldHits = store.search("pg-pool");
    const oldTopicHits = oldHits.filter((h) => h.topicKey === "config/db-pool");
    assert.equal(oldTopicHits.length, 0, "old term 'pg-pool' should no longer match the evolved row");

    // new term should appear
    const newHits = store.search("drizzle");
    const newTopicHits = newHits.filter((h) => h.topicKey === "config/db-pool");
    assert.equal(newTopicHits.length, 1, "new term 'drizzle' should match the evolved row");
  } finally {
    cleanup(store, dir);
  }
});

// ---- (d) null topic_key: two saves → two distinct rows ----------------------

test("(d) null topic_key: two saves produce two distinct rows", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation: o1 } = store.save({
      title: "Manual note A",
      content: "First observation without topic key, contains unicorn.",
      type: "manual",
    });
    const { observation: o2 } = store.save({
      title: "Manual note B",
      content: "Second observation without topic key, also contains unicorn.",
      type: "manual",
    });

    assert.notEqual(o1.id, o2.id, "two saves without topic_key should produce distinct ids");

    const hits = store.search("unicorn");
    assert.equal(hits.length >= 2, true, `expected at least 2 hits, got ${hits.length}`);
  } finally {
    cleanup(store, dir);
  }
});

// ---- (e) MATCH sanitization: FTS5 operator chars don't throw ----------------

// ---- (f) C1 regression: same-millisecond saves with same title+type, no topic_key ----

test("(f) same-millisecond saves produce distinct ids and no crash", () => {
  const { store, dir } = tmpStore();
  try {
    const ids: string[] = [];
    // Tight synchronous loop — no await/delay — exercises the same-ms collision path.
    for (let i = 0; i < 5; i++) {
      const { observation } = store.save({
        title: "Rapid save title",
        content: `Observation body ${i}`,
        type: "manual",
      });
      ids.push(observation.id);
    }
    // All 5 ids must be distinct
    const unique = new Set(ids);
    assert.equal(unique.size, 5, `expected 5 distinct ids, got ${unique.size}: ${ids.join(", ")}`);
    // All 5 rows must exist in the DB
    for (const id of ids) {
      const obs = store.get(id);
      assert.ok(obs, `observation ${id} not found after save`);
    }
  } finally {
    cleanup(store, dir);
  }
});

test("(e) MATCH sanitization: FTS5 operator chars in query do not throw", () => {
  const { store, dir } = tmpStore();
  try {
    store.save({
      title: "Auth bug fix",
      content: "Fixed authentication bug causing login failures.",
      type: "bugfix",
    });

    // These queries contain FTS5 operator chars that would trip the parser if unsanitized
    assert.doesNotThrow(() => store.search("auth (bug)"));
    assert.doesNotThrow(() => store.search("fix AND login"));
    assert.doesNotThrow(() => store.search("auth OR bug"));
    assert.doesNotThrow(() => store.search('"quoted phrase"'));
    assert.doesNotThrow(() => store.search("auth*"));
    assert.doesNotThrow(() => store.search("NEAR(auth, bug)"));

    // should still return results for sensible input after sanitization
    const hits = store.search("authentication bug");
    assert.equal(hits.length > 0, true, "sanitized query should still find results");
  } finally {
    cleanup(store, dir);
  }
});

// ---- (g) OR-recall: a query term absent from the record does not drop the match ----

test("(g) search is OR-recall: an absent term does not drop a present one", () => {
  const { store, dir } = tmpStore();
  try {
    store.save({
      title: "Switched to drizzle ORM",
      content: "Adopted drizzle for type-safe queries and built-in connection pooling.",
      type: "decision",
      topicKey: "decision/orm",
    });

    // 'drizzle' is present; 'kubernetes' is absent. Strict AND would return nothing;
    // OR-recall must still surface the record on the matching term (bm25 ranks it).
    const hits = store.search("drizzle kubernetes");
    const found = hits.filter((h) => h.topicKey === "decision/orm");
    assert.equal(found.length, 1, "OR-recall should return the record matching 'drizzle' even though 'kubernetes' is absent");
  } finally {
    cleanup(store, dir);
  }
});

// ---- (s1) porter stemming: stem query matches inflected content (EN recall) --

test("(s1) porter stemming: query 'search' matches content containing only 'searching'", () => {
  const { store, dir } = tmpStore();
  try {
    store.save({
      title: "Perf note",
      content: "The searching path was rebuilt for speed.",
      type: "bugfix",
      topicKey: "perf/note",
    });
    const hits = store.search("search");
    assert.equal(
      hits.some((h) => h.topicKey === "perf/note"),
      true,
      "porter stemmer should match the stem 'search' against the inflected 'searching'",
    );
  } finally {
    cleanup(store, dir);
  }
});

// ---- (s2) bilingual: ES content has no regression under porter ---------------

test("(s2) ES content is still found by its same form (porter is ES-symmetric)", () => {
  const { store, dir } = tmpStore();
  try {
    store.save({
      title: "Decisión de búsqueda",
      content: "Adoptamos búsqueda léxica con stemming para la memoria.",
      type: "decision",
      topicKey: "es/busqueda",
    });
    // Same form, accent-insensitive (remove_diacritics).
    assert.equal(
      store.search("busqueda").some((h) => h.topicKey === "es/busqueda"),
      true,
      "Spanish term must still be found by its same form (diacritics stripped)",
    );
    assert.equal(
      store.search("léxica").some((h) => h.topicKey === "es/busqueda"),
      true,
      "Spanish accented term must match its indexed form",
    );
  } finally {
    cleanup(store, dir);
  }
});

// ---- (s3) BM25 column weights: a title match outranks a content-only match ---

test("(s3) title-match outranks content-match for the same term (bm25 title weight)", () => {
  const { store, dir } = tmpStore();
  try {
    // A: term in CONTENT only. B: term in TITLE. Both saved; B should rank first.
    store.save({
      title: "General observation",
      content: "This note mentions kubernetes deep in the body text.",
      type: "manual",
      topicKey: "rank/content",
    });
    store.save({
      title: "Kubernetes deployment decision",
      content: "Unrelated body about scaling and rollouts.",
      type: "decision",
      topicKey: "rank/title",
    });
    const hits = store.search("kubernetes");
    const titleIdx = hits.findIndex((h) => h.topicKey === "rank/title");
    const contentIdx = hits.findIndex((h) => h.topicKey === "rank/content");
    assert.ok(titleIdx !== -1 && contentIdx !== -1, "both records must be returned");
    assert.ok(
      titleIdx < contentIdx,
      `title-match (idx ${titleIdx}) must rank above content-match (idx ${contentIdx})`,
    );
  } finally {
    cleanup(store, dir);
  }
});

// ---- (s4) phrase/proximity boost: adjacent terms rank above scattered --------

test("(s4) phrase boost ranks adjacent terms higher without dropping recall", () => {
  const { store, dir } = tmpStore();
  try {
    // A: the two query terms appear adjacent and in order.
    store.save({
      title: "Adjacent",
      content: "We hit a connection pool exhaustion under load.",
      type: "bugfix",
      topicKey: "phrase/adjacent",
    });
    // B: both terms present but scattered far apart (recall must still include it).
    store.save({
      title: "Scattered",
      content: "The connection was fine, but a separate worker pool starved later.",
      type: "bugfix",
      topicKey: "phrase/scattered",
    });
    const hits = store.search("connection pool");
    const adj = hits.findIndex((h) => h.topicKey === "phrase/adjacent");
    const sca = hits.findIndex((h) => h.topicKey === "phrase/scattered");
    assert.ok(adj !== -1 && sca !== -1, "phrase boost must NOT drop recall: both records returned");
    assert.ok(adj < sca, `adjacent (idx ${adj}) should rank above scattered (idx ${sca})`);
  } finally {
    cleanup(store, dir);
  }
});

// ---- (s5) phrase boost keeps sanitization safe on operator chars -------------

test("(s5) multi-token queries with FTS5 operator chars still do not throw", () => {
  const { store, dir } = tmpStore();
  try {
    store.save({
      title: "Auth bug fix",
      content: "Fixed authentication bug causing login failures.",
      type: "bugfix",
    });
    assert.doesNotThrow(() => store.search("auth (bug) login"));
    assert.doesNotThrow(() => store.search("fix AND login NEAR(x)"));
    assert.doesNotThrow(() => store.search('login "quoted" bug'));
    assert.equal(store.search("authentication login failures").length > 0, true);
  } finally {
    cleanup(store, dir);
  }
});

// ---- (g-new) mem_update — id-stable update, FTS, error cases ----------------

test("(g-new) update keeps id stable and new title is retrievable", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation } = store.save({
      title: "Original title",
      content: "Original content.",
      type: "manual",
    });
    const updated = store.update(observation.id, { title: "Updated title" });
    assert.equal(updated.id, observation.id, "id must stay stable after update");
    const fetched = store.get(observation.id);
    assert.ok(fetched, "get after update returned undefined");
    assert.equal(fetched.title, "Updated title", "new title must be retrievable");
  } finally {
    cleanup(store, dir);
  }
});

test("(h-new) update FTS: new content searchable, old content not", () => {
  const { store, dir } = tmpStore();
  try {
    // Disjoint tokens on purpose: the prefix-fallback retry would legitimately match
    // shared roots (zzqx… vs zzqx…), and this test is about FTS REINDEXING, not recall.
    const { observation } = store.save({
      title: "FTS update test",
      content: "alpha content zebrafoxtrot",
      type: "manual",
    });
    store.update(observation.id, { content: "beta concept quokkalima" });
    const betaHits = store.search("beta concept quokkalima");
    assert.ok(betaHits.some((h) => h.id === observation.id), "new content must be searchable via FTS");
    const alphaHits = store.search("zebrafoxtrot");
    assert.ok(!alphaHits.some((h) => h.id === observation.id), "old content must NOT match after update");
  } finally {
    cleanup(store, dir);
  }
});

test("(i-new) update unknown id throws", () => {
  const { store, dir } = tmpStore();
  try {
    assert.throws(
      () => store.update("99999", { title: "x" }),
      /no observation/i,
      "update with unknown id must throw matching /no observation/i",
    );
  } finally {
    cleanup(store, dir);
  }
});

test("(j-new) update superseded snapshot is rejected", () => {
  const { store, dir } = tmpStore();
  try {
    // After a topic_key upsert, the prior revision is stored as a NEW row with
    // superseded_by = live_id. The original live.id stays stable (live row).
    const { observation: live } = store.save({
      title: "A",
      content: "first content",
      type: "manual",
      topicKey: "test/superseded-check",
    });
    store.save({
      title: "A",
      content: "second content",
      type: "manual",
      topicKey: "test/superseded-check",
    });
    // Retrieve the snapshot id directly via the internal db handle.
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const snapshot = db
      .prepare("SELECT id FROM observations WHERE superseded_by=?")
      .get(live.id) as unknown as { id: string } | undefined;
    assert.ok(snapshot, "a superseded snapshot must exist after upsert");
    assert.throws(
      () => store.update(snapshot.id, { title: "tampered" }),
      /superseded/i,
      "update on superseded snapshot must throw matching /superseded/i",
    );
  } finally {
    cleanup(store, dir);
  }
});

test("(k-new) update idempotent: same field value → success, observation unchanged", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation } = store.save({
      title: "Idempotent title",
      content: "Some content.",
      type: "manual",
    });
    assert.doesNotThrow(() => store.update(observation.id, { title: "Idempotent title" }));
    const fetched = store.get(observation.id);
    assert.equal(fetched!.title, "Idempotent title");
  } finally {
    cleanup(store, dir);
  }
});

// ---- (l-new) mem_session_start — startSession tests -------------------------

test("(l-new) startSession returns non-empty session id and sets active session", () => {
  const { store, dir } = tmpStore();
  try {
    const session = store.startSession("my session");
    assert.ok(session.id && session.id.length > 0, "session id must be non-empty");
  } finally {
    cleanup(store, dir);
  }
});

test("(m-new) mem_save after startSession links observation to that session", () => {
  const { store, dir } = tmpStore();
  try {
    const session = store.startSession("linking session");
    const { observation } = store.save({
      title: "Linked obs",
      content: "Should be linked to the active session.",
      type: "manual",
    });
    assert.equal(observation.sessionId, session.id, "saved observation must be linked to active session");
  } finally {
    cleanup(store, dir);
  }
});

test("(n-new) startSession optional params: empty call returns valid id, defaults to project scope", () => {
  const { store, dir } = tmpStore();
  try {
    const session = store.startSession();
    assert.ok(session.id && session.id.length > 0, "session id must be non-empty with no params");
    assert.equal(session.scope, "project", "default scope must be 'project'");
  } finally {
    cleanup(store, dir);
  }
});

// ---- (o-new through r-new) mem_suggest_topic_key — suggestTopicKeyWithMatches ----

test("(o-new) suggestTopicKeyWithMatches returns kebab suggestion in type/slug shape", () => {
  const { store, dir } = tmpStore();
  try {
    const result = store.suggestTopicKeyWithMatches("Fixed Auth Token Rotation", "bugfix");
    assert.equal(result.suggestion, "bugfix/fixed-auth-token-rotation");
  } finally {
    cleanup(store, dir);
  }
});

test("(p-new) suggestTopicKeyWithMatches surfaces near-match for existing key", () => {
  const { store, dir } = tmpStore();
  try {
    store.save({
      title: "Auth Model",
      content: "Architecture of the auth model.",
      type: "architecture",
      topicKey: "architecture/auth-model",
    });
    const result = store.suggestTopicKeyWithMatches("Auth Model Design", "architecture");
    assert.ok(
      result.nearMatches.includes("architecture/auth-model"),
      `expected 'architecture/auth-model' in nearMatches, got: ${JSON.stringify(result.nearMatches)}`,
    );
  } finally {
    cleanup(store, dir);
  }
});

test("(q-new) suggestTopicKeyWithMatches deterministic: same inputs produce same suggestion twice", () => {
  const { store, dir } = tmpStore();
  try {
    const r1 = store.suggestTopicKeyWithMatches("JWT middleware", "pattern");
    const r2 = store.suggestTopicKeyWithMatches("JWT middleware", "pattern");
    assert.equal(r1.suggestion, r2.suggestion, "suggestion must be deterministic");
  } finally {
    cleanup(store, dir);
  }
});

test("(r-new) suggestTopicKeyWithMatches read-only: no observation created", () => {
  const { store, dir } = tmpStore();
  try {
    const before = store.recentContext({ limit: 100 });
    store.suggestTopicKeyWithMatches("Some Title", "decision");
    const after = store.recentContext({ limit: 100 });
    assert.equal(after.observations.length, before.observations.length, "suggest must not create any observation");
  } finally {
    cleanup(store, dir);
  }
});

// ---- (h) anchors resolve to real graph node ids + anchor_file ----------------

test("(h) anchors resolve to real node ids with anchor_file; unresolved keep the label", () => {
  const dir = join(tmpdir(), `cg-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  // Fake graph resolver: only "UserService" exists; "GhostSymbol" resolves to nothing.
  const resolver = (label: string) =>
    label === "UserService"
      ? [{ nodeId: "src_user_ts:userservice", sourceFile: "src/user.ts" }]
      : [];
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolver);
  try {
    const { observation } = store.save({
      title: "UserService caches sessions",
      content: "Decision: UserService owns the session cache.",
      type: "decision",
      anchors: ["UserService", "GhostSymbol"],
    });

    // Resolved anchor: stored under the REAL composite node id, anchor_file populated.
    const onReal = store.anchorsForNode("src_user_ts:userservice");
    assert.equal(onReal.length, 1, "resolved anchor should be retrievable by real node id");
    assert.equal(onReal[0]!.observationId, observation.id);
    assert.equal(onReal[0]!.anchorLabel, "UserService");
    assert.equal(onReal[0]!.anchorFile, "src/user.ts", "anchor_file must be populated for resolved anchors");

    // Unresolved anchor: kept under the raw label, no anchor_file (visible as unverified).
    const onGhost = store.anchorsForNode("GhostSymbol");
    assert.equal(onGhost.length, 1, "unresolved anchor must still be stored under its raw label");
    assert.equal(onGhost[0]!.observationId, observation.id);
    assert.equal(onGhost[0]!.anchorFile, undefined, "unresolved anchor has no anchor_file");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- recentAnchoredObservations: ordered/limited "latest memories" for a node ----

test("(recent-1) recentAnchoredObservations: newest first, respects limit", () => {
  const dir = join(tmpdir(), `cg-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "memory.db");
  const resolver = () => [{ nodeId: "n1", sourceFile: "src/a.ts" }];
  const store = new MemoryStore(dbPath, "test_project", resolver);
  try {
    const first = store.save({
      title: "First note", content: "oldest", type: "architecture", anchors: ["Anything"],
    });
    const second = store.save({
      title: "Second note", content: "middle", type: "architecture", anchors: ["Anything"],
    });
    const third = store.save({
      title: "Third note", content: "newest", type: "architecture", anchors: ["Anything"],
    });

    // Stamp deterministic, well-spaced updated_at values directly (same-millisecond
    // saves in a fast test run would otherwise make ORDER BY updated_at DESC a coin flip).
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare("UPDATE observations SET updated_at=? WHERE id=?").run(1000, first.observation.id);
      raw.prepare("UPDATE observations SET updated_at=? WHERE id=?").run(2000, second.observation.id);
      raw.prepare("UPDATE observations SET updated_at=? WHERE id=?").run(3000, third.observation.id);
    } finally {
      raw.close();
    }

    const all = store.recentAnchoredObservations("n1", 10);
    assert.deepEqual(
      all.map((a) => a.observationId),
      [third.observation.id, second.observation.id, first.observation.id],
      "most recently updated observation first",
    );
    assert.equal(all[0]!.updatedAt, 3000);

    const limited = store.recentAnchoredObservations("n1", 2);
    assert.deepEqual(
      limited.map((a) => a.observationId),
      [third.observation.id, second.observation.id],
      "limit caps the returned rows to the N most recent",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(recent-2) recentAnchoredObservations: unknown node id returns empty", () => {
  const { store, dir } = tmpStore();
  try {
    assert.deepEqual(store.recentAnchoredObservations("nope", 10), []);
  } finally {
    cleanup(store, dir);
  }
});

test("(recent-3) recentAnchoredObservations: superseded observations are excluded", () => {
  const dir = join(tmpdir(), `cg-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const resolver = () => [{ nodeId: "n1", sourceFile: "src/a.ts" }];
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolver);
  try {
    store.save({
      title: "Cache policy",
      content: "v1",
      type: "decision",
      topicKey: "cache/policy",
      anchors: ["Anything"],
    });
    const { observation: latest } = store.save({
      title: "Cache policy",
      content: "v2",
      type: "decision",
      topicKey: "cache/policy",
      anchors: ["Anything"],
    });

    const recent = store.recentAnchoredObservations("n1", 10);
    assert.equal(recent.length, 1, "only the live (non-superseded) revision is returned");
    assert.equal(recent[0]!.observationId, latest.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- addAnchorsIfMissing: additive, idempotent anchor insert (reanchor's write path) ----

test("(add-anchor-1) addAnchorsIfMissing: inserts new anchors and returns the inserted count", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation } = store.save({ title: "T", content: "C", type: "architecture" });
    const inserted = store.addAnchorsIfMissing(observation.id, [
      { nodeId: "n1", anchorLabel: "foo", anchorFile: "src/foo.ts", anchorHash: "h1" },
      { nodeId: "n2", anchorLabel: "bar", anchorFile: "src/bar.ts" },
    ]);
    assert.equal(inserted, 2);

    const anchors = store.anchorsForObservation(observation.id);
    assert.equal(anchors.length, 2);
    const byNode = new Map(anchors.map((a) => [a.nodeId, a]));
    assert.equal(byNode.get("n1")!.anchorFile, "src/foo.ts");
    assert.equal(byNode.get("n1")!.anchorHash, "h1");
    assert.equal(byNode.get("n2")!.anchorFile, "src/bar.ts");
  } finally {
    cleanup(store, dir);
  }
});

test("(add-anchor-2) addAnchorsIfMissing: re-running with the same anchors mints nothing new (idempotent)", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation } = store.save({ title: "T", content: "C", type: "architecture" });
    const first = store.addAnchorsIfMissing(observation.id, [{ nodeId: "n1", anchorLabel: "foo" }]);
    assert.equal(first, 1);
    const second = store.addAnchorsIfMissing(observation.id, [{ nodeId: "n1", anchorLabel: "foo" }]);
    assert.equal(second, 0, "re-inserting the same (observation_id, node_id, role) must be a no-op");
    assert.equal(store.anchorsForObservation(observation.id).length, 1, "no duplicate row created");
  } finally {
    cleanup(store, dir);
  }
});

test("(add-anchor-3) addAnchorsIfMissing: unions onto anchors an observation already has", () => {
  const dir = join(tmpdir(), `cg-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const resolver = () => [{ nodeId: "n1", sourceFile: "src/a.ts" }];
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolver);
  try {
    const { observation } = store.save({
      title: "T", content: "C", type: "architecture", anchors: ["Anything"],
    });
    assert.equal(store.anchorsForObservation(observation.id).length, 1, "starts with one anchor");
    const inserted = store.addAnchorsIfMissing(observation.id, [{ nodeId: "n2", anchorLabel: "bar" }]);
    assert.equal(inserted, 1);
    const anchors = store.anchorsForObservation(observation.id);
    assert.equal(anchors.length, 2, "new anchor is UNIONED, existing one is preserved (not replaced)");
    assert.ok(anchors.some((a) => a.nodeId === "n1"));
    assert.ok(anchors.some((a) => a.nodeId === "n2"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- batch store unit tests -------------------------------------------------

// (batch-1) saveBatch non-atomic — 3 items all succeed
test("(batch-1) saveBatch non-atomic: 3 items all succeed, results in order", () => {
  const { store, dir } = tmpStore();
  try {
    const results = store.saveBatch([
      { title: "Batch One", content: "Content 1", type: "decision", scope: "project" },
      { title: "Batch Two", content: "Content 2", type: "manual", scope: "project" },
      { title: "Batch Three", content: "Content 3", type: "architecture", scope: "project" },
    ]);
    assert.equal(results.length, 3, "must return 3 results");
    for (let i = 0; i < 3; i++) {
      const r = results[i]!;
      assert.ok(r.ok, `result[${i}] must be ok: ${JSON.stringify(r)}`);
      if (r.ok) {
        assert.ok(r.data.observation.id, `result[${i}] must have an id`);
      }
    }
    // Verify all 3 committed
    const r0 = results[0]!;
    if (r0.ok) {
      const obs = store.get(r0.data.observation.id);
      assert.ok(obs, "result[0] must be in DB");
    }
  } finally {
    cleanup(store, dir);
  }
});

// (batch-2) saveBatch atomic — all succeed, committed
test("(batch-2) saveBatch atomic: all succeed → committed atomically", () => {
  const { store, dir } = tmpStore();
  try {
    const results = store.saveBatch(
      [
        { title: "Atomic A", content: "CA", type: "decision", scope: "project" },
        { title: "Atomic B", content: "CB", type: "manual", scope: "project" },
      ],
      { atomic: true },
    );
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.ok(r.ok, `All results must be ok: ${JSON.stringify(r)}`);
    }
    // Both must be in DB
    const r0 = results[0]!;
    const r1 = results[1]!;
    if (r0.ok && r1.ok) {
      assert.ok(store.get(r0.data.observation.id), "Atomic A must be in DB");
      assert.ok(store.get(r1.data.observation.id), "Atomic B must be in DB");
    }
  } finally {
    cleanup(store, dir);
  }
});

// (batch-3) updateBatch non-atomic — 2 succeed, 1 fails with bad id
test("(batch-3) updateBatch non-atomic: [0] ok, [1] fail, [2] ok", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation: obs } = store.save({ title: "Original", content: "orig", type: "manual", scope: "project" });
    const results = store.updateBatch([
      { id: obs.id, fields: { title: "Updated 0" } },
      { id: "does-not-exist", fields: { title: "Fail" } },
      { id: obs.id, fields: { title: "Updated 2" } },
    ]);
    assert.equal(results.length, 3);
    assert.ok(results[0]!.ok, `[0] must succeed: ${JSON.stringify(results[0])}`);
    assert.ok(!results[1]!.ok, `[1] must fail: ${JSON.stringify(results[1])}`);
    assert.ok(results[2]!.ok, `[2] must succeed: ${JSON.stringify(results[2])}`);
    // Items 0 and 2 committed independently — no "rolled-back" in non-atomic
    if (!results[1]!.ok) {
      assert.ok((results[1]!).error !== "rolled-back",
        `Non-atomic failure must not say 'rolled-back'`);
    }
  } finally {
    cleanup(store, dir);
  }
});

// (batch-4) updateBatch atomic — failure at [1] rolls back [0], marks [2] rolled-back
test("(batch-4) updateBatch atomic: failure at [1] → [0] rolled-back, [1] real error, [2] rolled-back", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation: obs } = store.save({ title: "Pre-existing", content: "pre", type: "manual", scope: "project" });
    const results = store.updateBatch(
      [
        { id: obs.id, fields: { title: "Will rollback" } },
        { id: "bad-id-xyz", fields: { title: "Fail" } },
        { id: obs.id, fields: { title: "Never runs" } },
      ],
      { atomic: true },
    );
    assert.equal(results.length, 3);
    // [0] was committed then rolled back
    assert.ok(!results[0]!.ok, `[0] must be error (rolled-back): ${JSON.stringify(results[0])}`);
    if (!results[0]!.ok) {
      assert.equal((results[0]!).error, "rolled-back",
        `[0] error must be exactly "rolled-back"`);
    }
    // [1] must have real error (not "rolled-back")
    assert.ok(!results[1]!.ok, `[1] must be error: ${JSON.stringify(results[1])}`);
    if (!results[1]!.ok) {
      const err = (results[1]!).error;
      assert.ok(err !== "rolled-back", `[1] error must NOT be 'rolled-back', got: ${err}`);
      assert.ok(err.includes("bad-id-xyz") || err.includes("no observation"),
        `[1] error must mention the bad id: ${err}`);
    }
    // [2] was never attempted
    assert.ok(!results[2]!.ok, `[2] must be error (rolled-back): ${JSON.stringify(results[2])}`);
    if (!results[2]!.ok) {
      assert.equal((results[2]!).error, "rolled-back",
        `[2] error must be exactly "rolled-back"`);
    }
    // DB-level: observation must still have original title (rollback worked)
    const reloaded = store.get(obs.id);
    assert.equal(reloaded?.title, "Pre-existing", "Atomic rollback must undo [0]'s write");
  } finally {
    cleanup(store, dir);
  }
});

// (batch-5) getBatch — mix of found and not-found
test("(batch-5) getBatch: found id ok, unknown id error 'not found'", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation } = store.save({ title: "Known", content: "k", type: "manual", scope: "project" });
    const results = store.getBatch([observation.id, "unknown-id-xyz", observation.id]);
    assert.equal(results.length, 3);
    assert.ok(results[0]!.ok, `[0] must be ok: ${JSON.stringify(results[0])}`);
    assert.ok(!results[1]!.ok, `[1] must fail: ${JSON.stringify(results[1])}`);
    if (!results[1]!.ok) {
      assert.equal((results[1]!).error, "not found");
    }
    assert.ok(results[2]!.ok, `[2] must be ok (duplicate id still returned): ${JSON.stringify(results[2])}`);
  } finally {
    cleanup(store, dir);
  }
});

// (batch-6) rolled-back string exact wording
test("(batch-6) rolled-back error string is exactly 'rolled-back' (spec-locked wording)", () => {
  const { store, dir } = tmpStore();
  try {
    const { observation } = store.save({ title: "Target", content: "t", type: "manual", scope: "project" });
    const results = store.updateBatch(
      [
        { id: observation.id, fields: { title: "X" } }, // succeeds, then rolled back
        { id: "nonexistent", fields: { title: "Fail" } }, // triggers rollback
      ],
      { atomic: true },
    );
    const r0 = results[0]!;
    assert.ok(!r0.ok, "[0] must be error");
    if (!r0.ok) {
      assert.equal(r0.error, "rolled-back", `Spec-locked wording must be 'rolled-back', got: '${r0.error}'`);
    }
  } finally {
    cleanup(store, dir);
  }
});
