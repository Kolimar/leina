// Memory DB schema — DDL + versioning helpers.
// FTS5 rides the implicit rowid; triggers maintain the external-content index.

import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LEGACY_TYPE_ALIASES, OBSERVATION_TYPES, SCOPES } from "../../domain/memory/model.ts";

export const MEMORY_SCHEMA_VERSION = 8;

// Node bundles its built-in SQLite WITHOUT the FTS5 compile flag until Node 24.
// Node 22/23 builds ship without FTS5; Node 24+ enables it (nodejs/node#56476).
// When FTS5 is absent leina automatically degrades to LIKE-based search
// (see ensureMemorySchema) with a warning to stderr so the user knows to upgrade
// for full stemmed/ranked search.
export const FTS5_MIN_NODE_MAJOR = 24;

// Single source of truth for the FTS5-missing error text (exported so it can be
// unit-tested without needing an actual FTS5-less Node build). Kept in English to
// match the rest of the CLI's error surface (see cli/wiring.ts, cli/io.ts).
// No longer thrown on the normal path — ensureMemorySchema now degrades gracefully —
// but still exported so tests and the warning message can reference it.
export function fts5UnavailableMessage(nodeVersion: string = process.version): string {
  return (
    `leina: this Node build (${nodeVersion}) was compiled without the SQLite FTS5 ` +
    `module, which leina memory (full-text search) requires.\n` +
    `Node enables FTS5 in its built-in SQLite only from Node ${FTS5_MIN_NODE_MAJOR}; Node 22/23 ` +
    `builds ship without it.\n` +
    `Fix: upgrade to Node ${FTS5_MIN_NODE_MAJOR} or newer (https://nodejs.org), then re-run. ` +
    `Verify with: node --version`
  );
}

