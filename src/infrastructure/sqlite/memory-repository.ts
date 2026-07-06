// SQLiteMemoryRepository — MemoryRepository adapter backed by node:sqlite.
// Owns the single DatabaseSync handle for memory.db (separate from graph.db).
// FTS5 rides the implicit rowid; all search JOINs use rowid, NEVER the TEXT id column.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { makeId, normalizeLabel } from "../../domain/shared/id.ts";
import { ensureMemorySchema } from "./schema.ts";
import type {
  Observation,
  ObservationInput,
  ObservationType,
  Scope,
  SearchHit,
  Session,
  TopicKeySuggestion,
  UpdateFields,
  ExportedAnchor,
  ExportedObservation,
  ImportReport,
} from "../../domain/memory/model.ts";
import type { BatchResult } from "../../domain/shared/batch.ts";
import type { MemoryRepository } from "../../domain/memory/ports.ts";

// ---------------------------------------------------------------------------
// Row shapes (DatabaseSync returns plain objects; cast with as unknown as XxxRow[])
// ---------------------------------------------------------------------------

// Resolves a human-facing symbol label to the real graph node(s) it names. Injected
// so the memory store can anchor observations to actual graph node IDs without
// depending on GraphStore directly — keeps the graph.db / memory.db boundary clean.
export interface ResolvedAnchor {
  nodeId: string;
  sourceFile: string;
  // sha256 of the source file at save time (from the build manifest), or undefined
  // when the file isn't in the manifest. Lets drift detection later compare the
  // file's current hash against what it was when this memory was anchored.
  fileHash?: string;
}
export type AnchorResolver = (label: string) => ResolvedAnchor[];

interface ObsRow {
  id: string;
  project_key: string;
  scope: string;
  type: string;
  title: string;
  content: string;
  topic_key: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
  superseded_by: string | null;
}

interface SessionRow {
  id: string;
  project_key: string;
  scope: string;
  title: string | null;
  summary: string | null;
  started_at: number;
  ended_at: number | null;
}

interface SearchRow {
  id: string;
  title: string;
  type: string;
  topic_key: string | null;
  updated_at: number;
  scope: string;
  snippet: string;
  score: number;
}

// Tolerate the leading "#" presentation prefix that search/context render in
// front of ids (`#${h.id}`). Stored ids are produced by scopedId()/makeId():
// the project-key segment may contain hyphens, every other segment is
// normalized to [\p{L}\p{N}_], and segments join with ":" — so a real id can
// never start with "#". Stripping it lets callers paste an id exactly as shown
// by search/get/context into get(), update() and updateBatch() alike.
function stripIdPrefix(id: string): string {
  return id.startsWith("#") ? id.slice(1) : id;
}

// ---------------------------------------------------------------------------
// Row-to-domain mappers
// ---------------------------------------------------------------------------

function rowToObs(r: ObsRow): Observation {
  const o: Observation = {
    id: r.id,
    projectKey: r.project_key,
    scope: r.scope as Scope,
    type: r.type as ObservationType,
    title: r.title,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision,
  };
  if (r.topic_key) o.topicKey = r.topic_key;
  if (r.session_id) o.sessionId = r.session_id;
  if (r.superseded_by) o.supersededBy = r.superseded_by;
  return o;
}

function rowToSession(r: SessionRow): Session {
  const s: Session = {
    id: r.id,
    projectKey: r.project_key,
    scope: r.scope as Scope,
    startedAt: r.started_at,
  };
  if (r.title) s.title = r.title;
  if (r.summary) s.summary = r.summary;
  if (r.ended_at !== null) s.endedAt = r.ended_at;
  return s;
}

// ---------------------------------------------------------------------------
// FTS5 MATCH sanitization
// Each token is wrapped in double-quotes (escaping any internal double-quote by doubling),
// then joined with OR so search behaves like recall (any term matches; bm25 ranks the
// best hits first), not strict AND. A query term absent from a record no longer drops the
// whole match.
//
// Proximity boost: when the query has more than one token, the full quoted phrase is
// prepended as an extra OR term ("a b c" OR "a" OR "b" OR "c"). A record where the terms
// appear adjacent and in order matches the phrase term too, so bm25 scores it higher —
// without losing the OR recall (the per-token terms still match scattered occurrences).
// ---------------------------------------------------------------------------

function sanitizeMatchQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  const quote = (t: string) => `"${t.replaceAll('"', '""')}"`;
  const terms = tokens.map(quote);
  // Single token: the phrase IS the token — no point duplicating it.
  if (tokens.length > 1) {
    terms.unshift(quote(tokens.join(" ")));
  }
  return terms.join(" OR ");
}

/**
 * Recall fallback when the exact MATCH finds nothing: turn each token (≥4 chars) into
 * an FTS5 prefix query on its leading ~60%. Catches cross-language technical roots
 * ("paginacion" → pagina* → "pagination", "validación" → valid* → "validation") and
 * light typos in the suffix, at zero dependency cost. Returns null when no token is
 * long enough to form a useful prefix.
 */
function prefixMatchQuery(query: string): string | null {
  const tokens = query.trim().split(/\s+/).filter((t) => t.length >= 4);
  if (tokens.length === 0) return null;
  const quote = (t: string) => `"${t.replaceAll('"', '""')}"`;
  const prefixes = new Set<string>();
  for (const t of tokens) {
    // Two prefix lengths per token: ~60% of the query token, AND a short 4-char one.
    // The index holds PORTER STEMS ("pagination" → "pagin"), which can be shorter than
    // the 60% cut of the query word — the 4-char prefix still lands under the stem.
    prefixes.add(`${quote(t.slice(0, Math.max(4, Math.floor(t.length * 0.6))))}*`);
    prefixes.add(`${quote(t.slice(0, 4))}*`);
  }
  return [...prefixes].join(" OR ");
}

// Tokenize a key into a set of lowercase tokens split on - and /.
function tokenize(key: string): Set<string> {
  return new Set(key.toLowerCase().split(/[-/]+/).filter((t) => t.length > 0));
}

// Jaccard similarity: |A ∩ B| / |A ∪ B|
function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LIKE-search helpers (used when FTS5 is unavailable)
// ---------------------------------------------------------------------------

// Split a search query into lowercase tokens suitable for SQL LIKE patterns (%token%).
// Returns an empty array when the query is blank (caller should return [] without querying).
function buildLikeTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `%${t}%`);
}

