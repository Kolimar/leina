// SQLiteMemoryRepository — MemoryRepository adapter backed by node:sqlite.
// Owns the single DatabaseSync handle for memory.db (separate from graph.db).
// FTS5 rides the implicit rowid; all search JOINs use rowid, NEVER the TEXT id column.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { makeId, normalizeLabel } from "../../domain/shared/id.ts";
import { ensureMemorySchema, OBS_FTS_DDL } from "./schema.ts";
import {
  foldText,
  likeRelevance,
  prefixTiers,
  queryTokens,
  rankSearchCandidates,
  type RankCandidate,
} from "../../domain/memory/search-rank.ts";
import type { CompactOptions, CompactReport } from "../../application/memory/compact.ts";
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
import {
  InvalidMemoryValueError,
  matchesShortId,
  SHORT_ID_RE,
  parseObservationStatus,
  parseObservationType,
  parseScope,
  type ObservationStatus,
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
  status: string;
  status_changed_at: number | null;
  resolution: string | null;
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
  status: string;
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

// Merge ordering of one observation version (import / sync): see isNewer in importObservations.
interface RowVersion {
  revision: number;
  updatedAt: number;
  statusChangedAt?: number;
}

interface VersionRow {
  revision: number;
  updated_at: number;
  status_changed_at: number | null;
}

function versionOf(r: VersionRow): RowVersion {
  return { revision: r.revision, updatedAt: r.updated_at, statusChangedAt: r.status_changed_at ?? undefined };
}

type SqlParam = null | number | bigint | string | Uint8Array;

// SET fragments for the lifecycle part of an update. A status change stamps
// status_changed_at; going back to `active` clears the resolution unless a new one is
// given. A resolution is only meaningful on a resolved/obsolete note, so pairing one with
// an active result is rejected rather than silently stored.
function statusSets(existing: ObsRow, fields: UpdateFields, ts: number): { sets: string[]; params: SqlParam[] } {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  const next = fields.status === undefined ? (existing.status as ObservationStatus) : parseObservationStatus(fields.status);
  if (fields.resolution !== undefined && next === "active") {
    throw new InvalidMemoryValueError("a resolution note needs status resolved or obsolete");
  }
  if (fields.status !== undefined && next !== existing.status) {
    sets.push("status=?", "status_changed_at=?");
    params.push(next, ts);
    if (next === "active" && fields.resolution === undefined) sets.push("resolution=NULL");
  }
  if (fields.resolution !== undefined) {
    sets.push("resolution=?");
    params.push(fields.resolution);
  }
  return { sets, params };
}

// True when an update carries only lifecycle fields: such an update must not bump
// updated_at, or resolving a note would push it to the top of every recency ordering.
function isStatusOnly(fields: UpdateFields): boolean {
  const lifecycle = fields.status !== undefined || fields.resolution !== undefined;
  const content =
    fields.title !== undefined || fields.content !== undefined || fields.type !== undefined || fields.anchors !== undefined;
  return lifecycle && !content;
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
    status: r.status as ObservationStatus,
  };
  if (r.topic_key) o.topicKey = r.topic_key;
  if (r.session_id) o.sessionId = r.session_id;
  if (r.superseded_by) o.supersededBy = r.superseded_by;
  if (r.status_changed_at !== null) o.statusChangedAt = r.status_changed_at;
  if (r.resolution !== null) o.resolution = r.resolution;
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
 * The FTS5 form of one prefix-fallback tier (see prefixTiers in domain/memory/search-rank):
 * `"pagin"* OR "vali"*`. Catches cross-language technical roots ("paginacion" → pagin* →
 * "pagination", "validación" → valid* → "validation") and light typos in the suffix, at zero
 * dependency cost.
 */
function prefixMatchQuery(prefixes: string[]): string {
  return prefixes.map((p) => `"${p.replaceAll('"', '""')}"*`).join(" OR ");
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

// Build a snippet (similar to FTS5's snippet() function) from content by finding the
// first occurrence of any (accent-folded) term and extracting ~80 characters of context
// around it, the match wrapped in [ ] like the FTS5 branch's snippets. Folding keeps
// offsets for the usual precomposed text; when it does not (rare case-mapping expansions)
// or nothing matches, the snippet is the content's first 160 chars.
function buildLikeSnippet(content: string, terms: string[]): string {
  const plain = (): string => (content.length > 160 ? `${content.slice(0, 160)} …` : content);
  const folded = foldText(content);
  if (folded.length !== content.length) return plain();
  let bestIdx = -1;
  let bestLen = 0;
  for (const t of terms) {
    const idx = folded.indexOf(t);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestLen = t.length;
    }
  }
  if (bestIdx === -1) return plain();
  const start = Math.max(0, bestIdx - 40);
  const end = Math.min(content.length, bestIdx + bestLen + 40);
  const highlighted = `${content.slice(start, bestIdx)}[${content.slice(bestIdx, bestIdx + bestLen)}]${content.slice(bestIdx + bestLen, end)}`;
  const prefix = start > 0 ? " … " : "";
  const suffix = end < content.length ? " … " : "";
  return prefix + highlighted + suffix;
}

interface SearchFilters {
  scope: string | null;
  type: string | null;
  pool: number;
}

interface SearchCandidate extends RankCandidate {
  type: ObservationType;
  scope: Scope;
  /** FTS5's own snippet; LIKE candidates build theirs from `matchTerms`. */
  snippet?: string;
  matchTerms: string[];
}

function searchRowFields(r: {
  id: string;
  title: string;
  type: string;
  topic_key: string | null;
  updated_at: number;
  scope: string;
  status: string;
  content: string;
}): Omit<SearchCandidate, "relevance" | "tier" | "matchTerms"> {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    type: r.type as ObservationType,
    topicKey: r.topic_key ?? undefined,
    updatedAt: r.updated_at,
    scope: r.scope as Scope,
    status: r.status as ObservationStatus,
  };
}

