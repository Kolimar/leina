// Slice 1 — Memory Drift Detector + get_verified_context — node:test suite
// Run: node --no-warnings --experimental-strip-types --test test/drift.test.ts
// Also picked up by: npm test (glob test/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteMemoryRepository as MemoryStore } from "../src/infrastructure/sqlite/memory-repository.ts";
import type { AnchorResolver } from "../src/infrastructure/sqlite/memory-repository.ts";
import {
  deriveAnchorState,
  deriveMemoryState,
  getVerifiedContext,
  latestMemoriesForNode,
  verdictOf,
} from "../src/application/memory/query.ts";
import type { NodeVerifier } from "../src/application/memory/query.ts";
import { ensureMemorySchema, MEMORY_SCHEMA_VERSION, LIKE_DDL } from "../src/infrastructure/sqlite/schema.ts";

// ---- helpers ----------------------------------------------------------------

function tmpDir(): string {
  const dir = join(tmpdir(), `cg-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Fake resolver: "UserService" resolves to a real node carrying a save-time file hash.
// Anything else is unresolved (graph knows nothing about it).
function resolverWithHash(hash: string): AnchorResolver {
  return (label: string) =>
    label === "UserService"
      ? [{ nodeId: "src_user_ts:userservice", sourceFile: "src/user.ts", anchorHash: hash }]
      : [];
}

const NODE_ID = "src_user_ts:userservice";

// ---- (drift-a) anchor_hash is stamped at save time --------------------------

test("(drift-a) resolved anchor stores the save-time file hash", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    const { observation } = store.save({
      title: "UserService caches sessions",
      content: "drifttoken UserService owns the session cache.",
      type: "architecture",
      anchors: ["UserService"],
    });

    const anchors = store.anchorsForObservation(observation.id);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.nodeId, NODE_ID);
    assert.equal(anchors[0]!.anchorFile, "src/user.ts");
    assert.equal(anchors[0]!.anchorHash, "H1", "anchor_hash must be stamped from the resolver");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

);

// ---- (drift-b) active: node exists and hash matches → usable ----------------

test("(drift-b) descriptive + hash match → active → usable", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "UserService caches sessions",
      content: "drifttoken UserService owns the session cache.",
      type: "architecture",
      anchors: ["UserService"],
    });
    const verify: NodeVerifier = () => ({ exists: true, currentHash: "H1" });
    const ctx = getVerifiedContext(store, "drifttoken", verify);

    assert.equal(ctx.usable.length, 1, "active memory should be usable");
    assert.equal(ctx.warning.length, 0);
    assert.equal(ctx.doNotUse.length, 0);
    assert.equal(ctx.usable[0]!.state, "active");
    assert.equal(ctx.usable[0]!.nature, "descriptive");
    assert.equal(ctx.usable[0]!.checkViolation, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (drift-c) stale descriptive → warning ----------------------------------

test("(drift-c) descriptive + hash changed → stale → warning", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "UserService caches sessions",
      content: "drifttoken UserService owns the session cache.",
      type: "architecture",
      anchors: ["UserService"],
    });
    const verify: NodeVerifier = () => ({ exists: true, currentHash: "H2" });
    const ctx = getVerifiedContext(store, "drifttoken", verify);

    assert.equal(ctx.warning.length, 1, "stale descriptive memory should warn");
    assert.equal(ctx.usable.length, 0);
    assert.equal(ctx.warning[0]!.state, "stale");
    assert.equal(ctx.warning[0]!.checkViolation, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (drift-d) contradicted descriptive → do_not_use ------------------------

test("(drift-d) descriptive + node gone → contradicted → do_not_use", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "UserService caches sessions",
      content: "drifttoken UserService owns the session cache.",
      type: "architecture",
      anchors: ["UserService"],
    });
    const verify: NodeVerifier = () => ({ exists: false, currentHash: null });
    const ctx = getVerifiedContext(store, "drifttoken", verify);

    assert.equal(ctx.doNotUse.length, 1, "contradicted descriptive memory must not be used");
    assert.equal(ctx.doNotUse[0]!.state, "contradicted");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (drift-e) normative stale → warning + checkViolation -------------------

test("(drift-e) normative + hash changed → warning + checkViolation (never blindly usable)", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "Always validate input in UserService",
      content: "drifttoken every public method must validate its input.",
      type: "decision", // normative
      anchors: ["UserService"],
    });
    const verify: NodeVerifier = () => ({ exists: true, currentHash: "H2" });
    const ctx = getVerifiedContext(store, "drifttoken", verify);

    assert.equal(ctx.usable.length, 0, "a rule whose code changed is not served as usable");
    assert.equal(ctx.doNotUse.length, 0, "normative memory is never discarded by drift");
    assert.equal(ctx.warning.length, 1);
    assert.equal(ctx.warning[0]!.nature, "normative");
    assert.equal(ctx.warning[0]!.state, "stale");
    assert.equal(ctx.warning[0]!.checkViolation, true, "drifted normative memory flags a violation check");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (drift-f) normative contradicted → warning + checkViolation ------------

test("(drift-f) normative + node gone → warning + checkViolation (not do_not_use)", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "Prefer composition over inheritance",
      content: "drifttoken team rule: composition first.",
      type: "preference", // normative
      anchors: ["UserService"],
    });
    const verify: NodeVerifier = () => ({ exists: false, currentHash: null });
    const ctx = getVerifiedContext(store, "drifttoken", verify);

    assert.equal(ctx.doNotUse.length, 0, "normative memory must not be discarded by drift");
    assert.equal(ctx.warning.length, 1);
    assert.equal(ctx.warning[0]!.state, "contradicted");
    assert.equal(ctx.warning[0]!.checkViolation, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (drift-g) unresolved anchor → unverified → warning ---------------------

test("(drift-g) unresolved anchor → unverified → warning", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "Ghost note",
      content: "drifttoken something about a symbol the graph never had.",
      type: "architecture",
      anchors: ["GhostSymbol"],
    });
    // verify would say "gone" for the raw label, but unresolved anchors must NOT
    // be derived as contradicted — they are unverified (never linked to the graph).
    const verify: NodeVerifier = () => ({ exists: false, currentHash: null });
    const ctx = getVerifiedContext(store, "drifttoken", verify);

    assert.equal(ctx.warning.length, 1);
    assert.equal(ctx.warning[0]!.state, "unverified");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (drift-h) no anchors → unverified --------------------------------------

test("(drift-h) memory with no anchors → unverified → warning", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "Free-floating note",
      content: "drifttoken no anchors here at all.",
      type: "discovery",
    });
    const verify: NodeVerifier = () => ({ exists: true, currentHash: "H1" });
    const ctx = getVerifiedContext(store, "drifttoken", verify);

    assert.equal(ctx.warning.length, 1);
    assert.equal(ctx.warning[0]!.state, "unverified");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (drift-i) graph unavailable → unverified (NOT contradicted) ------------

test("(drift-i) verifier graph error → unverified + graphError, never contradicted", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "UserService caches sessions",
      content: "drifttoken UserService owns the session cache.",
      type: "architecture",
      anchors: ["UserService"],
    });
    // The graph couldn't be read: exists is reported false but with an error. This must
    // NOT become `contradicted` (that would falsely claim the node is gone) — it is
    // unverified, with the cause surfaced so the caller knows verification was degraded.
    const verify: NodeVerifier = () => ({
      exists: false,
      currentHash: null,
      error: "No graph found at .leina/graph.db. Run: leina build <dir> first.",
    });
    const ctx = getVerifiedContext(store, "drifttoken", verify);

    assert.equal(ctx.doNotUse.length, 0, "graph error must not contradict the memory");
    assert.equal(ctx.warning.length, 1);
    assert.equal(ctx.warning[0]!.state, "unverified");
    assert.match(ctx.warning[0]!.reason, /graph unavailable/, "reason must name the graph-read failure");
    assert.ok(ctx.graphError, "top-level graphError must be set so the tool can flag degraded verification");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- latestMemoriesForNode — "recent memories" composition for a graph node ------

test("(latest-a) latestMemoriesForNode: composes recentAnchoredObservations + drift badge", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "UserService caches sessions",
      content: "UserService owns the session cache.",
      type: "architecture",
      anchors: ["UserService"],
    });
    const verify: NodeVerifier = () => ({ exists: true, currentHash: "H1" });
    const items = latestMemoriesForNode(store, NODE_ID, verify, 10);

    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, "UserService caches sessions");
    assert.equal(items[0]!.content, "UserService owns the session cache.");
    assert.equal(items[0]!.anchorLabel, "UserService");
    assert.equal(items[0]!.state, "active");
    assert.equal(items[0]!.verdict, "usable");
    assert.equal(items[0]!.nature, "descriptive");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(latest-b) latestMemoriesForNode: node with no anchors → empty array, not an error", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "Free-floating note",
      content: "no anchors at all",
      type: "discovery",
    });
    const verify: NodeVerifier = () => ({ exists: true, currentHash: "H1" });
    assert.deepEqual(latestMemoriesForNode(store, NODE_ID, verify, 10), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(latest-c) latestMemoriesForNode: drifted anchor surfaces a warning badge", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    store.save({
      title: "UserService caches sessions",
      content: "UserService owns the session cache.",
      type: "architecture",
      anchors: ["UserService"],
    });
    // Current file hash differs from the save-time hash → stale.
    const verify: NodeVerifier = () => ({ exists: true, currentHash: "H2" });
    const items = latestMemoriesForNode(store, NODE_ID, verify, 10);

    assert.equal(items.length, 1);
    assert.equal(items[0]!.state, "stale");
    assert.equal(items[0]!.verdict, "warning");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(latest-d) latestMemoriesForNode: limit is forwarded to the underlying query", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    for (let i = 0; i < 5; i++) {
      store.save({
        title: `Note ${i}`,
        content: `content ${i}`,
        type: "architecture",
        anchors: ["UserService"],
      });
    }
    const verify: NodeVerifier = () => ({ exists: true, currentHash: "H1" });
    const items = latestMemoriesForNode(store, NODE_ID, verify, 2);
    assert.equal(items.length, 2, "limit caps the number of composed items");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (super-a) topic upsert: stable live id + snapshot carrying superseded_by

test("(super-a) topic upsert keeps a stable live id and snapshots the old revision", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");
  const store = new MemoryStore(dbPath, "test_project");
  try {
    const { observation: first } = store.save({
      title: "Auth strategy",
      content: "Using JWT for stateless auth.",
      type: "decision",
      topicKey: "auth/strategy",
    });
    const { observation: second, evolved } = store.save({
      title: "Auth strategy",
      content: "Switched to opaque tokens stored server-side.",
      type: "decision",
      topicKey: "auth/strategy",
    });

    // Live row keeps the same id (durable references) and bumps the revision.
    assert.equal(evolved, true);
    assert.equal(second.id, first.id, "live row id must stay stable across upsert");
    assert.equal(second.revision, 2);
    assert.equal(second.supersededBy, undefined, "live row is not superseded");

    // Search only surfaces the live revision.
    const jwtHits = store.search("JWT").filter((h) => h.topicKey === "auth/strategy");
    assert.equal(jwtHits.length, 0, "old content must not surface in search (snapshot is superseded)");
    const liveHits = store.search("opaque").filter((h) => h.topicKey === "auth/strategy");
    assert.equal(liveHits.length, 1);

    // White-box: a snapshot row exists carrying superseded_by → live id, with the old content.
    const raw = new DatabaseSync(dbPath);
    try {
      const snaps = raw
        .prepare("SELECT id, content, topic_key, superseded_by FROM observations WHERE superseded_by IS NOT NULL")
        .all() as unknown as { id: string; content: string; topic_key: string | null; superseded_by: string }[];
      assert.equal(snaps.length, 1, "exactly one snapshot row should exist");
      assert.equal(snaps[0]!.superseded_by, first.id, "snapshot must point at the live id");
      assert.ok(snaps[0]!.content.includes("JWT"), "snapshot must hold the old content");
      assert.notEqual(snaps[0]!.id, first.id, "snapshot has its own id");
    } finally {
      raw.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (super-b) get(snapshotId) exposes supersededBy -------------------------

test("(super-b) a superseded snapshot is excluded from search but retrievable by id", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");
  const store = new MemoryStore(dbPath, "test_project");
  try {
    const { observation: first } = store.save({
      title: "Cache policy",
      content: "supertoken first revision content.",
      type: "config",
      topicKey: "config/cache",
    });
    store.save({
      title: "Cache policy",
      content: "supertoken second revision content.",
      type: "config",
      topicKey: "config/cache",
    });

    const raw = new DatabaseSync(dbPath);
    let snapId: string;
    try {
      const row = raw
        .prepare("SELECT id FROM observations WHERE superseded_by IS NOT NULL")
        .get() as unknown as { id: string };
      snapId = row.id;
    } finally {
      raw.close();
    }

    const snap = store.get(snapId);
    assert.ok(snap, "snapshot must be retrievable by id");
    assert.equal(snap.supersededBy, first.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (super-c) re-save with a different anchor set replaces the live anchors -

test("(super-c) topic re-save with a different anchor set replaces the live row's anchors", () => {
  const dir = tmpDir();
  const resolver: AnchorResolver = (label) => {
    if (label === "UserService") return [{ nodeId: "n_user", sourceFile: "src/user.ts", anchorHash: "H1" }];
    if (label === "TokenStore") return [{ nodeId: "n_token", sourceFile: "src/token.ts", anchorHash: "H2" }];
    return [];
  };
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolver);
  try {
    const { observation: first } = store.save({
      title: "Auth ownership",
      content: "v1: UserService owns it.",
      type: "decision",
      topicKey: "auth/owner",
      anchors: ["UserService"],
    });
    store.save({
      title: "Auth ownership",
      content: "v2: TokenStore owns it now.",
      type: "decision",
      topicKey: "auth/owner",
      anchors: ["TokenStore"],
    });

    // The live row must reflect ONLY the latest anchor set — stale anchors from the
    // previous revision must not linger and poison the drift verdict.
    const live = store.anchorsForObservation(first.id);
    const ids = live.map((a) => a.nodeId).sort();
    assert.deepEqual(ids, ["n_token"], "live row must carry only the latest anchor set");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (fts-a) superseded snapshots are NOT in the FTS index ------------------

test("(fts-a) topic upsert leaves the old revision OUT of the FTS index", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");
  const store = new MemoryStore(dbPath, "test_project");
  try {
    store.save({
      title: "Cache policy",
      content: "alphaonly first revision",
      type: "config",
      topicKey: "config/cache",
    });
    store.save({
      title: "Cache policy",
      content: "betaonly second revision",
      type: "config",
      topicKey: "config/cache",
    });

    // 'alphaonly' lives only in the superseded snapshot. If snapshots were still indexed
    // it would match here and be bm25-scored before the superseded_by filter discards it.
    // The guarded obs_ai trigger keeps snapshots out of obs_fts entirely.
    const raw = new DatabaseSync(dbPath);
    try {
      const snapHits = raw.prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH 'alphaonly'").all();
      assert.equal(snapHits.length, 0, "superseded snapshot content must NOT be in the FTS index");
      const liveHits = raw.prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH 'betaonly'").all();
      assert.equal(liveHits.length, 1, "the live revision stays indexed");
    } finally {
      raw.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (mig-b) v2 → v3 migration purges already-indexed snapshots from FTS -----

test("(mig-b) ensureMemorySchema purges superseded snapshots from the FTS index on v2→v3", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");

  // Hand-craft a v2 db with the OLD UNGUARDED triggers (index every row) plus a live row
  // and a superseded snapshot — under the old triggers the snapshot is indexed too.
  const v2 = new DatabaseSync(dbPath);
  v2.exec(`
    CREATE TABLE observations (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
      type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      topic_key TEXT, session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      superseded_by TEXT
    );
    CREATE UNIQUE INDEX uq_obs_topic ON observations(project_key, scope, topic_key)
      WHERE topic_key IS NOT NULL AND superseded_by IS NULL;
    CREATE VIRTUAL TABLE obs_fts USING fts5(
      title, content, content='observations', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER obs_ai AFTER INSERT ON observations BEGIN
      INSERT INTO obs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
    END;
    CREATE TRIGGER obs_ad AFTER DELETE ON observations BEGIN
      INSERT INTO obs_fts(obs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
    END;
    CREATE TRIGGER obs_au AFTER UPDATE ON observations BEGIN
      INSERT INTO obs_fts(obs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
      INSERT INTO obs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
    END;
    CREATE TABLE memory_anchors (
      observation_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'about',
      anchor_label TEXT, anchor_file TEXT, anchor_hash TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (observation_id, node_id, role)
    );
    INSERT INTO observations (id, project_key, scope, type, title, content, topic_key, created_at, updated_at, revision, superseded_by)
      VALUES ('live1', 'test_project', 'project', 'config', 'Cache policy', 'betaonly live', 'config/cache', 1, 2, 2, NULL);
    INSERT INTO observations (id, project_key, scope, type, title, content, topic_key, created_at, updated_at, revision, superseded_by)
      VALUES ('snap1', 'test_project', 'project', 'config', 'Cache policy', 'alphaonly snapshot', 'config/cache', 1, 1, 1, 'live1');
    PRAGMA user_version = 2;
  `);
  const before = v2.prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH 'alphaonly'").all();
  v2.close();
  assert.equal(before.length, 1, "precondition: old unguarded triggers indexed the snapshot");

  const db = new DatabaseSync(dbPath);
  try {
    ensureMemorySchema(db);

    const version = (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
    assert.equal(version, MEMORY_SCHEMA_VERSION, "must reach the current schema version");

    const snapHits = db.prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH 'alphaonly'").all();
    assert.equal(snapHits.length, 0, "migration must keep the snapshot out of the FTS index");
    const liveHits = db.prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH 'betaonly'").all();
    assert.equal(liveHits.length, 1, "the live row stays indexed");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (mig-c) v3 → v4 migration: porter tokenizer + live-only reindex ---------

test("(mig-c) ensureMemorySchema switches obs_fts to the porter tokenizer on v3→v4", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");

  // Hand-craft a v3 db: the GUARDED triggers, the OLD unicode61 (non-stemming) tokenizer,
  // a live row whose content carries an inflected form ("searching") and a superseded
  // snapshot. Under unicode61, querying the stem "search" must NOT match — that is the
  // pre-migration baseline the v4 migration is expected to fix.
  const v3 = new DatabaseSync(dbPath);
  v3.exec(`
    CREATE TABLE observations (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
      type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      topic_key TEXT, session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      superseded_by TEXT
    );
    CREATE UNIQUE INDEX uq_obs_topic ON observations(project_key, scope, topic_key)
      WHERE topic_key IS NOT NULL AND superseded_by IS NULL;
    CREATE VIRTUAL TABLE obs_fts USING fts5(
      title, content, content='observations', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER obs_ai AFTER INSERT ON observations WHEN new.superseded_by IS NULL BEGIN
      INSERT INTO obs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
    END;
    CREATE TABLE memory_anchors (
      observation_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'about',
      anchor_label TEXT, anchor_file TEXT, anchor_hash TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (observation_id, node_id, role)
    );
    INSERT INTO observations (id, project_key, scope, type, title, content, topic_key, created_at, updated_at, revision, superseded_by)
      VALUES ('live1', 'test_project', 'project', 'bugfix', 'Query tuning', 'the searching path was slow', 'perf/search', 1, 2, 2, NULL);
    INSERT INTO observations (id, project_key, scope, type, title, content, topic_key, created_at, updated_at, revision, superseded_by)
      VALUES ('snap1', 'test_project', 'project', 'bugfix', 'Query tuning', 'snapshotonly old body', 'perf/search', 1, 1, 1, 'live1');
    PRAGMA user_version = 3;
  `);
  // Precondition: unicode61 does NOT stem, so the stem "search" misses "searching".
  const beforeStem = v3.prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH 'search'").all();
  assert.equal(beforeStem.length, 0, "precondition: unicode61 tokenizer does not stem 'searching'→'search'");
  v3.close();

  const db = new DatabaseSync(dbPath);
  try {
    ensureMemorySchema(db);

    const version = (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
    assert.equal(version, MEMORY_SCHEMA_VERSION, "must reach current schema version");

    // Porter stemming now matches the stem against the inflected form.
    const stemHits = db.prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH 'search'").all();
    assert.equal(stemHits.length, 1, "v4 porter tokenizer must match stem 'search' against 'searching'");

    // Live row reindexed; superseded snapshot stays out of the index.
    const liveHits = db.prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH 'path'").all();
    assert.equal(liveHits.length, 1, "the live row is reindexed under the new tokenizer");
    const snapHits = db.prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH 'snapshotonly'").all();
    assert.equal(snapHits.length, 0, "the superseded snapshot must NOT be reindexed");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (mig-a) v1 → v2 migration: adds anchor_hash, preserves data ------------

test("(mig-a) ensureMemorySchema migrates a v1 db to v2 without data loss", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");

  // Hand-craft a v1-shaped db (no anchor_hash column, old full unique index).
  const v1 = new DatabaseSync(dbPath);
  v1.exec(`
    CREATE TABLE observations (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
      type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      topic_key TEXT, session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      superseded_by TEXT
    );
    CREATE UNIQUE INDEX uq_obs_topic ON observations(project_key, scope, topic_key) WHERE topic_key IS NOT NULL;
    CREATE TABLE memory_anchors (
      observation_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'about',
      anchor_label TEXT, anchor_file TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (observation_id, node_id, role)
    );
    INSERT INTO memory_anchors (observation_id, node_id, role, anchor_label, anchor_file, created_at)
      VALUES ('obs1', 'node1', 'about', 'Label1', 'src/a.ts', 123);
    PRAGMA user_version = 1;
  `);
  v1.close();

  // Re-open through the schema helper → migration runs.
  const db = new DatabaseSync(dbPath);
  try {
    ensureMemorySchema(db);

    const version = (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
    assert.equal(version, MEMORY_SCHEMA_VERSION, "user_version must reach the current schema version");

    const cols = (db.prepare("PRAGMA table_info(memory_anchors)").all() as unknown as { name: string }[])
      .map((c) => c.name);
    assert.ok(cols.includes("anchor_hash"), "anchor_hash column must be added by the migration");

    const row = db.prepare("SELECT anchor_label, anchor_hash FROM memory_anchors WHERE observation_id='obs1'")
      .get() as unknown as { anchor_label: string; anchor_hash: string | null };
    assert.equal(row.anchor_label, "Label1", "pre-existing data must survive the migration");
    assert.equal(row.anchor_hash, null, "back-filled column is null for old rows");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (mig-d) legacy PRE-versioning db (user_version=0, old shape) -------------
// Regression: a memory.db created before schema versioning reports user_version=0 yet
// keeps the old `memory_anchors` shape (no `anchor_hash`). A "v===0 → stamp latest"
// shortcut would skip migrateV1toV2, leaving the column missing, and the next anchor
// INSERT would fail with "table memory_anchors has no column named anchor_hash".

test("(mig-d) ensureMemorySchema migrates a legacy unversioned db (user_version=0, old shape)", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");

  // Hand-craft a pre-versioning db: old memory_anchors (no anchor_hash), user_version left at 0.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project', title TEXT, summary TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE observations (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project', type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, topic_key TEXT, session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, superseded_by TEXT);
    CREATE TABLE memory_anchors (observation_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'about', anchor_label TEXT, anchor_file TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (observation_id, node_id, role));
  `); // user_version intentionally left at its default of 0.
  assert.equal(
    (legacy.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version,
    0,
    "pre: user_version is 0 (pre-versioning)",
  );
  legacy.close();

  const db = new DatabaseSync(dbPath);
  try {
    ensureMemorySchema(db);

    const version = (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
    assert.equal(version, MEMORY_SCHEMA_VERSION, "must reach the current schema version");

    const cols = (db.prepare("PRAGMA table_info(memory_anchors)").all() as unknown as { name: string }[])
      .map((c) => c.name);
    assert.ok(cols.includes("anchor_hash"), "anchor_hash column must be added by the migration");

    // The regression: this INSERT used to fail with a SQL logic error.
    db.prepare(
      `INSERT INTO memory_anchors (observation_id, node_id, role, anchor_label, anchor_file, anchor_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("o1", "n1", "about", "L", "f.ts", "deadbeef", 1);
    const row = db.prepare("SELECT anchor_hash FROM memory_anchors WHERE observation_id='o1'")
      .get() as unknown as { anchor_hash: string };
    assert.equal(row.anchor_hash, "deadbeef", "anchor_hash must round-trip after migration");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (mig-e) v4 → actual: datos preservados, user_version=MEMORY_SCHEMA_VERSION ----
// Cubre: REQ-MM-2 (T10 etapa-3-identity-scopes)

test("(mig-e) ensureMemorySchema migra una DB v4 a la versión actual preservando datos", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");

  // Hand-craft a v4 db: apply base DDL and stamp user_version=4.
  const v4 = new DatabaseSync(dbPath);
  v4.exec(LIKE_DDL);
  v4.exec("PRAGMA user_version = 4");
  const now = Date.now();
  v4.prepare(
    `INSERT INTO observations (id, project_key, scope, type, title, content, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("e-obs-1", "proj-e", "project", "decision", "v4 Title", "v4 Content", now, now, 1);
  v4.close();

  const db = new DatabaseSync(dbPath);
  try {
    ensureMemorySchema(db);

    const version = (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
    assert.equal(version, MEMORY_SCHEMA_VERSION, "DB v4 debe migrarse a la versión actual");

    // Datos preservados
    const obs = db.prepare("SELECT id, scope FROM observations WHERE id='e-obs-1'")
      .get() as unknown as { id: string; scope: string } | undefined;
    assert.ok(obs, "la observación de fixture debe preservarse tras la migración");
    assert.equal(obs.scope, "project", "scope de la observación original debe mantenerse");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (mig-f) versión actual → actual, idempotente --------------------------
// Cubre: REQ-MM-2 (idempotencia)

test("(mig-f) abrir dos veces una DB en la versión actual es idempotente (no sube)", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");

  // Crear DB en la versión actual directamente
  {
    const db = new DatabaseSync(dbPath);
    db.exec(LIKE_DDL);
    db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
    db.close();
  }

  // Primera apertura: sigue en la versión actual
  {
    const db = new DatabaseSync(dbPath);
    ensureMemorySchema(db);
    const v = (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
    assert.equal(v, MEMORY_SCHEMA_VERSION, "primera apertura: debe permanecer en la versión actual");
    db.close();
  }

  // Segunda apertura: sigue igual (no se incrementa)
  {
    const db = new DatabaseSync(dbPath);
    ensureMemorySchema(db);
    const v = (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
    assert.equal(v, MEMORY_SCHEMA_VERSION, "segunda apertura: sigue igual (idempotente)");
    db.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---- (mig-g) memory save sin --scope usa scope='project' --------------------
// Cubre: REQ-MM-5

test("(mig-g) save sin scope explícito usa 'project' por defecto", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project_g", () => []);
  try {
    const { observation } = store.save({
      title: "Default scope observation",
      content: "Testing default scope in v5 schema",
      type: "manual",
      // scope: omitido → debe usar "project"
    });
    assert.equal(observation.scope, "project", "scope por defecto debe ser 'project'");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Symbol-level anchors, file-anchor subsumption, and the status-aware verdict (3.0)
// ---------------------------------------------------------------------------

const SYM_A = `sym1:${"a".repeat(64)}`;
const SYM_B = `sym1:${"b".repeat(64)}`;
const FILE_1 = "1".repeat(64);
const FILE_2 = "2".repeat(64);

test("(drift-sym-1) a sym1 anchor compares the symbol fingerprint, not the file hash", () => {
  const a = { nodeId: "n", anchorLabel: "alpha", anchorFile: "src/a.ts", anchorHash: SYM_A };
  // The file changed (another symbol was edited) but alpha did not → active.
  const same = deriveAnchorState(a, () => ({ exists: true, currentHash: FILE_2, symbolHash: SYM_A }));
  assert.equal(same.state, "active");
  assert.match(same.reason, /verified 'alpha' in 'src\/a\.ts'/);
  const changed = deriveAnchorState(a, () => ({ exists: true, currentHash: FILE_2, symbolHash: SYM_B }));
  assert.equal(changed.state, "stale");
  assert.match(changed.reason, /'alpha' changed in 'src\/a\.ts'/);
  const lost = deriveAnchorState(a, () => ({ exists: true, currentHash: FILE_2, symbolHash: null }));
  assert.equal(lost.state, "stale");
  assert.match(lost.reason, /can no longer be located/);
  // A verifier that computes no fingerprints cannot verify a symbol anchor.
  const legacyVerifier = deriveAnchorState(a, () => ({ exists: true, currentHash: FILE_2 }));
  assert.equal(legacyVerifier.state, "unverified");
  // A file-level anchor keeps the whole-file comparison, labelled as such.
  const fileLevel = deriveAnchorState({ ...a, anchorHash: FILE_1 }, () => ({ exists: true, currentHash: FILE_2, symbolHash: SYM_A }));
  assert.equal(fileLevel.state, "stale");
  assert.match(fileLevel.reason, /file-level anchor/);
});

test("(drift-sym-2) a symbol anchor overrides a whole-file anchor into the same file — except when its node is gone", () => {
  const verify: NodeVerifier = (id) =>
    id === "gone" ? { exists: false, currentHash: null } : { exists: true, currentHash: FILE_2, symbolHash: SYM_A };
  const sym = { nodeId: "sym", anchorLabel: "alpha", anchorFile: "src/a.ts", anchorHash: SYM_A };
  const moduleSameFile = { nodeId: "mod", anchorLabel: "src/a.ts", anchorFile: "src/a.ts", anchorHash: FILE_1 };
  const moduleOtherFile = { nodeId: "mod2", anchorLabel: "src/b.ts", anchorFile: "src/b.ts", anchorHash: FILE_1 };
  const goneSameFile = { nodeId: "gone", anchorLabel: "beta", anchorFile: "src/a.ts", anchorHash: FILE_1 };

  assert.equal(deriveMemoryState([sym, moduleSameFile], verify).state, "active", "edit elsewhere in a.ts is not drift");
  assert.equal(deriveMemoryState([moduleSameFile], verify).state, "stale", "alone, the file anchor still counts");
  assert.equal(deriveMemoryState([sym, moduleOtherFile], verify).state, "stale", "b.ts is not pinned by a symbol");
  assert.equal(deriveMemoryState([sym, goneSameFile], verify).state, "contradicted", "a gone node always counts");
});

test("(drift-verdict-1) verdictOf: drift by nature, honouring the lifecycle status", () => {
  // Active notes: the drift verdict.
  assert.deepEqual(verdictOf("active", "descriptive"), { verdict: "usable", checkViolation: false });
  assert.deepEqual(verdictOf("stale", "descriptive"), { verdict: "warning", checkViolation: false });
  assert.deepEqual(verdictOf("contradicted", "descriptive"), { verdict: "do_not_use", checkViolation: false });
  assert.deepEqual(verdictOf("active", "normative"), { verdict: "usable", checkViolation: false });
  assert.deepEqual(verdictOf("stale", "normative"), { verdict: "warning", checkViolation: true });
  assert.deepEqual(verdictOf("contradicted", "normative"), { verdict: "warning", checkViolation: true });
  assert.deepEqual(verdictOf("unverified", "normative"), { verdict: "warning", checkViolation: false });
  // resolved: history, never more than a warning; obsolete: never usable.
  assert.equal(verdictOf("active", "descriptive", "resolved").verdict, "warning");
  assert.equal(verdictOf("contradicted", "descriptive", "resolved").verdict, "do_not_use");
  assert.deepEqual(verdictOf("stale", "normative", "resolved"), { verdict: "warning", checkViolation: true });
  assert.deepEqual(verdictOf("active", "normative", "obsolete"), { verdict: "do_not_use", checkViolation: false });
});

test("(drift-verdict-2) verified: status and drift state are reported side by side", () => {
  const dir = tmpDir();
  const store = new MemoryStore(join(dir, "memory.db"), "test_project", resolverWithHash("H1"));
  try {
    const save = (title: string) =>
      store.save({ title, content: `statustoken ${title}`, type: "architecture", anchors: ["UserService"] }).observation;
    save("still active");
    store.update(save("fixed already").id, { status: "resolved" });
    store.update(save("no longer true").id, { status: "obsolete" });
    const verify: NodeVerifier = () => ({ exists: true, currentHash: "H1" });
    const ctx = getVerifiedContext(store, "statustoken", verify);

    assert.deepEqual(ctx.usable.map((i) => i.title), ["still active"]);
    assert.deepEqual(ctx.warning.map((i) => [i.title, i.status, i.state]), [["fixed already", "resolved", "active"]]);
    assert.deepEqual(ctx.doNotUse.map((i) => [i.title, i.status, i.state]), [["no longer true", "obsolete", "active"]]);

    const node = latestMemoriesForNode(store, NODE_ID, verify, 10);
    const byTitle = new Map(node.map((m) => [m.title, m]));
    assert.equal(byTitle.get("fixed already")?.status, "resolved");
    assert.equal(byTitle.get("fixed already")?.verdict, "warning");
    assert.equal(byTitle.get("no longer true")?.verdict, "do_not_use");
    assert.equal(byTitle.get("still active")?.verdict, "usable");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