// LIKE-mode counterpart of prefixMatchQuery (same recall fallback, same token policy):
// each token ≥4 chars contributes two substring patterns — its leading ~60% and a short
// 4-char prefix — so "paginacion" still lands on "pagination" without FTS5. Returns []
// when no token is long enough (mirrors prefixMatchQuery returning null).
function buildLikePrefixTokens(query: string): string[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
  const patterns = new Set<string>();
  for (const t of tokens) {
    patterns.add(`%${t.slice(0, Math.max(4, Math.floor(t.length * 0.6)))}%`);
    patterns.add(`%${t.slice(0, 4)}%`);
  }
  return [...patterns];
}

// Build a snippet (similar to FTS5's snippet() function) from content by finding the
// first occurrence of any token and extracting ~80 characters of context around it.
// The matching word is wrapped with [ and ] to mirror the FTS5 snippet format used by
// the FTS5 branch. Returns the full content (truncated) when no token is found.
function buildLikeSnippet(content: string, tokens: string[]): string {
  const raw = tokens.map((t) => t.replaceAll("%", "")); // strip LIKE wildcards
  const lower = content.toLowerCase();
  let bestIdx = -1;
  let bestToken = "";
  for (const t of raw) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestToken = t;
    }
  }
  if (bestIdx === -1) {
    // No hit — return a plain prefix snippet
    return content.length > 160 ? `${content.slice(0, 160)  } …` : content;
  }
  const start = Math.max(0, bestIdx - 40);
  const end = Math.min(content.length, bestIdx + bestToken.length + 40);
  const window = content.slice(start, end);
  // Wrap the matched word (case-insensitive) with [ ] mirroring FTS5 snippet format.
  // eslint-disable-next-line security/detect-non-literal-regexp -- token is regex-escaped on the line above
  const re = new RegExp(bestToken.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const highlighted = window.replaceAll(re, (m) => `[${m}]`);
  const prefix = start > 0 ? " … " : "";
  const suffix = end < content.length ? " … " : "";
  return prefix + highlighted + suffix;
}

export class SQLiteMemoryRepository implements MemoryRepository {
  private readonly db: DatabaseSync;
  private readonly projectKey: string;
  // Whether FTS5 was available when this repository was opened. Propagated from
  // ensureMemorySchema so we never probe twice.
  private readonly fts5: boolean;
  // Track the active session id (one per MemoryStore instance / server process)
  private activeSessionId: string | null = null;
  // Resolves anchor labels to real graph node IDs. Defaults to a no-op resolver
  // (labels stay unresolved) when no graph is wired in — e.g. the CLI.
  private readonly resolveAnchor: AnchorResolver = () => [];

  constructor(memPath: string, projectKey: string, resolveAnchor?: AnchorResolver) {
    mkdirSync(dirname(memPath), { recursive: true });
    this.db = new DatabaseSync(memPath);
    // Same rationale as GraphStore: wait for a concurrent writer instead of failing
    // immediately with SQLITE_BUSY (the global memory.db is shared across processes).
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    const { fts5 } = ensureMemorySchema(this.db);
    this.fts5 = fts5;
    this.projectKey = projectKey;
    if (resolveAnchor) this.resolveAnchor = resolveAnchor;
  }

  /** True when running in LIKE-search degraded mode (FTS5 unavailable). */
  get usingLike(): boolean {
    return !this.fts5;
  }


  // ---- portable memory (export/import) ------------------------------------