export class SQLiteMemoryRepository implements MemoryRepository {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly projectKey: string;
  // Whether FTS5 was available when this repository was opened. Propagated from
  // ensureMemorySchema so we never probe twice.
  private readonly fts5: boolean;
  // Track the active session id (one per MemoryStore instance / server process)
  private activeSessionId: string | null = null;
  // Resolves anchor labels to real graph node IDs. Defaults to a no-op resolver
  // (labels stay unresolved) when no graph is wired in — e.g. the CLI.
  private readonly resolveAnchor: AnchorResolver = () => [];

  constructor(memPath: string, projectKey: string, resolveAnchor?: AnchorResolver, opts?: { readOnly?: boolean }) {
    mkdirSync(dirname(memPath), { recursive: true });
    this.db = new DatabaseSync(memPath);
    this.dbPath = memPath;
    // Same rationale as GraphStore: wait for a concurrent writer instead of failing
    // immediately with SQLITE_BUSY (the global memory.db is shared across processes).
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    // ensureMemorySchema is kept even in read-only mode: memory.db is the GLOBAL store,
    // so a project the caller has never written memory for still needs its tables to
    // exist or every read throws "no such table". Schema DDL is idempotent (a no-op on an
    // already-initialised db).
    const { fts5 } = ensureMemorySchema(this.db);
    this.fts5 = fts5;
    // Accent/case folding for the LIKE search path ("publicacion" finds "publicación").
    this.db.function("leina_fold", { deterministic: true }, (v) => (typeof v === "string" ? foldText(v) : v));
    this.projectKey = projectKey;
    if (resolveAnchor) this.resolveAnchor = resolveAnchor;
    // Read-only hardening for `graph serve` (defense in depth): after the schema is
    // guaranteed, flip the connection to query_only so any write attempted by a read
    // endpoint fails in-band with SQLITE_READONLY. Construction (schema) may write; the
    // request handlers may not. See GraphStore's readOnly branch for the same contract.
    if (opts?.readOnly) this.db.exec("PRAGMA query_only = ON;");
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
    isNewer: (a: RowVersion, b: RowVersion) => boolean,
    report: ImportReport,
  ): string | null {
    const inherited = item.supersededBy ?? null;
    if (item.topicKey === undefined || inherited !== null) return inherited;
    const local = this.db
      .prepare(
        `SELECT id, revision, updated_at, status_changed_at FROM observations
           WHERE project_key=? AND scope=? AND topic_key=? AND superseded_by IS NULL`,
      )
      .get(this.projectKey, item.scope, item.topicKey) as unknown as
      (VersionRow & { id: string }) | undefined;
    if (local === undefined) return null;
    report.topicConflicts++;
    if (isNewer(item, versionOf(local))) {
      this.db.prepare(`UPDATE observations SET superseded_by=? WHERE id=?`).run(item.id, local.id);
      return null;
    }
    return local.id;
  }

  // The committable export carries superseded snapshots, so without this rule every
  // `memory sync` after `memory compact` re-inserted the history compact had just removed.
  // An incoming snapshot this store does not have is skipped when the row it was
  // superseded by is here and has already moved past it: strictly older than our row,
  // it is history we compacted away (or never needed). At the SAME revision our row IS
  // that version, so the snapshot is kept only when this import is about to overwrite
  // the row (`incomingRevision` = highest revision the batch carries per id). A store
  // without the row (a fresh machine) still receives the full history.
  private _isPassedSnapshot(item: ExportedObservation, incomingRevision: Map<string, number>): boolean {
    if (item.supersededBy === undefined) return false;
    const target = this.db
      .prepare("SELECT revision FROM observations WHERE id=? AND project_key=?")
      .get(item.supersededBy, this.projectKey) as unknown as { revision: number } | undefined;
    if (target === undefined) return false;
    if (item.revision !== target.revision) return item.revision < target.revision;
    return (incomingRevision.get(item.supersededBy) ?? 0) <= target.revision;
  }