// Kept exported for backwards compatibility and tests. No longer thrown by
// ensureMemorySchema — the schema now degrades to LIKE mode automatically.
export class Fts5UnavailableError extends Error {
  constructor(nodeVersion: string = process.version) {
    super(fts5UnavailableMessage(nodeVersion));
    this.name = "Fts5UnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Test seam — lets unit tests force LIKE-mode on a Node build that has FTS5.
// @internal — NEVER call this in production code.
// Usage in tests:
//   import { __setFts5ProbeForTests } from '…/schema.ts';
//   beforeEach(() => __setFts5ProbeForTests(() => false));
//   afterEach(() => __setFts5ProbeForTests(null));
// ---------------------------------------------------------------------------
let _fts5ProbeOverride: ((db: DatabaseSync) => boolean) | null = null;

export function __setFts5ProbeForTests(fn: ((db: DatabaseSync) => boolean) | null): void {
  _fts5ProbeOverride = fn;
}

// Capability probe: create + drop a throwaway FTS5 table. Uses the `temp.` schema
// so it leaves no trace in the real db (and works against an in-memory probe db too
// — see doctor.ts). Returns false on the "no such module: fts5" error a flag-less
// build raises. If a test seam is installed via __setFts5ProbeForTests, it is
// used instead of the real probe.
export function fts5Available(db: DatabaseSync): boolean {
  if (_fts5ProbeOverride !== null) return _fts5ProbeOverride(db);
  try {
    db.exec("CREATE VIRTUAL TABLE temp.__leina_fts5_probe USING fts5(x)");
    db.exec("DROP TABLE temp.__leina_fts5_probe");
    return true;
  } catch {
    return false;
  }
}

// Single source of truth for the FTS5 table definition. Both MEMORY_DDL (fresh dbs)
// and migrateV3toV4 (existing dbs) reference this, so the tokenizer can never drift
// between the two paths. The tokenizer is immutable once the table exists, so changing
// it requires DROP + recreate (see migrateV3toV4).
//   porter            — English stemmer wrapping unicode61, so morphological variants
//                       (search/searching, migrate/migration) match. Applied symmetrically
//                       to index and query, so non-English (e.g. Spanish) content is never
//                       mismatched — it just gets no stemming benefit.
//   remove_diacritics — accent-insensitive (búsqueda ↔ busqueda) for both languages.
export const OBS_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(
  title, content, content='observations', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);`;

// FTS sync triggers — guarded so superseded snapshots NEVER enter the index. Invariant:
// a row is in obs_fts exactly while it is live (superseded_by IS NULL). obs_ai indexes
// live inserts (a snapshot is born superseded and skipped), obs_au re-indexes live-row
// content edits (the revision++ upsert path), obs_ad un-indexes deleted live rows, and
// the two transition triggers cover a row that changes side: obs_au_retire un-indexes a
// live row that becomes superseded (merge-projects topic collisions, import topic
// conflicts) and obs_au_revive indexes a snapshot that becomes live again (import). Before
// v8 those two transitions had no trigger and left "ghost" index entries behind.
// Snapshots stay in the base table (retrievable by get(id), full superseded_by audit
// trail) but are never FTS-scored.
const FTS_SYNC_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations
  WHEN new.superseded_by IS NULL
BEGIN
  INSERT INTO obs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations
  WHEN old.superseded_by IS NULL
BEGIN
  INSERT INTO obs_fts(obs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations
  WHEN old.superseded_by IS NULL AND new.superseded_by IS NULL
BEGIN
  INSERT INTO obs_fts(obs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO obs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_au_retire AFTER UPDATE ON observations
  WHEN old.superseded_by IS NULL AND new.superseded_by IS NOT NULL
BEGIN
  INSERT INTO obs_fts(obs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_au_revive AFTER UPDATE ON observations
  WHEN old.superseded_by IS NOT NULL AND new.superseded_by IS NULL
BEGIN
  INSERT INTO obs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
`;

/** Every FTS sync trigger name — LIKE mode drops them all (there is no obs_fts to feed). */
const FTS_TRIGGER_NAMES = ["obs_ai", "obs_ad", "obs_au", "obs_au_retire", "obs_au_revive"] as const;

function dropFtsTriggers(db: DatabaseSync): void {
  for (const name of FTS_TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

// Drop + recreate obs_fts and index the LIVE rows of every project (the table is global).
// Direct INSERT, never the FTS5 'rebuild' command: that re-reads EVERY base row, snapshots
// included. The caller owns the transaction.
function reindexLiveRows(db: DatabaseSync): void {
  db.exec("DROP TABLE IF EXISTS obs_fts");
  db.exec(OBS_FTS_DDL);
  db.exec(
    `INSERT INTO obs_fts(rowid, title, content)
         SELECT rowid, title, content FROM observations WHERE superseded_by IS NULL`,
  );
}

// ---------------------------------------------------------------------------
// DDL fragments — BASE_DDL contains all non-FTS5 tables and indexes.
// LIKE_DDL = BASE_DDL (no virtual table, no sync triggers).
// MEMORY_DDL = full schema with obs_fts + triggers inserted in their original position.
// ---------------------------------------------------------------------------

// Sessions + observations tables and indexes (no FTS5 elements).
const SESSIONS_OBS_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
  title TEXT, summary TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_proj ON sessions(project_key, started_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
  type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  topic_key TEXT, session_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT,
  status TEXT NOT NULL DEFAULT 'active', status_changed_at INTEGER, resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_obs_proj_time ON observations(project_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_type      ON observations(project_key, type);
-- Partial: only the LIVE revision (superseded_by IS NULL) owns a topic_key, so
-- superseded snapshots may retain their topic_key without colliding on it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_obs_topic
  ON observations(project_key, scope, topic_key)
  WHERE topic_key IS NOT NULL AND superseded_by IS NULL;
`;

// memory_anchors table and indexes.
const ANCHORS_DDL = `
CREATE TABLE IF NOT EXISTS memory_anchors (
  observation_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'about',
  anchor_label TEXT, anchor_file TEXT, anchor_hash TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (observation_id, node_id, role)
);
CREATE INDEX IF NOT EXISTS idx_anchors_node ON memory_anchors(node_id);
CREATE INDEX IF NOT EXISTS idx_anchors_obs  ON memory_anchors(observation_id);
`;

// BASE_DDL: all tables + indexes, NO FTS5 virtual table, NO sync triggers.
// Used as the foundation for both LIKE_DDL and MEMORY_DDL — tables can never drift.
const BASE_DDL = SESSIONS_OBS_DDL + ANCHORS_DDL;

// LIKE_DDL: schema for LIKE-mode databases. Identical to BASE_DDL; obs_fts is
// absent (never created) so there is no virtual table to break on FTS5-less builds.
export const LIKE_DDL = BASE_DDL;

// MEMORY_DDL: full schema including FTS5 virtual table and sync triggers.
// FTS5 elements are placed between the observations indexes and memory_anchors,
// preserving the historical layout so existing snapshot tests don't drift.
export const MEMORY_DDL = `${SESSIONS_OBS_DDL  }
${OBS_FTS_DDL}
${FTS_SYNC_TRIGGERS}
${  ANCHORS_DDL}`;

export function ensureMemorySchema(db: DatabaseSync): { fts5: boolean } {
  const file = outdatedDbFile(db);
  if (file === null) return applyMemorySchema(db);
  // An outdated file-backed db is upgraded in ONE transaction that holds the write lock from
  // before the backup to the version stamp: a concurrent opener waits on the lock, then finds
  // the db current — one backup, of the untouched db, and never a half-upgraded one.
  db.exec("BEGIN IMMEDIATE");
  upgrading.add(db);
  try {
    backupBeforeMigration(db, file);
    const result = applyMemorySchema(db);
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    upgrading.delete(db);
  }
}

function applyMemorySchema(db: DatabaseSync): { fts5: boolean } {
  const fts5 = fts5Available(db);

  if (fts5) {
    applyFts5Schema(db);
  } else {
    applyLikeSchema(db);
  }

  runMemoryMigrations(db, fts5);
  return { fts5 };
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
}

// The file of a db the ladder will upgrade: file-backed, already holding tables (a db with
// none is new) and below the current version. Null when there is nothing to back up.
function outdatedDbFile(db: DatabaseSync): string | null {
  if (userVersion(db) >= MEMORY_SCHEMA_VERSION) return null;
  const main = (
    db.prepare("PRAGMA database_list").all() as unknown as { name: string; file: string }[]
  ).find((d) => d.name === "main");
  const file = main?.file ?? "";
  if (file === "") return null;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() === undefined) return null;
  return file;
}

// A schema upgrade rewrites stored memory in place, so keep a copy next to the db first
// (`memory.db.bak-v<from>-<ISO>`). Runs inside the upgrade transaction, before its first
// write: VACUUM INTO cannot run in a transaction, so a second, read-only connection copies
// the committed (untouched) db. The version is re-read under the lock — another process may
// have finished the upgrade while this one waited. A failed copy stops here, before any change.
function backupBeforeMigration(db: DatabaseSync, file: string): void {
  const v = userVersion(db);
  if (v >= MEMORY_SCHEMA_VERSION) return;
  const target = `${file}.bak-v${v}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  try {
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      copy.exec("PRAGMA busy_timeout = 5000;");
      copy.prepare("VACUUM INTO ?").run(target);
    } finally {
      copy.close();
    }
  } catch (e) {
    rmSync(target, { force: true }); // a failed VACUUM INTO can leave an empty or partial file
    throw new Error(
      `${file} needs a migration from v${v} to v${MEMORY_SCHEMA_VERSION}, but its backup to ${target} failed (${e instanceof Error ? e.message : String(e)}); nothing was changed.`,
    );
  }
}

// Dbs being upgraded inside ensureMemorySchema's outer transaction: their inner transactions
// become savepoints.
const upgrading = new WeakSet<DatabaseSync>();

// Run a sequence of statements inside a single IMMEDIATE transaction, rolling back
// (and rethrowing) on any failure so a crash never leaves the db half-migrated.
function inTransaction(db: DatabaseSync, work: () => void): void {
  const nested = upgrading.has(db);
  db.exec(nested ? "SAVEPOINT leina_step" : "BEGIN IMMEDIATE");
  try {
    work();
    db.exec(nested ? "RELEASE leina_step" : "COMMIT");
  } catch (e) {
    db.exec(nested ? "ROLLBACK TO leina_step; RELEASE leina_step" : "ROLLBACK");
    throw e;
  }
}

// FTS5 branch: install the full schema (virtual table + triggers) and, on a detected
// LIKE→FTS5 transition, rebuild the obs_fts index from live observations.
function applyFts5Schema(db: DatabaseSync): void {
  // Check trigger count BEFORE running DDL so we can detect a LIKE→FTS5 transition:
  // a db that was opened without FTS5 will have had its triggers dropped, giving 0 here.
  const triggersBefore = (
    db.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
         WHERE type='trigger' AND name IN ('obs_ai','obs_au','obs_ad')`,
    ).get() as unknown as { n: number }
  ).n;

  // Run full DDL (each statement idempotent via IF NOT EXISTS). On a fresh db this
  // creates obs_fts + triggers. On an existing db the IF NOT EXISTS guards are no-ops
  // for tables/indexes that already exist; MEMORY_DDL also recreates any missing
  // triggers (IF NOT EXISTS is a no-op when a same-named trigger exists, but if
  // triggers were dropped by a previous LIKE-mode open they get recreated here).
  db.exec(MEMORY_DDL);

  if (triggersBefore >= 3) return;

  // LIKE→FTS5 transition: the obs_fts index was not maintained while FTS5 was absent
  // (there were no triggers firing on writes). Drop and recreate obs_fts to start with
  // a known-clean index, then reindex all live observations.
  // Mirrors migrateV3toV4's approach (DROP + OBS_FTS_DDL + INSERT…SELECT).
  // Wrapped in a transaction so a crash leaves the db in the pre-rebuild state.
  inTransaction(db, () => reindexLiveRows(db));
}

// LIKE branch: run schema without FTS5 virtual table or sync triggers, and drop any
// inherited FTS5 sync triggers from a db previously opened with FTS5 support (e.g. the
// same db opened on Node 24, now reopened on Node 22/23). Without that DROP, writes to
// `observations` would fire the triggers and attempt to INSERT into obs_fts — causing
// every write to fail with "no such table: obs_fts". Wrapped in a transaction so a crash
// never leaves the db half-migrated (base tables created but inherited triggers still live).
function applyLikeSchema(db: DatabaseSync): void {
  inTransaction(db, () => {
    db.exec(LIKE_DDL);
    dropFtsTriggers(db);
  });
}

// Schema versioning — mirror GraphStore pattern. Validates the stored user_version and
// runs the migration ladder for any db below the current version.
function runMemoryMigrations(db: DatabaseSync, fts5: boolean): void {
  // IMPORTANT: never use bound params for PRAGMA; build the literal.
  const v = userVersion(db);
  if (v > MEMORY_SCHEMA_VERSION) {
    throw new Error(
      `memory.db was written by a newer version of leina (db version ${v}, binary supports up to ${MEMORY_SCHEMA_VERSION}). Upgrade leina.`,
    );
  }
  if (v >= MEMORY_SCHEMA_VERSION) return;

  // Run the migration ladder for any db below the current version. CRUCIAL: do NOT treat
  // user_version=0 as "fresh, already current". A legacy *pre-versioning* memory.db also
  // reports 0 while its tables keep the old shape (e.g. `memory_anchors` without
  // `anchor_hash`). Since the CREATE TABLE IF NOT EXISTS in the DDL above never upgrades an
  // existing table, a "v===0 → stamp latest" shortcut would leave that column missing and
  // the next anchor INSERT would fail with a SQL logic error. The migrations are idempotent
  // (guarded ALTER / IF EXISTS), so on a truly fresh db — whose shape the DDL already made
  // current — they are effectively no-ops; this runs at most once, before the stamp to v4.
  if (v < 2) migrateV1toV2(db);
  // migrateV2toV3 and migrateV3toV4 are FTS5-only (they touch obs_fts and its triggers).
  // In LIKE mode we skip them but still advance user_version to 5, because the base
  // table shape is already current (no structural change is needed for tables/indexes).
  if (v < 3 && fts5) migrateV2toV3(db);
  if (v < 4 && fts5) migrateV3toV4(db);
  // v4→v5: no-op marker — scope es TEXT sin CHECK; sella la taxonomía rica (9 valores).
  // No gateada por fts5: el cambio afecta al modelo de dominio, no a los índices FTS.
  if (v < 5) migrateV4toV5(db);
  if (v < 6) migrateV5toV6(db);
  if (v < 7) migrateV6toV7(db);
  if (v < 8) migrateV7toV8(db, fts5);
  db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
}

// v1 → v2: stamp anchors with the source-file hash at save time, and let superseded
// snapshots keep their topic_key by narrowing the topic uniqueness to live rows.
function migrateV1toV2(db: DatabaseSync): void {
  const hasAnchorHash = (
    db.prepare("PRAGMA table_info(memory_anchors)").all() as unknown as { name: string }[]
  ).some((c) => c.name === "anchor_hash");
  if (!hasAnchorHash) {
    db.exec("ALTER TABLE memory_anchors ADD COLUMN anchor_hash TEXT");
  }
  // Replace the full-table unique index with the partial (live-row-only) one.
  db.exec("DROP INDEX IF EXISTS uq_obs_topic");
  db.exec(
    `CREATE UNIQUE INDEX uq_obs_topic ON observations(project_key, scope, topic_key)
       WHERE topic_key IS NOT NULL AND superseded_by IS NULL`,
  );
}

// v2 → v3: stop FTS-indexing superseded snapshots. v2 dbs carry the OLD unguarded
// triggers (which indexed every row) plus snapshot rows already in the FTS index, so
// both must be repaired: purge the stale snapshot entries, then swap in guarded triggers.
// FTS5-only — skipped in LIKE mode.
function migrateV2toV3(db: DatabaseSync): void {
  // Wrapped in a transaction so a crash mid-migration leaves the prior (v2) state intact
  // rather than a half-repaired index.
  inTransaction(db, () => {
    // Purge already-indexed snapshot rows from the FTS index. external-content FTS5
    // 'delete' requires the originally-indexed title/content; snapshots are immutable so
    // the row's current values match exactly → clean removal, no index corruption.
    // (Do NOT 'rebuild' — that re-indexes EVERY base row, snapshots included.)
    db.exec(
      `INSERT INTO obs_fts(obs_fts, rowid, title, content)
         SELECT 'delete', rowid, title, content FROM observations WHERE superseded_by IS NOT NULL`,
    );
    // The unguarded triggers survived `db.exec(MEMORY_DDL)` (CREATE ... IF NOT EXISTS is a
    // no-op when a same-named trigger exists), so replace them explicitly with the guarded
    // ones that exclude superseded snapshots.
    dropFtsTriggers(db);
    db.exec(FTS_SYNC_TRIGGERS);
  });
}

// v3 → v4: switch the FTS tokenizer to porter (English stemming). The tokenizer is fixed
// at table-creation time, so the only way to change it is to DROP and recreate obs_fts,
// then reindex. We reindex LIVE rows only (superseded_by IS NULL) so snapshots stay out of
// the index, preserving the v3 invariant. Wrapped in a transaction: a crash mid-migration
// rolls back to the prior (v3) index rather than leaving the db without obs_fts.
// FTS5-only — skipped in LIKE mode.
function migrateV3toV4(db: DatabaseSync): void {
  inTransaction(db, () => reindexLiveRows(db));
}

// v4 → v5: no-op marker — the `scope` column is TEXT without a CHECK constraint, so all 9
// Scope literal values are already valid in the DB. This migration exists solely to advance
// user_version to 5 and document the point at which the rich scope taxonomy (9 values) was
// introduced. Not gated by fts5 (no FTS5 structures are touched).
 
function migrateV4toV5(_db: DatabaseSync): void {
  // no-op: scope is TEXT without CHECK; the rich 9-value taxonomy is purely a TypeScript
  // compile-time contract. No SQL structural changes needed.
}

// v5 → v6: normalise the closed value sets. Before 3.0 the CLI cast `--type` / `--scope`
// without validation, so real dbs hold rows typed `note` (and other free-form values) that
// `memory import` then rejects — an export from such a db could not be re-imported anywhere.
// Legacy aliases map to their canonical type (LEGACY_TYPE_ALIASES), any other unknown type
// becomes `manual`, any unknown scope becomes `project`. Snapshots are normalised too (they
// travel in exports). Pure UPDATEs, idempotent: a second run matches no row. On FTS5 dbs the
// obs_au trigger re-indexes the touched live rows with identical title/content — a no-op for
// the index. Not gated by fts5.
function migrateV5toV6(db: DatabaseSync): void {
  const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");
  inTransaction(db, () => {
    const alias = db.prepare("UPDATE observations SET type = ? WHERE type = ?");
    for (const [legacy, canonical] of Object.entries(LEGACY_TYPE_ALIASES)) alias.run(canonical, legacy);
    db.prepare(
      `UPDATE observations SET type = 'manual' WHERE type NOT IN (${placeholders(OBSERVATION_TYPES.length)})`,
    ).run(...OBSERVATION_TYPES);
    for (const table of ["observations", "sessions"]) {
      db.prepare(
        `UPDATE ${table} SET scope = 'project' WHERE scope NOT IN (${placeholders(SCOPES.length)})`,
      ).run(...SCOPES);
    }
  });
}

// v6 → v7: observation lifecycle (status / status_changed_at / resolution). Every existing row
// starts `active` — exactly what it was before the column existed. Guarded per column (the DDL
// above already creates them on a fresh db, and a crash between two ALTERs must re-run
// cleanly), inside one transaction. No index references the new columns from the DDL: a
// CREATE INDEX there would run BEFORE this ALTER on an old db and fail.
function migrateV6toV7(db: DatabaseSync): void {
  const have = new Set(
    (db.prepare("PRAGMA table_info(observations)").all() as unknown as { name: string }[]).map((c) => c.name),
  );
  inTransaction(db, () => {
    if (!have.has("status")) db.exec("ALTER TABLE observations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    if (!have.has("status_changed_at")) db.exec("ALTER TABLE observations ADD COLUMN status_changed_at INTEGER");
    if (!have.has("resolution")) db.exec("ALTER TABLE observations ADD COLUMN resolution TEXT");
  });
}

// v7 → v8: repair what the pre-3.0 `memory merge-projects` left behind.
//   1. It re-keyed only LIVE rows, stranding their superseded snapshots under the old key
//      (out of reach of export, compact and get for the project that owns the topic). A
//      snapshot belongs with the row it was superseded by, so each one whose superseded_by
//      row lives under another key follows it (repeated for snapshot→snapshot chains;
//      bounded, and a no-op on a second run).
//   2. Its topic-collision path (and import's topic-conflict path) turned live rows into
//      snapshots with an UPDATE no trigger un-indexed, leaving ghost obs_fts entries. The
//      new obs_au_retire / obs_au_revive triggers prevent new ones; the index is rebuilt
//      over live rows once to purge any existing ghost (FTS5 only — LIKE has no index, and
//      a later LIKE→FTS5 reopen rebuilds it anyway).
function migrateV7toV8(db: DatabaseSync, fts5: boolean): void {
  inTransaction(db, () => {
    const rehome = db.prepare(
      `UPDATE observations
          SET project_key = (SELECT t.project_key FROM observations t WHERE t.id = observations.superseded_by)
        WHERE superseded_by IS NOT NULL
          AND EXISTS (SELECT 1 FROM observations t
                       WHERE t.id = observations.superseded_by AND t.project_key <> observations.project_key)`,
    );
    for (let pass = 0; pass < 16; pass++) {
      if ((rehome.run() as { changes: number }).changes === 0) break;
    }
    if (fts5) reindexLiveRows(db);
  });
}