  exportAll(): ExportedObservation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM observations WHERE project_key = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(this.projectKey) as unknown as ObsRow[];
    const anchorStmt = this.db.prepare(
      `SELECT node_id, role, anchor_label, anchor_file, anchor_hash, created_at
         FROM memory_anchors WHERE observation_id = ? ORDER BY node_id ASC, role ASC`,
    );
    return rows.map((r) => {
      const anchors = (anchorStmt.all(r.id) as unknown as {
        node_id: string; role: string; anchor_label: string | null;
        anchor_file: string | null; anchor_hash: string | null; created_at: number;
      }[]).map((a): ExportedAnchor => ({
        nodeId: a.node_id,
        role: a.role,
        anchorLabel: a.anchor_label ?? undefined,
        anchorFile: a.anchor_file ?? undefined,
        anchorHash: a.anchor_hash ?? undefined,
        createdAt: a.created_at,
      }));
      return { schemaVersion: 1 as const, ...rowToObs(r), anchors };
    });
  }


  // Live topic_key collision with a DIFFERENT local observation: resolve toward the newer
  // side. The loser becomes a superseded snapshot — keeps history and satisfies the
  // partial unique index (which only covers live rows). Returns the superseded_by value
  // the incoming row must carry.
  private resolveTopicConflict(
    item: ExportedObservation,
    isNewer: (a: { revision: number; updatedAt: number }, b: { revision: number; updatedAt: number }) => boolean,
    report: ImportReport,
  ): string | null {
    const inherited = item.supersededBy ?? null;
    if (item.topicKey === undefined || inherited !== null) return inherited;
    const local = this.db
      .prepare(
        `SELECT id, revision, updated_at FROM observations
           WHERE project_key=? AND scope=? AND topic_key=? AND superseded_by IS NULL`,
      )
      .get(this.projectKey, item.scope, item.topicKey) as unknown as
      { id: string; revision: number; updated_at: number } | undefined;
    if (local === undefined) return null;
    report.topicConflicts++;
    if (isNewer(item, { revision: local.revision, updatedAt: local.updated_at })) {
      this.db.prepare(`UPDATE observations SET superseded_by=? WHERE id=?`).run(item.id, local.id);
      return null;
    }
    return local.id;
  }

  importObservations(items: ExportedObservation[]): ImportReport {
    const report: ImportReport = { inserted: 0, updated: 0, skippedOlder: 0, topicConflicts: 0 };
    const insertStmt = this.db.prepare(
      `INSERT INTO observations
         (id, project_key, scope, type, title, content, topic_key, session_id,
          created_at, updated_at, revision, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateStmt = this.db.prepare(
      `UPDATE observations SET scope=?, type=?, title=?, content=?, topic_key=?, session_id=?,
          created_at=?, updated_at=?, revision=?, superseded_by=? WHERE id=?`,
    );
    const anchorInsert = this.db.prepare(
      `INSERT OR REPLACE INTO memory_anchors
         (observation_id, node_id, role, anchor_label, anchor_file, anchor_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const writeAnchors = (obsId: string, anchors: ExportedAnchor[]): void => {
      this.db.prepare(`DELETE FROM memory_anchors WHERE observation_id = ?`).run(obsId);
      for (const a of anchors) {
        anchorInsert.run(obsId, a.nodeId, a.role, a.anchorLabel ?? null, a.anchorFile ?? null, a.anchorHash ?? null, a.createdAt);
      }
    };

    // Newer wins, deterministically: higher revision, then later updatedAt.
    const isNewer = (a: { revision: number; updatedAt: number }, b: { revision: number; updatedAt: number }): boolean =>
      a.revision > b.revision || (a.revision === b.revision && a.updatedAt > b.updatedAt);

    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        const existing = this.get(item.id);
        if (existing) {
          if (!isNewer(item, existing)) {
            report.skippedOlder++;
            continue;
          }
          updateStmt.run(
            item.scope, item.type, item.title, item.content, item.topicKey ?? null,
            item.sessionId ?? null, item.createdAt, item.updatedAt, item.revision,
            item.supersededBy ?? null, item.id,
          );
          writeAnchors(item.id, item.anchors);
          report.updated++;
          continue;
        }

        // Live topic_key collision with a DIFFERENT local observation: resolve toward the
        // newer side; the loser becomes a superseded snapshot (keeps history, satisfies
        // the partial unique index which only covers live rows).
        const supersededBy = this.resolveTopicConflict(item, isNewer, report);

        insertStmt.run(
          item.id, this.projectKey, item.scope, item.type, item.title, item.content,
          item.topicKey ?? null, item.sessionId ?? null, item.createdAt, item.updatedAt,
          item.revision, supersededBy,
        );
        writeAnchors(item.id, item.anchors);
        report.inserted++;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return report;
  }

  close(): void {
    this.db.close();
  }

  // Build an observation/session id whose FIRST segment is the project key VERBATIM, so it keeps
  // the hyphenated form produced by deriveProjectKey and matches the stored project_key column.
  // The remaining segments are normalized by makeId. We can't route the project key through makeId
  // itself because makeId collapses hyphens to underscores (it is shared with graph node ids and
  // must keep that behavior).
  private scopedId(...parts: string[]): string {
    const tail = makeId(...parts);
    return tail.length > 0 ? `${this.projectKey}:${tail}` : this.projectKey;
  }

  // ---- _saveInTx (PURE helper — assumes a transaction is already open) -----
  // Contains the entire write logic of save() but with NO BEGIN/COMMIT/ROLLBACK.
  // Callers are responsible for wrapping with a transaction.

  private _saveInTx(input: ObservationInput, now?: number): { observation: Observation; evolved: boolean } {
    const ts = now ?? Date.now();
    const scope: Scope = input.scope ?? "project";
    const topicKey = input.topicKey ?? null;
    // Fall back to the active session when no explicit sessionId is provided.
    const resolvedSessionId = input.sessionId ?? this.activeSessionId ?? null;

    if (topicKey !== null) {
      // Check if a row already exists for this project+scope+topic_key
      // Only the LIVE revision owns the topic_key (superseded snapshots keep theirs
      // but are excluded from the partial unique index).
      const existing = this.db
        .prepare(
          "SELECT id FROM observations WHERE project_key=? AND scope=? AND topic_key=? AND superseded_by IS NULL",
        )
        .get(this.projectKey, scope, topicKey) as unknown as { id: string } | undefined;

      if (existing) return this._evolveLiveRow(existing.id, input, ts, resolvedSessionId);
    }

    return this._freshInsert(input, ts, scope, topicKey, resolvedSessionId);
  }

  // Evolve the LIVE row for an existing topic_key in place: snapshot the prior revision
  // (superseded → excluded from the unique index + search), then update the live row so its
  // id stays stable for durable references. Assumes a transaction is already open.
  private _evolveLiveRow(
    existingId: string,
    input: ObservationInput,
    ts: number,
    resolvedSessionId: string | null,
  ): { observation: Observation; evolved: boolean } {
    // Snapshot the about-to-be-replaced revision so its provenance survives.
    const old = this.db
      .prepare("SELECT * FROM observations WHERE id=?")
      .get(existingId) as unknown as ObsRow;
    const snapId = this.scopedId(
      old.type,
      old.topic_key ?? old.title,
      "snap",
      String(ts),
      randomUUID(),
    );
    this.db
      .prepare(
        `INSERT INTO observations
           (id, project_key, scope, type, title, content, topic_key, session_id,
            created_at, updated_at, revision, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapId,
        this.projectKey,
        old.scope,
        old.type,
        old.title,
        old.content,
        old.topic_key,
        old.session_id,
        old.created_at,
        old.updated_at,
        old.revision,
        existingId,
      );

    // Update the live row in place — id stable, revision++.
    this.db
      .prepare(
        `UPDATE observations
           SET title=?, content=?, type=?, updated_at=?, session_id=?,
               revision=revision+1
         WHERE id=?`,
      )
      .run(
        input.title,
        input.content,
        input.type,
        ts,
        resolvedSessionId,
        existingId,
      );

    // Save anchors (if any) — inside the same transaction. The new set REPLACES
    // the live row's anchors: stale anchors from the prior revision must not
    // linger, or the drift verdict would be computed over symbols this revision
    // no longer talks about.
    if (input.anchors && input.anchors.length > 0) {
      this.db
        .prepare("DELETE FROM memory_anchors WHERE observation_id=?")
        .run(existingId);
      this.insertAnchorsInTx(existingId, input.anchors, ts);
    }

    const updated = this.db
      .prepare("SELECT * FROM observations WHERE id=?")
      .get(existingId) as unknown as ObsRow | undefined;
    if (!updated) throw new Error(`invariant: observation ${existingId} missing after write`);
    return { observation: rowToObs(updated), evolved: true };
  }

  // Fresh insert (topic_key is null OR no existing row for that topic). Assumes a transaction
  // is already open. Include randomUUID() entropy to prevent UNIQUE PK collisions on
  // same-millisecond saves.
  private _freshInsert(
    input: ObservationInput,
    ts: number,
    scope: Scope,
    topicKey: string | null,
    resolvedSessionId: string | null,
  ): { observation: Observation; evolved: boolean } {
    const id = this.scopedId(
      input.type,
      topicKey ?? input.title,
      String(ts),
      randomUUID(),
    );

    this.db
      .prepare(
        `INSERT INTO observations
           (id, project_key, scope, type, title, content, topic_key, session_id,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        id,
        this.projectKey,
        scope,
        input.type,
        input.title,
        input.content,
        topicKey,
        resolvedSessionId,
        ts,
        ts,
      );

    if (input.anchors && input.anchors.length > 0) {
      this.insertAnchorsInTx(id, input.anchors, ts);
    }

    const inserted = this.db
      .prepare("SELECT * FROM observations WHERE id=?")
      .get(id) as unknown as ObsRow | undefined;
    if (!inserted) throw new Error(`invariant: observation ${id} missing after write`);
    return { observation: rowToObs(inserted), evolved: false };
  }

  // ---- save -----------------------------------------------------------------

  save(input: ObservationInput): { observation: Observation; evolved: boolean } {
    this.db.exec("BEGIN");
    try {
      const result = this._saveInTx(input);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- _updateInTx (PURE helper — assumes a transaction is already open) ---
  // Contains the entire write logic of update() but with NO BEGIN/COMMIT/ROLLBACK.
  // Callers are responsible for wrapping with a transaction.
  // Throws if the observation doesn't exist or is superseded.

  private _updateInTx(id: string, fields: UpdateFields, now?: number): Observation {
    const ts = now ?? Date.now();

    // Read-check (inside the caller's transaction is fine; throws are caught by caller).
    const existing = this.db
      .prepare("SELECT * FROM observations WHERE id=?")
      .get(id) as unknown as ObsRow | undefined;

    if (!existing) {
      throw new Error(`no observation with id ${id}`);
    }
    if (existing.superseded_by !== null) {
      throw new Error(`cannot update superseded snapshot ${id}`);
    }

    // Build SET clause dynamically — only mutate provided fields.
    type SqlParam = null | number | bigint | string | Uint8Array;
    const sets: string[] = ["updated_at=?"];
    const params: SqlParam[] = [ts];

    if (fields.title !== undefined) {
      sets.push("title=?");
      params.push(fields.title);
    }
    if (fields.content !== undefined) {
      sets.push("content=?");
      params.push(fields.content);
    }
    if (fields.type !== undefined) {
      sets.push("type=?");
      params.push(fields.type);
    }

    params.push(id); // WHERE id=?
    this.db
      .prepare(`UPDATE observations SET ${sets.join(", ")} WHERE id=?`)
      .run(...params);

    // Re-resolve anchors whenever the caller provides them — an anchors-only
    // update (re-anchoring a memory without touching its text) must not no-op.
    if (fields.anchors !== undefined) {
      this.db
        .prepare("DELETE FROM memory_anchors WHERE observation_id=?")
        .run(id);
      if (fields.anchors.length > 0) {
        this.insertAnchorsInTx(id, fields.anchors, ts);
      }
    }

    const updated = this.db
      .prepare("SELECT * FROM observations WHERE id=?")
      .get(id) as unknown as ObsRow | undefined;
    if (!updated) throw new Error(`invariant: observation ${id} missing after update`);
    return rowToObs(updated);
  }

  // ---- update ---------------------------------------------------------------

  // In-place partial update of a LIVE observation by id. Does NOT bump revision or
  // create a snapshot — that is the topic_key upsert path's job. This is a
  // correction verb: fix a typo, add detail, keeping the id stable.
  //
  // FTS re-index is FREE: the obs_au trigger fires AFTER UPDATE on live→live rows
  // (old.superseded_by IS NULL AND new.superseded_by IS NULL) and does delete+insert
  // into obs_fts automatically. No manual FTS code needed.
  update(id: string, fields: UpdateFields): Observation {
    // Normalize the presentation "#" prefix so a copy-pasted id from search/get
    // resolves the same way it does in get() (see stripIdPrefix).
    const nid = stripIdPrefix(id);

    // Read-check outside the transaction so error messages are clean.
    const existing = this.db
      .prepare("SELECT * FROM observations WHERE id=?")
      .get(nid) as unknown as ObsRow | undefined;

    if (!existing) {
      throw new Error(`no observation with id ${nid}`);
    }
    if (existing.superseded_by !== null) {
      throw new Error(`cannot update superseded snapshot ${nid}`);
    }

    this.db.exec("BEGIN");
    try {
      const result = this._updateInTx(nid, fields);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- batch helpers (shared by saveBatch / updateBatch) --------------------
  //
  // Atomic batches share one BEGIN/COMMIT across all items; on the first failure
  // they ROLLBACK and mark the failed position with its real error, every other
  // position with "rolled-back". Non-atomic batches give each item its own
  // BEGIN/COMMIT so a sibling's failure never discards a success.

  // Run every item through runItem, collecting successes in order; stop at the first
  // failure and capture its index + message. Pure book-keeping — no transaction control.
  private _collectAtomicResults<I, D>(
    items: I[],
    runItem: (item: I) => D,
  ): { successes: { index: number; data: D }[]; failedAt: number; failError: string } {
    const successes: { index: number; data: D }[] = [];
    let failedAt = -1;
    let failError = "";
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      try {
        const data = runItem(item);
        successes.push({ index: i, data });
      } catch (e) {
        failedAt = i;
        failError = (e as Error).message ?? String(e);
        break;
      }
    }
    return { successes, failedAt, failError };
  }

  // All succeeded — commit and emit ok results in their original positions.
  private _commitAtomicBatch<D>(
    successes: { index: number; data: D }[],
  ): BatchResult<D>[] {
    this.db.exec("COMMIT");
    const results: BatchResult<D>[] = [];
    for (const s of successes) {
      results[s.index] = { ok: true, data: s.data };
    }
    return results;
  }

  // At least one failed — rollback, mark the failed position with the real error,
  // all others with "rolled-back".
  private _rollbackAtomicBatch<D>(
    count: number,
    failedAt: number,
    failError: string,
  ): BatchResult<D>[] {
    this.db.exec("ROLLBACK");
    const results: BatchResult<D>[] = [];
    for (let i = 0; i < count; i++) {
      results[i] = i === failedAt
        ? { ok: false, error: failError }
        : { ok: false, error: "rolled-back" };
    }
    return results;
  }

  // Run a whole batch inside a single BEGIN/COMMIT.
  private _runBatchAtomic<I, D>(
    items: I[],
    runItem: (item: I) => D,
  ): BatchResult<D>[] {
    this.db.exec("BEGIN");
    try {
      const { successes, failedAt, failError } = this._collectAtomicResults(items, runItem);
      return failedAt === -1
        ? this._commitAtomicBatch<D>(successes)
        : this._rollbackAtomicBatch<D>(items.length, failedAt, failError);
    } catch {
      // Unexpected error (e.g. ROLLBACK itself failed) — ensure all positions filled.
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      const results: BatchResult<D>[] = [];
      for (let i = 0; i < items.length; i++) {
        results[i] ??= { ok: false, error: "rolled-back" };
      }
      return results;
    }
  }

  // Run a single item in its own BEGIN/COMMIT, mapping the outcome to a BatchResult.
  private _runItemInTx<D>(runItem: () => D): BatchResult<D> {
    this.db.exec("BEGIN");
    try {
      const data = runItem();
      this.db.exec("COMMIT");
      return { ok: true, data };
    } catch (e) {
      this.db.exec("ROLLBACK");
      return { ok: false, error: (e as Error).message ?? String(e) };
    }
  }

  // Pre-check (outside any transaction) that an observation exists and is live, for
  // clean error messages — returns the error string, or null when updatable.
  private _updatableError(id: string): string | null {
    const existing = this.db
      .prepare("SELECT * FROM observations WHERE id=?")
      .get(id) as unknown as ObsRow | undefined;
    if (!existing) {
      return `no observation with id ${id}`;
    }
    if (existing.superseded_by !== null) {
      return `cannot update superseded snapshot ${id}`;
    }
    return null;
  }

  // ---- saveBatch ------------------------------------------------------------

  saveBatch(
    items: ObservationInput[],
    opts?: { atomic?: boolean },
  ): BatchResult<{ observation: Observation; evolved: boolean }>[] {
    const atomic = opts?.atomic ?? false;

    // Atomic: single BEGIN/COMMIT wrapping all items.
    if (atomic) {
      return this._runBatchAtomic(items, (item) => this._saveInTx(item));
    }

    // Non-atomic: each item gets its own BEGIN/COMMIT.
    return items.map((item) => this._runItemInTx(() => this._saveInTx(item)));
  }

  // ---- updateBatch ----------------------------------------------------------

  updateBatch(
    items: { id: string; fields: UpdateFields }[],
    opts?: { atomic?: boolean },
  ): BatchResult<Observation>[] {
    const atomic = opts?.atomic ?? false;

    if (atomic) {
      return this._runBatchAtomic(items, (item) => this._updateInTx(stripIdPrefix(item.id), item.fields));
    }

    // Non-atomic: pre-check outside transaction for clean error messages (same as
    // update()), then each item gets its own BEGIN/COMMIT.
    return items.map((item) => {
      const nid = stripIdPrefix(item.id);
      const precheckError = this._updatableError(nid);
      if (precheckError !== null) {
        return { ok: false, error: precheckError };
      }
      return this._runItemInTx(() => this._updateInTx(nid, item.fields));
    });
  }

  // ---- getBatch -------------------------------------------------------------

  getBatch(ids: string[]): BatchResult<Observation>[] {
    return ids.map((id) => {
      const obs = this.get(id);
      if (!obs) {
        return { ok: false, error: "not found" };
      }
      return { ok: true, data: obs };
    });
  }

  // Called inside an already-open transaction (BEGIN in save()).
  // Resolves each label to the real graph node ID(s) it names so the anchor points
  // at something the graph actually contains (node_id = composite graph ID, not the
  // raw label). Unresolved labels are still stored (node_id = raw label, anchor_file
  // null) so the user's intent is never lost — they surface as unverified anchors.
  private insertAnchorsInTx(observationId: string, anchors: string[], now: number): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO memory_anchors
         (observation_id, node_id, role, anchor_label, anchor_file, anchor_hash, created_at)
       VALUES (?, ?, 'about', ?, ?, ?, ?)`,
    );
    for (const label of anchors) {
      const matches = this.resolveAnchor(label);
      if (matches.length > 0) {
        for (const m of matches) {
          stmt.run(observationId, m.nodeId, label, m.sourceFile, m.fileHash ?? null, now);
        }
      } else {
        // Graph not built, or the label names nothing. Keep the intent, mark unresolved.
        stmt.run(observationId, label, label, null, null, now);
      }
    }
  }

  // ---- search ---------------------------------------------------------------

  search(
    query: string,
    opts?: { scope?: Scope; type?: ObservationType; limit?: number },
  ): SearchHit[] {
    const scope = opts?.scope ?? null;
    const type = opts?.type ?? null;
    const limit = opts?.limit ?? 10;

    if (!this.fts5) {
      return this._searchLike(query, scope, type, limit);
    }

    // FTS5 branch: BM25 ranking + native snippet, behind the SAME deterministic
    // precedence the LIKE branch applies (exact topic_key > literal query in title >
    // literal query in content). BM25 alone is NOT enough here: porter stemming maps
    // e.g. "validation" and "valid" to the same root, so `validation_rules` and
    // `valid_names` produce near-identical scores whose order then depends on the
    // bundled SQLite build (pf-2 flipped between ubuntu/macos/windows runners on CI).
    // The CASE rank pins the exact match first on every platform; BM25 and recency
    // only break ties within the same precedence band.
    const matchQuery = sanitizeMatchQuery(query);
    const normalizedQuery = query.trim().toLowerCase();
    const topicForm = normalizedQuery.replaceAll(/\s+/g, "_");
    const sql = `
      SELECT o.id, o.title, o.type, o.topic_key, o.updated_at, o.scope,
             snippet(obs_fts, 1, '[', ']', ' … ', 12) AS snippet,
             bm25(obs_fts, 5.0, 1.0) AS score
        FROM obs_fts
        JOIN observations o ON o.rowid = obs_fts.rowid
       WHERE obs_fts MATCH ?
         AND o.project_key = ?
         AND o.superseded_by IS NULL
         AND (? IS NULL OR o.scope = ?)
         AND (? IS NULL OR o.type = ?)
       ORDER BY CASE
             WHEN lower(coalesce(o.topic_key, '')) = ? THEN 0
             WHEN instr(lower(o.title), ?) > 0 THEN 1
             WHEN instr(lower(o.content), ?) > 0 THEN 2
             ELSE 3
           END,
           score, o.updated_at DESC
       LIMIT ?
    `;

    let rows = this.db
      .prepare(sql)
      .all(
        matchQuery, this.projectKey, scope, scope, type, type,
        topicForm, normalizedQuery, normalizedQuery, limit,
      ) as unknown as SearchRow[];

    // Zero exact hits → one prefix-match retry for recall (cross-language roots, suffix
    // typos). Only on empty results, so precision of the primary path is untouched.
    if (rows.length === 0) {
      const fallback = prefixMatchQuery(query);
      if (fallback !== null) {
        rows = this.db
          .prepare(sql)
          .all(
            fallback, this.projectKey, scope, scope, type, type,
            topicForm, normalizedQuery, normalizedQuery, limit,
          ) as unknown as SearchRow[];
      }
    }

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type as ObservationType,
      topicKey: r.topic_key ?? undefined,
      snippet: r.snippet,
      score: r.score,
      updatedAt: r.updated_at,
      scope: r.scope as Scope,
    }));
  }

  // LIKE-mode search: substring token matching, JS snippet, deterministic rank
  // (exact topic_key > term in title > term in content) with updated_at DESC as the
  // final tie-break, plus the same zero-hit prefix-retry the FTS5 branch has.
  // No stemming or BM25 — this is a deliberate quality/performance trade-off for
  // Node builds without FTS5. The caller sees the same SearchHit shape as FTS5.
  private _searchLike(
    query: string,
    scope: string | null,
    type: string | null,
    limit: number,
  ): SearchHit[] {
    const tokens = buildLikeTokens(query);
    if (tokens.length === 0) {
      // Empty query: return the most recently updated live observations (no text filter).
      const rows = this.db
        .prepare(
          `SELECT id, title, type, topic_key, updated_at, scope, content
             FROM observations
            WHERE project_key = ?
              AND superseded_by IS NULL
              AND (? IS NULL OR scope = ?)
              AND (? IS NULL OR type = ?)
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(this.projectKey, scope, scope, type, type, limit) as unknown as ObsRow[];
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type as ObservationType,
        topicKey: r.topic_key ?? undefined,
        snippet: r.content.length > 160 ? `${r.content.slice(0, 160)  } …` : r.content,
        score: 0,
        updatedAt: r.updated_at,
        scope: r.scope as Scope,
      }));
    }

    // Deterministic precedence (mirrors what BM25 gives the FTS5 branch): an exact
    // topic_key match outranks everything, then the full query term in the TITLE,
    // then in the CONTENT, and only then recency as the FINAL tie-break. Without
    // this rank, ORDER BY updated_at DESC alone let a NEWER partial match beat an
    // OLDER exact one (pf-2: `valid_names` created 1ms later outranked the exact
    // `validation_rules`).
    const normalizedQuery = query.trim().toLowerCase();
    const topicForm = normalizedQuery.replaceAll(/\s+/g, "_");
    const phrasePattern = `%${normalizedQuery}%`;
    const rankExpr = `CASE
          WHEN lower(coalesce(o.topic_key, '')) = ? THEN 0
          WHEN lower(o.title) LIKE ? THEN 1
          WHEN lower(o.content) LIKE ? THEN 2
          ELSE 3
        END`;

    // Build the LIKE filter: (lower(title) LIKE ? OR lower(content) LIKE ?) per token,
    // all tokens joined with OR (any token match is a hit — recall-oriented).
    const runLike = (patterns: string[]): ObsRow[] => {
      const clauses = patterns.map(() => "(lower(o.title) LIKE ? OR lower(o.content) LIKE ?)").join(" OR ");
      const sql = `
        SELECT o.id, o.title, o.type, o.topic_key, o.updated_at, o.scope, o.content
          FROM observations o
         WHERE o.project_key = ?
           AND o.superseded_by IS NULL
           AND (? IS NULL OR o.scope = ?)
           AND (? IS NULL OR o.type = ?)
           AND (${clauses})
         ORDER BY ${rankExpr}, o.updated_at DESC
         LIMIT ?
      `;
      return this.db
        .prepare(sql)
        .all(
          this.projectKey,
          scope,
          scope,
          type,
          type,
          ...patterns.flatMap((p) => [p, p]),
          topicForm,
          phrasePattern,
          phrasePattern,
          limit,
        ) as unknown as ObsRow[];
    };

    let rows = runLike(tokens);
    let matchedTokens = tokens;

    // Zero exact hits → one prefix-match retry for recall (cross-language roots, suffix
    // typos) — the LIKE twin of the FTS5 branch's prefixMatchQuery fallback. Only on
    // empty results, so precision of the primary path is untouched.
    if (rows.length === 0) {
      const prefixTokens = buildLikePrefixTokens(query);
      if (prefixTokens.length > 0) {
        rows = runLike(prefixTokens);
        matchedTokens = prefixTokens;
      }
    }

    const rawTokens = matchedTokens.map((t) => t.replaceAll("%", ""));
    return rows.map((r) => {
      // Synthetic score: number of tokens matching in the title (higher = more relevant).
      // Actual ordering is by updated_at DESC; this score is informational only.
      const titleLower = r.title.toLowerCase();
      const score = rawTokens.filter((t) => titleLower.includes(t)).length;
      return {
        id: r.id,
        title: r.title,
        type: r.type as ObservationType,
        topicKey: r.topic_key ?? undefined,
        snippet: buildLikeSnippet(r.content, matchedTokens),
        score,
        updatedAt: r.updated_at,
        scope: r.scope as Scope,
      };
    });
  }

  // ---- get ------------------------------------------------------------------

  get(id: string): Observation | undefined {
    const r = this.db
      .prepare("SELECT * FROM observations WHERE id=?")
      .get(stripIdPrefix(id)) as unknown as ObsRow | undefined;
    return r ? rowToObs(r) : undefined;
  }

  // ---- recentContext --------------------------------------------------------

  recentContext(
    opts?: { scope?: Scope; limit?: number; sessionLimit?: number },
  ): { sessions: Session[]; observations: Observation[] } {
    const scope = opts?.scope ?? null;
    const limit = opts?.limit ?? 20;
    const sessionLimit = opts?.sessionLimit ?? 5;

    const sessionRows = this.db
      .prepare(
        `SELECT * FROM sessions
          WHERE project_key=?
            AND (? IS NULL OR scope=?)
          ORDER BY started_at DESC
          LIMIT ?`,
      )
      .all(this.projectKey, scope, scope, sessionLimit) as unknown as SessionRow[];

    const obsRows = this.db
      .prepare(
        `SELECT * FROM observations
          WHERE project_key=?
            AND superseded_by IS NULL
            AND (? IS NULL OR scope=?)
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(this.projectKey, scope, scope, limit) as unknown as ObsRow[];

    return {
      sessions: sessionRows.map(rowToSession),
      observations: obsRows.map(rowToObs),
    };
  }

  // ---- sessions -------------------------------------------------------------

  startSession(title?: string, scope?: Scope): Session {
    const now = Date.now();
    const id = this.scopedId("session", String(now), randomUUID());
    const resolvedScope: Scope = scope ?? "project";

    this.db
      .prepare(
        `INSERT INTO sessions (id, project_key, scope, title, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, this.projectKey, resolvedScope, title ?? null, now);

    this.activeSessionId = id;

    const r = this.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(id) as unknown as SessionRow;
    return rowToSession(r);
  }

  saveSession(
    summary: string,
    opts?: { sessionId?: string; title?: string; scope?: Scope },
  ): Session {
    const now = Date.now();
    const scope: Scope = opts?.scope ?? "project";

    // Use provided sessionId, active session, or create a new one
    let sessionId = opts?.sessionId ?? this.activeSessionId;

    if (sessionId) {
      // End existing session with summary
      this.db
        .prepare(
          `UPDATE sessions SET summary=?, ended_at=?, title=COALESCE(?, title) WHERE id=?`,
        )
        .run(summary, now, opts?.title ?? null, sessionId);
    } else {
      // Create + summarize in one step
      sessionId = this.scopedId("session", String(now), randomUUID());
      this.db
        .prepare(
          `INSERT INTO sessions (id, project_key, scope, title, summary, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, this.projectKey, scope, opts?.title ?? null, summary, now, now);
    }

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }

    const r = this.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(sessionId) as unknown as SessionRow;
    return rowToSession(r);
  }

  // ---- anchors --------------------------------------------------------------

  anchorsForNode(nodeId: string): {
    observationId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
  }[] {
    interface AnchorRow {
      observation_id: string;
      role: string;
      anchor_label: string | null;
      anchor_file: string | null;
    }
    const rows = this.db
      .prepare(
        `SELECT observation_id, role, anchor_label, anchor_file
           FROM memory_anchors WHERE node_id=?`,
      )
      .all(nodeId) as unknown as AnchorRow[];
    return rows.map((r) => ({
      observationId: r.observation_id,
      role: r.role,
      anchorLabel: r.anchor_label ?? undefined,
      anchorFile: r.anchor_file ?? undefined,
    }));
  }

  // Anchors for a given observation, including the save-time file hash. Drift
  // detection reads these and compares anchor_hash against the file's current hash.
  // An anchor with anchor_file === undefined was never resolved to a real graph node.
  anchorsForObservation(observationId: string): {
    nodeId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
    anchorHash?: string;
  }[] {
    interface AnchorRow {
      node_id: string;
      role: string;
      anchor_label: string | null;
      anchor_file: string | null;
      anchor_hash: string | null;
    }
    const rows = this.db
      .prepare(
        `SELECT node_id, role, anchor_label, anchor_file, anchor_hash
           FROM memory_anchors WHERE observation_id=?`,
      )
      .all(observationId) as unknown as AnchorRow[];
    return rows.map((r) => ({
      nodeId: r.node_id,
      role: r.role,
      anchorLabel: r.anchor_label ?? undefined,
      anchorFile: r.anchor_file ?? undefined,
      anchorHash: r.anchor_hash ?? undefined,
    }));
  }

  // Up to `limit` LIVE observations anchored to `nodeId`, newest first. JOINs
  // memory_anchors to observations to sort/limit by updated_at — anchorsForNode alone
  // carries no timestamp and is deliberately left unordered/unbounded for its call sites.
  recentAnchoredObservations(nodeId: string, limit: number): {
    observationId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
    updatedAt: number;
  }[] {
    interface Row {
      observation_id: string;
      role: string;
      anchor_label: string | null;
      anchor_file: string | null;
      updated_at: number;
    }
    const rows = this.db
      .prepare(
        `SELECT ma.observation_id, ma.role, ma.anchor_label, ma.anchor_file, o.updated_at
           FROM memory_anchors ma
           JOIN observations o ON o.id = ma.observation_id
          WHERE ma.node_id = ? AND o.superseded_by IS NULL
          ORDER BY o.updated_at DESC
          LIMIT ?`,
      )
      .all(nodeId, limit) as unknown as Row[];
    return rows.map((r) => ({
      observationId: r.observation_id,
      role: r.role,
      anchorLabel: r.anchor_label ?? undefined,
      anchorFile: r.anchor_file ?? undefined,
      updatedAt: r.updated_at,
    }));
  }

  // Additive counterpart to insertAnchorsInTx: INSERT OR IGNORE against the
  // (observation_id, node_id, role) primary key, so anchors already present are silently
  // skipped rather than replaced. Anchors passed in are already resolved+verified by the
  // caller (application/memory/reanchor.ts) — this method never re-resolves labels itself.
  // Returns how many rows this call actually inserted (used to compute the "minted" count
  // in reanchor's report without a second existence check).
  addAnchorsIfMissing(
    observationId: string,
    anchors: {
      nodeId: string;
      role?: string;
      anchorLabel?: string;
      anchorFile?: string;
      anchorHash?: string;
    }[],
  ): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO memory_anchors
         (observation_id, node_id, role, anchor_label, anchor_file, anchor_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    let inserted = 0;
    for (const a of anchors) {
      const result = stmt.run(
        observationId,
        a.nodeId,
        a.role ?? "about",
        a.anchorLabel ?? null,
        a.anchorFile ?? null,
        a.anchorHash ?? null,
        now,
      ) as { changes: number };
      if (result.changes > 0) inserted += 1;
    }
    return inserted;
  }

  // ---- suggestTopicKeyWithMatches -------------------------------------------

  // Pure read. Normalizes title+type to a topic_key candidate (via the static
  // formatter), then ranks existing live topic_keys by token-set overlap (Jaccard
  // on `-`/`/`-split tokens) and returns the top 3 with overlap > 0.
  suggestTopicKeyWithMatches(
    title: string,
    type: string,
    scope?: Scope,
  ): TopicKeySuggestion {
    const suggestion = SQLiteMemoryRepository.suggestTopicKey(title, type);
    const resolvedScope: Scope = scope ?? "project";

    // SELECT DISTINCT live topic_keys for this project+scope.
    const rows = this.db
      .prepare(
        `SELECT DISTINCT topic_key FROM observations
          WHERE project_key=? AND scope=? AND topic_key IS NOT NULL AND superseded_by IS NULL`,
      )
      .all(this.projectKey, resolvedScope) as unknown as { topic_key: string }[];

    const suggestionTokens = tokenize(suggestion);

    const scored = rows
      .map((r) => ({
        key: r.topic_key,
        score: jaccard(suggestionTokens, tokenize(r.topic_key)),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.key);

    return { suggestion, nearMatches: scored };
  }

  // ---- mergeProject ---------------------------------------------------------
  //
  // Re-key all observations and sessions from `from` to `to` in a single transaction.
  // Topic-key collisions (both from+to have a live row with the same scope+topic_key) are
  // resolved by marking the `from` live row superseded — so only the `to` row owns the
  // topic. `dryRun=true` computes counts then rolls back (no writes).
  //
  // Guard: `from === to` throws (nothing to do, and the UPDATE would be a no-op).

  mergeProject(
    from: string,
    to: string,
    opts?: { dryRun?: boolean },
  ): { moved: number; superseded: number } {
    if (from === to) throw new Error("mergeProject: from and to must differ");
    const dryRun = opts?.dryRun ?? false;

    this.db.exec("BEGIN");
    try {
      // 1. Detect collisions: live rows in `from` whose (scope, topic_key) already
      //    has a live row in `to`.
      const collisions = this.db
        .prepare(
          `SELECT f.id AS from_id, t.id AS to_id
             FROM observations f
             JOIN observations t
               ON t.project_key = ? AND t.scope = f.scope AND t.topic_key = f.topic_key
                  AND t.superseded_by IS NULL
            WHERE f.project_key = ? AND f.superseded_by IS NULL AND f.topic_key IS NOT NULL`,
        )
        .all(to, from) as unknown as { from_id: string; to_id: string }[];

      // 2. Mark colliding `from` rows superseded (the `to` row wins).
      for (const c of collisions) {
        this.db
          .prepare("UPDATE observations SET superseded_by=? WHERE id=?")
          .run(c.to_id, c.from_id);
      }
      const superseded = collisions.length;

      // 3. Bulk re-key non-superseded rows.
      const movedObs = (
        this.db
          .prepare(
            "UPDATE observations SET project_key=? WHERE project_key=? AND superseded_by IS NULL",
          )
          .run(to, from) as { changes: number }
      ).changes;

      // 4. Re-key sessions (no topic_key collision possible on sessions).
      this.db.prepare("UPDATE sessions SET project_key=? WHERE project_key=?").run(to, from);

      const moved = movedObs;

      if (dryRun) {
        this.db.exec("ROLLBACK");
      } else {
        this.db.exec("COMMIT");
      }

      return { moved, superseded };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  // ---- importFromLegacy -----------------------------------------------------
  //
  // Copy observations + sessions + anchors from a LEGACY per-repo memory.db into THIS
  // (global) store, remapping `fromKey` → `toKey`. Idempotent via INSERT OR IGNORE on
  // stable TEXT PKs. Colliding live rows (same toKey+scope+topic_key already live in
  // global) are SKIPPED and counted — migration never overwrites newer global content.
  // The legacy DB is never written.
  //
  // Guard: if `legacyDbPath` does not exist, returns { moved: 0, skipped: 0 } (no-op).

  importFromLegacy(
    legacyDbPath: string,
    fromKey: string,
    toKey: string,
  ): { moved: number; skipped: number } {
    if (!existsSync(legacyDbPath)) return { moved: 0, skipped: 0 };

    let attached = false;
    try {
      // Attach legacy DB — we only SELECT from it (no writes to the legacy DB).
      this.db.exec(`ATTACH DATABASE '${legacyDbPath.replaceAll("'", "''")}' AS legacy`);
      attached = true;

      this.db.exec("BEGIN");
      try {
        // --- Observations ---
        // Collect legacy live rows that have a topic_key collision in the global DB.
        const collidingIds = new Set<string>(
          (
            this.db
              .prepare(
                `SELECT leg.id
                   FROM legacy.observations leg
                   JOIN observations gl
                     ON gl.project_key = ? AND gl.scope = leg.scope
                        AND gl.topic_key = leg.topic_key AND gl.superseded_by IS NULL
                  WHERE leg.project_key = ? AND leg.superseded_by IS NULL AND leg.topic_key IS NOT NULL`,
              )
              .all(toKey, fromKey) as unknown as { id: string }[]
          ).map((r) => r.id),
        );

        // Import ALL rows (superseded snapshots + non-colliding live rows) with OR IGNORE.
        // For colliding live rows, we skip them (they collide on the unique partial index).
        // We handle them separately below, counting as 'skipped'.

        // Import non-colliding rows:
        const insertedObs = (
          this.db
            .prepare(
              `INSERT OR IGNORE INTO observations
                 (id, project_key, scope, type, title, content, topic_key, session_id,
                  created_at, updated_at, revision, superseded_by)
               SELECT id, ?, scope, type, title, content,
                      topic_key, session_id, created_at, updated_at, revision, superseded_by
                 FROM legacy.observations
                WHERE project_key = ? AND id NOT IN (${collidingIds.size > 0 ? [...collidingIds].map(() => "?").join(",") : "SELECT 'x' WHERE 0"})`,
            )
            .run(toKey, fromKey, ...(collidingIds.size > 0 ? [...collidingIds] : [])) as {
            changes: number;
          }
        ).changes;

        const skipped = collidingIds.size;

        // --- Sessions ---
        this.db
          .prepare(
            `INSERT OR IGNORE INTO sessions
               (id, project_key, scope, title, summary, started_at, ended_at)
             SELECT id, ?, scope, title, summary, started_at, ended_at
               FROM legacy.sessions
              WHERE project_key = ?`,
          )
          .run(toKey, fromKey);

        // --- Anchors (for observations that were actually inserted) ---
        // Only import anchors for observations that now exist in the global DB under toKey.
        this.db
          .prepare(
            `INSERT OR IGNORE INTO memory_anchors
               (observation_id, node_id, role, anchor_label, anchor_file, anchor_hash, created_at)
             SELECT a.observation_id, a.node_id, a.role,
                    a.anchor_label, a.anchor_file, a.anchor_hash, a.created_at
               FROM legacy.memory_anchors a
               JOIN observations o ON o.id = a.observation_id AND o.project_key = ?`,
          )
          .run(toKey);

        this.db.exec("COMMIT");
        return { moved: insertedObs, skipped };
      } catch (e) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      }
    } finally {
      if (attached) {
        try { this.db.exec("DETACH DATABASE legacy"); } catch { /* ignore */ }
      }
    }
  }

  // ---- static helpers -------------------------------------------------------

  static suggestTopicKey(title: string, type: string): string {
    return `${type}/${normalizeLabel(title).replaceAll("_", "-")}`;
  }
}

// ---------------------------------------------------------------------------
// countLiveObservationsByKey — orphan-key diagnostic (standalone, read-only)
// ---------------------------------------------------------------------------

/**
 * Count LIVE (non-superseded) observations per project key in the global
 * memory DB. Standalone on purpose: SQLiteMemoryRepository is scoped to a
 * single project key, but the orphan-key hint needs to peek at keys this repo
 * *used to* resolve to. Read-only open, no schema side effects; a missing DB
 * (or any sqlite error) yields zero counts — this feeds a diagnostic hint and
 * must never break the command using it.
 */
export function countLiveObservationsByKey(
  dbPath: string,
  keys: string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  if (keys.length === 0 || !existsSync(dbPath)) return counts;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const placeholders = keys.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT project_key, COUNT(*) AS n FROM observations
            WHERE project_key IN (${placeholders}) AND superseded_by IS NULL
            GROUP BY project_key`,
        )
        .all(...keys) as unknown as { project_key: string; n: number }[];
      for (const r of rows) counts.set(r.project_key, r.n);
    } finally {
      db.close();
    }
  } catch {
    // fail-open: diagnostic only
  }
  return counts;
}