  // An imported entry may never claim to be newer than the moment it is imported: a
  // far-future updatedAt (year 2286) would pin it on top of every recency-ordered read
  // (SessionStart injection included) and win every later merge tie. createdAt never
  // follows updatedAt; anchors are clamped the same way.
  private static clampTimestamps(item: ExportedObservation, now: number): ExportedObservation {
    const updatedAt = Math.min(item.updatedAt, now);
    const clamped: ExportedObservation = {
      ...item,
      updatedAt,
      createdAt: Math.min(item.createdAt, updatedAt),
      anchors: item.anchors.map((a) => ({ ...a, createdAt: Math.min(a.createdAt, now) })),
    };
    if (item.statusChangedAt !== undefined) clamped.statusChangedAt = Math.min(item.statusChangedAt, now);
    return clamped;
  }

  importObservations(items: ExportedObservation[]): ImportReport {
    const report: ImportReport = { inserted: 0, updated: 0, skippedOlder: 0, skippedForeign: 0, topicConflicts: 0 };
    const insertStmt = this.db.prepare(
      `INSERT INTO observations
         (id, project_key, scope, type, title, content, topic_key, session_id,
          created_at, updated_at, revision, superseded_by, status, status_changed_at, resolution)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Scoped to this project: the guard below already skips foreign ids, and the
    // project_key predicate keeps the write confined even if that guard ever regresses.
    const updateStmt = this.db.prepare(
      `UPDATE observations SET scope=?, type=?, title=?, content=?, topic_key=?, session_id=?,
          created_at=?, updated_at=?, revision=?, superseded_by=?,
          status=?, status_changed_at=?, resolution=? WHERE id=? AND project_key=?`,
    );
    // Ids are globally unique across the shared memory.db, so the lookup is by id alone and
    // the owner decides: a row owned by ANOTHER project is never updated (a snapshot shipped
    // by a forked/hostile repo could otherwise rewrite that project's memory, which its
    // SessionStart then injects) and never re-inserted (the id is taken) — it is skipped
    // and reported.
    const ownerStmt = this.db.prepare(
      `SELECT project_key, revision, updated_at, status_changed_at FROM observations WHERE id = ?`,
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

    // Newer wins, deterministically: higher revision, then later updatedAt, then the later
    // status change — a resolve/reopen touches neither of the first two, and must still
    // travel through `memory sync` to the teammates who import it.
    const isNewer = (a: RowVersion, b: RowVersion): boolean =>
      a.revision > b.revision ||
      (a.revision === b.revision &&
        (a.updatedAt > b.updatedAt ||
          (a.updatedAt === b.updatedAt && (a.statusChangedAt ?? 0) > (b.statusChangedAt ?? 0))));

    const incomingRevision = new Map<string, number>();
    for (const i of items) incomingRevision.set(i.id, Math.max(incomingRevision.get(i.id) ?? 0, i.revision));
    // Snapshots first: _isPassedSnapshot must judge them against the rows as they were
    // BEFORE this import, not after the batch's own live rows were applied.
    const ordered = [
      ...items.filter((i) => i.supersededBy !== undefined),
      ...items.filter((i) => i.supersededBy === undefined),
    ];

    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      for (const raw of ordered) {
        const item = SQLiteMemoryRepository.clampTimestamps(raw, now);
        const owner = ownerStmt.get(item.id) as unknown as
          (VersionRow & { project_key: string }) | undefined;
        if (owner !== undefined && owner.project_key !== this.projectKey) {
          report.skippedForeign++;
          continue;
        }
        if (owner) {
          if (!isNewer(item, versionOf(owner))) {
            report.skippedOlder++;
            continue;
          }
          updateStmt.run(
            item.scope, item.type, item.title, item.content, item.topicKey ?? null,
            item.sessionId ?? null, item.createdAt, item.updatedAt, item.revision,
            item.supersededBy ?? null, item.status, item.statusChangedAt ?? null,
            item.resolution ?? null, item.id, this.projectKey,
          );
          writeAnchors(item.id, item.anchors);
          report.updated++;
          continue;
        }
        if (this._isPassedSnapshot(item, incomingRevision)) {
          report.skippedOlder++;
          continue;
        }

        // Live topic_key collision with a DIFFERENT local observation: resolve toward the
        // newer side; the loser becomes a superseded snapshot (keeps history, satisfies
        // the partial unique index which only covers live rows).
        const supersededBy = this.resolveTopicConflict(item, isNewer, report);

        insertStmt.run(
          item.id, this.projectKey, item.scope, item.type, item.title, item.content,
          item.topicKey ?? null, item.sessionId ?? null, item.createdAt, item.updatedAt,
          item.revision, supersededBy, item.status, item.statusChangedAt ?? null,
          item.resolution ?? null,
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

  private _saveInTx(raw: ObservationInput, now?: number): { observation: Observation; evolved: boolean } {
    const ts = now ?? Date.now();
    // Closed value sets are enforced HERE, at the one write path every transport (CLI,
    // batch, MCP, workspace federation) goes through: unvalidated `--type note` rows once
    // made `memory export` → `memory import` fail on a fresh machine.
    const input: ObservationInput = { ...raw, type: parseObservationType(raw.type) };
    const scope: Scope = parseScope(input.scope ?? "project");
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
            created_at, updated_at, revision, superseded_by, status, status_changed_at, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        old.status,
        old.status_changed_at,
        old.resolution,
      );

    // Update the live row in place — id stable, revision++. New content on a topic is
    // current knowledge again: a resolved/obsolete topic re-saved comes back `active`
    // (its snapshot above keeps the old status and resolution).
    const reactivated = old.status !== "active";
    this.db
      .prepare(
        `UPDATE observations
           SET title=?, content=?, type=?, updated_at=?, session_id=?,
               revision=revision+1, status='active', resolution=NULL,
               status_changed_at=CASE WHEN ? THEN ? ELSE status_changed_at END
         WHERE id=?`,
      )
      .run(
        input.title,
        input.content,
        input.type,
        ts,
        resolvedSessionId,
        reactivated ? 1 : 0,
        ts,
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
    // Project-scoped like every id-keyed verb here: another project's id reads as absent.
    const existing = this.db
      .prepare("SELECT * FROM observations WHERE id=? AND project_key=?")
      .get(id, this.projectKey) as unknown as ObsRow | undefined;

    if (!existing) {
      throw new Error(`no observation with id ${id}`);
    }
    if (existing.superseded_by !== null) {
      throw new Error(`cannot update superseded snapshot ${id}`);
    }

    // Build SET clause dynamically — only mutate provided fields.
    const lifecycle = statusSets(existing, fields, ts);
    const sets: string[] = isStatusOnly(fields) ? [] : ["updated_at=?"];
    const params: SqlParam[] = isStatusOnly(fields) ? [] : [ts];
    sets.push(...lifecycle.sets);
    params.push(...lifecycle.params);

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
      params.push(parseObservationType(fields.type));
    }

    params.push(id, this.projectKey); // WHERE id=? AND project_key=?
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE observations SET ${sets.join(", ")} WHERE id=? AND project_key=?`)
        .run(...params);
    }

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
    // Normalize the presentation "#" prefix / short id so a copy-pasted id from
    // search/get/context resolves the same way it does in get() (see resolveId).
    const nid = this.resolveId(id);

