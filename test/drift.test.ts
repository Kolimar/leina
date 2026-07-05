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
import { getVerifiedContext } from "../src/application/memory/query.ts";
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
      ? [{ nodeId: "src_user_ts:userservice", sourceFile: "src/user.ts", fileHash: hash }]
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

// ---- (drift-e) normative stale → usable + checkViolation --------------------

test("(drift-e) normative + hash changed → usable + checkViolation", () => {
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

    assert.equal(ctx.usable.length, 1, "normative memory is never invalidated by drift");
    assert.equal(ctx.usable[0]!.nature, "normative");
    assert.equal(ctx.usable[0]!.state, "stale");
    assert.equal(ctx.usable[0]!.checkViolation, true, "drifted normative memory flags a violation check");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (drift-f) normative contradicted → usable + checkViolation -------------

test("(drift-f) normative + node gone → usable + checkViolation (not do_not_use)", () => {
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
    assert.equal(ctx.usable.length, 1);
    assert.equal(ctx.usable[0]!.state, "contradicted");
    assert.equal(ctx.usable[0]!.checkViolation, true);
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
    if (label === "UserService") return [{ nodeId: "n_user", sourceFile: "src/user.ts", fileHash: "H1" }];
    if (label === "TokenStore") return [{ nodeId: "n_token", sourceFile: "src/token.ts", fileHash: "H2" }];
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
    assert.equal(MEMORY_SCHEMA_VERSION, 5);

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
    assert.equal(MEMORY_SCHEMA_VERSION, 5);

    const cols = (db.prepare("PRAGMA table_info(memory_anchors)").all() as unknown as { name: string }[])
      .map((c) => c.name);
    assert.ok(cols.includes("anchor_hash"), "anchor_hash column must be added by the migration");

    const row = db.prepare("SELECT anchor_label, anchor_hash FROM memory_anchors WHERE observation_id='obs1'")
      .get() as unknown as { anchor_label: string; anchor_hash: string | null };
    assert.equal(row.anchor_label, "Label1", "pre-existing data must survive the migration");
    assert.equal(row.anchor_hash, null, "back-filled column is null for old rows");
    assert.equal(MEMORY_SCHEMA_VERSION, 5);
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

// ---- (mig-e) v4 → v5 migration: datos preservados, user_version=5 ----------
// Cubre: REQ-MM-2 (T10 etapa-3-identity-scopes)

test("(mig-e) ensureMemorySchema migra una DB v4 a v5 preservando datos", () => {
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
    assert.equal(version, 5, "DB v4 debe migrarse a v5");
    assert.equal(MEMORY_SCHEMA_VERSION, 5, "MEMORY_SCHEMA_VERSION debe ser 5");

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

// ---- (mig-f) v5 → v5 idempotente -------------------------------------------
// Cubre: REQ-MM-2 (idempotencia)

test("(mig-f) abrir dos veces una DB en v5 es idempotente (no sube a v6)", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");

  // Crear DB en v5 directamente
  {
    const db = new DatabaseSync(dbPath);
    db.exec(LIKE_DDL);
    db.exec("PRAGMA user_version = 5");
    db.close();
  }

  // Primera apertura: v5 → sigue en v5
  {
    const db = new DatabaseSync(dbPath);
    ensureMemorySchema(db);
    const v = (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
    assert.equal(v, 5, "primera apertura: debe permanecer en v5");
    db.close();
  }

  // Segunda apertura: sigue en v5 (no se incrementa)
  {
    const db = new DatabaseSync(dbPath);
    ensureMemorySchema(db);
    const v = (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
    assert.equal(v, 5, "segunda apertura: sigue en v5 (idempotente)");
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