    // Read-check outside the transaction so error messages are clean.
    const precheckError = this._updatableError(nid);
    if (precheckError !== null) throw new Error(precheckError);

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

  // Pre-check (outside any transaction) that an observation exists IN THIS PROJECT and is
  // live, for clean error messages — returns the error string, or null when updatable.
  // Accepts what the CLI/MCP surfaces print: a full id (optionally "#"-prefixed) or the short
  // form `memory context` shows (the first hex chars of the uuid tail). A short id that names
  // exactly one observation of this project resolves to its full id; one that names none is
  // returned as-is (so the caller's "not found" stays the error); one that names several is an
  // error asking for more characters.
  private resolveId(raw: string): string {
    const id = stripIdPrefix(raw);
    if (!SHORT_ID_RE.test(id)) return id;
    const exact = this.db.prepare("SELECT 1 FROM observations WHERE id=? AND project_key=?").get(id, this.projectKey);
    if (exact !== undefined) return id;
    const rows = this.db
      .prepare("SELECT id FROM observations WHERE project_key=? AND instr(lower(id), ?) > 0")
      .all(this.projectKey, `:${id.toLowerCase()}`) as unknown as { id: string }[];
    const matches = rows.map((r) => r.id).filter((full) => matchesShortId(full, id));
    if (matches.length > 1) {
      throw new Error(`ambiguous short id ${id}: it matches ${matches.length} observations — use more characters or the full id`);
    }
    return matches[0] ?? id;
  }

  private _updatableError(id: string): string | null {
    const existing = this.db
      .prepare("SELECT * FROM observations WHERE id=? AND project_key=?")
      .get(id, this.projectKey) as unknown as ObsRow | undefined;
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
      return this._runBatchAtomic(items, (item) => this._updateInTx(this.resolveId(item.id), item.fields));
    }

    // Non-atomic: pre-check outside transaction for clean error messages (same as
    // update()), then each item gets its own BEGIN/COMMIT.
    return items.map((item) => {
      let nid: string;
      try {
        nid = this.resolveId(item.id);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
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
      let obs: Observation | undefined;
      try {
        obs = this.get(id);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
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
  //
  // Both back ends (FTS5, or LIKE on SQLite builds without it) gather a candidate pool with a
  // base relevance in [0, 1] and leave the ORDER to rankSearchCandidates()
  // (domain/memory/search-rank.ts): exact hits before prefix-fallback hits, active before
  // resolved/obsolete, then relevance + match boosts (exact topic key, topic family, phrase in
  // the title/content) + a small recency prior, ties by newest then id. When the exact hits
  // number fewer than `limit`, the prefix tiers (each token cut to ~60%, then to 4 chars) fill
  // the rest of the page — always below the exact hits. `score` is the final ranking score:
  // higher is better, in both modes.

  search(
    query: string,
    opts?: { scope?: Scope; type?: ObservationType; limit?: number },
  ): SearchHit[] {
    const scope = opts?.scope ?? null;
    const type = opts?.type ?? null;
    const limit = opts?.limit ?? 10;
    const tokens = queryTokens(query);
    if (tokens.length === 0) return this._recentAsHits(scope, type, limit);

    const pool = Math.min(Math.max(limit * 4, 40), 400);
    const filters: SearchFilters = { scope, type, pool };
    const corpus = this.fts5 ? 0 : this._liveCount(scope, type);
    const fetchTier = (terms: string[], tier: number, exact: boolean): SearchCandidate[] =>
      this.fts5
        ? this._ftsCandidates(exact ? sanitizeMatchQuery(query) : prefixMatchQuery(terms), query, tier, filters)
        : this._likeCandidates(terms, tier, filters, corpus);

    const candidates: SearchCandidate[] = [];
    const seen = new Set<string>();
    const collect = (rows: SearchCandidate[]): void => {
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        candidates.push(r);
      }
    };
    collect(fetchTier(tokens, 0, true));
    const tiers = prefixTiers(query);
    for (let i = 0; i < tiers.length && candidates.length < limit; i++) collect(fetchTier(tiers[i]!, i + 1, false));

    return rankSearchCandidates(candidates, query)
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        title: c.title,
        type: c.type,
        topicKey: c.topicKey,
        snippet: c.snippet ?? buildLikeSnippet(c.content, c.matchTerms),
        score: c.finalScore,
        updatedAt: c.updatedAt,
        scope: c.scope,
        status: c.status,
      }));
  }

  // FTS5 candidates for one MATCH expression. The SQL order only decides which rows make the
  // pool (the same precedence bands the final ranking boosts, then bm25); the final order is
  // rankSearchCandidates'. bm25 is normalised to [0, 1] within the pool (1 = best).
  private _ftsCandidates(matchQuery: string, query: string, tier: number, f: SearchFilters): SearchCandidate[] {
    const normalizedQuery = query.trim().toLowerCase();
    const topicForm = normalizedQuery.replaceAll(/\s+/g, "_");
    const rows = this.db
      .prepare(
        `SELECT o.id, o.title, o.type, o.topic_key, o.updated_at, o.scope, o.status, o.content,
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
                   score, o.updated_at DESC, o.id DESC
          LIMIT ?`,
      )
      .all(
        matchQuery, this.projectKey, f.scope, f.scope, f.type, f.type,
        topicForm, normalizedQuery, normalizedQuery, f.pool,
      ) as unknown as (SearchRow & { content: string })[];
    const best = Math.min(...rows.map((r) => r.score));
    const worst = Math.max(...rows.map((r) => r.score));
    return rows.map((r) => ({
      ...searchRowFields(r),
      relevance: worst === best ? 1 : (worst - r.score) / (worst - best),
      tier,
      snippet: r.snippet,
      matchTerms: [],
    }));
  }

  // LIKE candidates: every live note whose accent-folded title or content contains any of
  // `terms` (newest first, capped at the pool size × 4 so the BM25-like statistics see the
  // whole match set on any realistic project), scored by likeRelevance().
  private _likeCandidates(terms: string[], tier: number, f: SearchFilters, corpus: number): SearchCandidate[] {
    const patterns = terms.map((t) => `%${t.replaceAll(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const clauses = patterns
      .map(() => "(leina_fold(o.title) LIKE ? ESCAPE '\\' OR leina_fold(o.content) LIKE ? ESCAPE '\\')")
      .join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT o.id, o.title, o.type, o.topic_key, o.updated_at, o.scope, o.status, o.content
           FROM observations o
          WHERE o.project_key = ?
            AND o.superseded_by IS NULL
            AND (? IS NULL OR o.scope = ?)
            AND (? IS NULL OR o.type = ?)
            AND (${clauses})
          ORDER BY o.updated_at DESC, o.id DESC
          LIMIT ?`,
      )
      .all(
        this.projectKey, f.scope, f.scope, f.type, f.type,
        ...patterns.flatMap((p) => [p, p]),
        f.pool * 4,
      ) as unknown as ObsRow[];
    const relevance = likeRelevance(rows, terms, corpus);
    return rows.map((r, i) => ({ ...searchRowFields(r), relevance: relevance[i]!, tier, matchTerms: terms }));
  }

  private _liveCount(scope: string | null, type: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM observations
          WHERE project_key = ? AND superseded_by IS NULL
            AND (? IS NULL OR scope = ?) AND (? IS NULL OR type = ?)`,
      )
      .get(this.projectKey, scope, scope, type, type) as { n: number };
    return row.n;
  }

  // Empty query: the newest live observations (active first), no text filter.
  private _recentAsHits(scope: string | null, type: string | null, limit: number): SearchHit[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, type, topic_key, updated_at, scope, content, status
           FROM observations
          WHERE project_key = ?
            AND superseded_by IS NULL
            AND (? IS NULL OR scope = ?)
            AND (? IS NULL OR type = ?)
          ORDER BY status <> 'active', updated_at DESC, id DESC
          LIMIT ?`,
      )
      .all(this.projectKey, scope, scope, type, type, limit) as unknown as ObsRow[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type as ObservationType,
      topicKey: r.topic_key ?? undefined,
      snippet: r.content.length > 160 ? `${r.content.slice(0, 160)} …` : r.content,
      score: 0,
      updatedAt: r.updated_at,
      scope: r.scope as Scope,
      status: r.status as ObservationStatus,
    }));
  }

  // ---- get ------------------------------------------------------------------

  // Ids are unique across the GLOBAL memory.db, but a repository only ever answers for its
  // own project: another project's id reads as absent (`memory get <dirQ> <id-of-P>` and
  // MCP memory_get must not leak P's text). Cross-project reads go through
  // WorkspaceMemoryFederator, which asks each member's own repository.
  get(id: string): Observation | undefined {
    const r = this.db
      .prepare("SELECT * FROM observations WHERE id=? AND project_key=?")
      .get(this.resolveId(id), this.projectKey) as unknown as ObsRow | undefined;
    return r ? rowToObs(r) : undefined;
  }

  // ---- recentContext --------------------------------------------------------

  // Context is orientation for the NEXT piece of work, so only `active` notes take part unless
  // the caller asks for the rest. Ties on updated_at (a batch saved in one millisecond) break
  // on id, so the order never depends on the SQLite build.
  recentContext(
    opts?: { scope?: Scope; limit?: number; sessionLimit?: number; includeInactive?: boolean },
  ): { sessions: Session[]; observations: Observation[] } {
    const scope = opts?.scope ?? null;
    const limit = opts?.limit ?? 20;
    const sessionLimit = opts?.sessionLimit ?? 5;
    const activeOnly = opts?.includeInactive === true ? 0 : 1;

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
            AND (? = 0 OR status = 'active')
          ORDER BY updated_at DESC, id DESC
          LIMIT ?`,
      )
      .all(this.projectKey, scope, scope, activeOnly, limit) as unknown as ObsRow[];

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
  //
  // memory_anchors has no project_key column: every anchor read/write is confined to this
  // project through its observation (graph node ids such as a module path repeat across
  // projects, and observation ids must not be usable to reach another project's rows).

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
        `SELECT ma.observation_id, ma.role, ma.anchor_label, ma.anchor_file
           FROM memory_anchors ma
           JOIN observations o ON o.id = ma.observation_id
          WHERE ma.node_id = ? AND o.project_key = ?`,
      )
      .all(nodeId, this.projectKey) as unknown as AnchorRow[];
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
        `SELECT ma.node_id, ma.role, ma.anchor_label, ma.anchor_file, ma.anchor_hash
           FROM memory_anchors ma
           JOIN observations o ON o.id = ma.observation_id
          WHERE ma.observation_id = ? AND o.project_key = ?`,
      )
      .all(observationId, this.projectKey) as unknown as AnchorRow[];
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
          WHERE ma.node_id = ? AND o.project_key = ? AND o.superseded_by IS NULL
          ORDER BY o.updated_at DESC
          LIMIT ?`,
      )
      .all(nodeId, this.projectKey, limit) as unknown as Row[];
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
  // in reanchor's report without a second existence check). An observation outside this
  // project gets nothing (0).
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
    const owned = this.db
      .prepare("SELECT 1 FROM observations WHERE id=? AND project_key=?")
      .get(observationId, this.projectKey);
    if (owned === undefined) return 0;
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
  // Re-key every observation (live rows AND superseded snapshots — the audit trail follows
  // its topic) and every session from `from` to `to` in a single transaction. Topic-key
  // collisions (both from+to have a live row with the same scope+topic_key) are resolved by
  // marking the `from` live row superseded — so only the `to` row owns the topic; the
  // obs_au_retire trigger takes it out of the FTS index. `dryRun=true` computes counts then
  // rolls back (no writes).
  //
  // Guard: `from === to` throws (nothing to do, and the UPDATE would be a no-op).

  mergeProject(
    from: string,
    to: string,
    opts?: { dryRun?: boolean },
  ): { moved: number; superseded: number; snapshots: number } {
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

      // 3. Bulk re-key the live rows, then the superseded ones (older revisions plus the
      //    rows step 2 just retired). Leaving snapshots behind stranded them under a key
      //    whose live row had moved away.
      const rekey = (live: boolean): number =>
        (
          this.db
            .prepare(
              `UPDATE observations SET project_key=? WHERE project_key=? AND superseded_by IS ${live ? "" : "NOT "}NULL`,
            )
            .run(to, from) as { changes: number }
        ).changes;
      const moved = rekey(true);
      const snapshots = rekey(false);

      // 4. Re-key sessions (no topic_key collision possible on sessions).
      this.db.prepare("UPDATE sessions SET project_key=? WHERE project_key=?").run(to, from);

      if (dryRun) {
        this.db.exec("ROLLBACK");
      } else {
        this.db.exec("COMMIT");
      }

      return { moved, superseded, snapshots };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  // ---- compact --------------------------------------------------------------
  //
  // GC of this project's superseded snapshot rows (+ optional idle-session purge),
  // then VACUUM. Implements the CompactCapableRepository port defined by
  // application/memory/compact.ts. Correctness invariants:
  //
  //   · Live rows are untouched: every DELETE is scoped to superseded_by IS NOT NULL,
  //     so the live revision of each topic (and every non-topic observation) survives.
  //   · Anchors cascade: memory_anchors has no FK, so anchors of deleted snapshots are
  //     deleted explicitly IN THE SAME transaction — no dangling anchor rows. Anchors
  //     of live observations are never touched.
  //   · FTS stays consistent in two independent ways. (1) Snapshot rows were never in
  //     obs_fts (the obs_ai/obs_ad triggers are guarded on superseded_by IS NULL), so
  //     deleting them fires no FTS delete and leaves the index intact. (2) VACUUM may
  //     RENUMBER the implicit rowids of `observations` (its PRIMARY KEY is TEXT, so
  //     rowid is NOT stable across VACUUM) while obs_fts — an external-content table —
  //     addresses documents BY rowid. After every VACUUM the index is therefore rebuilt
  //     from scratch over live rows only (all projects — the FTS table is global),
  //     mirroring schema.ts migrateV3toV4. Skipped in LIKE mode (no obs_fts).
  //   · VACUUM runs OUTSIDE any transaction (SQLite requires it) after the GC commit.
  //     In WAL mode concurrent READERS never block it (its output lands in the WAL;
  //     only the later TRUNCATE checkpoint waits on them — see reclaimPending), while
  //     busy_timeout=5000 lets it wait for a concurrent WRITER. If it still fails
  //     (another process holds the db), the GC is already committed and NO rowids were
  //     renumbered (VACUUM is atomic), so the FTS index is still valid — the report
  //     keeps the removal counts and carries `vacuumError`; re-running compact later
  //     finishes the job (the re-run is idempotent).
  //   · sessions purge severs cleanly: observations pointing at a purged session get
  //     session_id = NULL (the obs_au trigger re-indexes live rows with identical
  //     title/content — a semantic no-op), so no dangling session references remain.

  // On-disk footprint: main db file plus its WAL sidecar (un-checkpointed pages live
  // there until the post-VACUUM truncate checkpoint folds them back).
  private dbSizeOnDisk(): number {
    let total = 0;
    for (const p of [this.dbPath, `${this.dbPath}-wal`]) {
      try {
        total += statSync(p).size;
      } catch {
        // absent sidecar (or :memory: db) — contributes nothing
      }
    }
    return total;
  }

  // GC transaction: snapshot deletion (anchors cascade first) + optional sessions
  // purge, all in ONE BEGIN IMMEDIATE. `dryRun` rolls back after counting.
  private _compactGc(
    keep: number,
    dryRun: boolean,
    now: number,
    sessionsOlderThanDays?: number,
  ): { supersededRemoved: number; anchorsRemoved: number; sessionsRemoved: number } {
    // Victims: this project's superseded snapshots beyond the newest `keep` per
    // (scope, topic). Newest = updated_at, tie-broken by revision (deterministic for
    // same-millisecond upserts — revision IS the version sequence within a topic).
    // COALESCE(topic_key, id) puts the rare snapshot WITHOUT a topic_key (import edge
    // case) in its own group, so any keep >= 1 always preserves it rather than lumping
    // all topic-less snapshots into one shared bucket.
    const victimsSql = `
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY scope, COALESCE(topic_key, id)
          ORDER BY updated_at DESC, revision DESC, id DESC
        ) AS rn
        FROM observations
        WHERE project_key = ? AND superseded_by IS NOT NULL
      ) WHERE rn > ?`;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Anchors first — the victim subquery reads `observations`, so the cascade
      // must run while the snapshot rows still exist.
      const anchorsRemoved = (
        this.db
          .prepare(`DELETE FROM memory_anchors WHERE observation_id IN (${victimsSql})`)
          .run(this.projectKey, keep) as { changes: number }
      ).changes;
      const supersededRemoved = (
        this.db
          .prepare(`DELETE FROM observations WHERE id IN (${victimsSql})`)
          .run(this.projectKey, keep) as { changes: number }
      ).changes;
      const sessionsRemoved =
        sessionsOlderThanDays === undefined
          ? 0
          : this._purgeIdleSessionsInTx(now - sessionsOlderThanDays * 86_400_000);
      this.db.exec(dryRun ? "ROLLBACK" : "COMMIT");
      return { supersededRemoved, anchorsRemoved, sessionsRemoved };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  // Purge sessions whose last activity (ended_at, or started_at for never-closed
  // sessions) predates `cutoff`, severing observation references first so no dangling
  // session_id remains. The UPDATE fires obs_au on live rows with identical
  // title/content — a semantic no-op for the FTS index. Assumes an open transaction.
  private _purgeIdleSessionsInTx(cutoff: number): number {
    this.db
      .prepare(
        `UPDATE observations SET session_id = NULL
          WHERE project_key = ? AND session_id IN (
            SELECT id FROM sessions
             WHERE project_key = ? AND COALESCE(ended_at, started_at) < ?)`,
      )
      .run(this.projectKey, this.projectKey, cutoff);
    return (
      this.db
        .prepare(
          `DELETE FROM sessions
            WHERE project_key = ? AND COALESCE(ended_at, started_at) < ?`,
        )
        .run(this.projectKey, cutoff) as { changes: number }
    ).changes;
  }

  // Post-VACUUM FTS reconstruction: drop + recreate obs_fts and reindex live rows only,
  // across ALL projects (the FTS table is global). Mirrors schema.ts migrateV3toV4.
  private _rebuildFtsIndex(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DROP TABLE IF EXISTS obs_fts");
      this.db.exec(OBS_FTS_DDL);
      this.db.exec(
        `INSERT INTO obs_fts(rowid, title, content)
           SELECT rowid, title, content FROM observations WHERE superseded_by IS NULL`,
      );
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  compact(opts: CompactOptions = {}): CompactReport {
    const dryRun = opts.dryRun ?? false;
    const dbBytesBefore = this.dbSizeOnDisk();
    const removed = this._compactGc(
      opts.keepPerTopic ?? 0,
      dryRun,
      opts.now ?? Date.now(),
      opts.sessionsOlderThanDays,
    );

    if (dryRun) {
      return { ...removed, dbBytesBefore, dbBytesAfter: dbBytesBefore, dryRun: true };
    }

    // VACUUM — outside any transaction, after the GC commit. Failure here (db busy
    // beyond busy_timeout) leaves a fully consistent db: rows already gone, rowids
    // unrenumbered (VACUUM is atomic), FTS valid — re-running compact finishes the job.
    // The GC is committed, so its counts are returned (not thrown away with an error).
    try {
      this.db.exec("VACUUM");
    } catch (e) {
      return {
        ...removed,
        dbBytesBefore,
        dbBytesAfter: this.dbSizeOnDisk(),
        dryRun: false,
        vacuumError: (e as Error).message,
      };
    }

    // VACUUM may have renumbered observation rowids (see the invariants block above),
    // so the rowid-addressed FTS index must be rebuilt. Skipped in LIKE mode (no obs_fts).
    if (this.fts5) this._rebuildFtsIndex();

    // Fold the WAL back into the main file so the reported after-size is honest. A
    // connection still reading an older snapshot (another leina process) blocks the
    // TRUNCATE checkpoint past busy_timeout: the row then reports busy=1 and/or fewer
    // frames checkpointed than logged, and VACUUM's rewritten pages stay in the WAL —
    // the file has temporarily GROWN. That is flagged as reclaimPending instead of being
    // reported as the result; the last connection to close checkpoints and drops the WAL.
    let reclaimPending: boolean;
    try {
      const ck = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as unknown as
        { busy: number; log: number; checkpointed: number } | undefined;
      reclaimPending = ck?.busy !== 0 || ck.log !== ck.checkpointed;
    } catch {
      reclaimPending = true; // size reporting only — the compaction itself is done
    }

    return { ...removed, dbBytesBefore, dbBytesAfter: this.dbSizeOnDisk(), dryRun: false, reclaimPending };
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
