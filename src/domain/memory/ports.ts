// domain/memory/ports.ts — Port interfaces for the memory domain.
//
// Concrete implementation: SQLiteMemoryRepository in
// src/infrastructure/sqlite/memory-repository.ts (SQLite driven adapter).
//
// Dependency rule: this file MUST import only from domain modules.
// No application/, infrastructure/, or cli/ imports allowed here.

import type {
  Observation,
  ObservationInput,
  ObservationType,
  Scope,
  SearchHit,
  Session,
  TopicKeySuggestion,
  UpdateFields,
  ExportedObservation,
  ImportReport,
} from "./model.ts";
import type { BatchResult } from "../shared/batch.ts";

// ---------------------------------------------------------------------------
// ResolvedAnchor — result of resolving a human-facing label to a graph node.
// Mirrors the shape used by src/infrastructure/sqlite/memory-repository.ts.
// Defined here so domain code can reference it without importing from
// infrastructure.
// ---------------------------------------------------------------------------

export interface ResolvedAnchor {
  /** The stable graph node id that the label resolved to. */
  nodeId: string;
  /** Source file that contains the node (used for drift detection). */
  sourceFile: string;
  /**
   * SHA-256 of the source file at save time (from the build manifest).
   * Undefined when the file is not in the manifest.
   */
  fileHash?: string;
}

// ---------------------------------------------------------------------------
// AnchorResolver — injectable lookup: label → graph node(s).
// The concrete implementation is makeResolveAnchor in
// src/application/memory/anchor-verify.ts; the port type is defined here so
// application-layer code can depend on the abstraction, not a concrete module.
// Signature: (label: string) => ResolvedAnchor[]
// ---------------------------------------------------------------------------

export type AnchorResolver = (label: string) => ResolvedAnchor[];

// ---------------------------------------------------------------------------
// MemoryRepository — port for memory storage (driven adapter).
// Source of truth: SQLiteMemoryRepository in
// src/infrastructure/sqlite/memory-repository.ts (the interface matches the
// ACTUAL public surface of the implementation verbatim).
// ---------------------------------------------------------------------------

export interface MemoryRepository {
  // ---- mode ---------------------------------------------------------------

  /**
   * True when the repository is running in LIKE-search degraded mode because
   * SQLite FTS5 is unavailable on this Node build (Node 22/23). Full stemmed
   * BM25 search is replaced by substring LIKE matching. Callers (e.g. wiring.ts)
   * use this flag to emit a warning to stderr.
   *
   * NOTE: this flag leaks an SQLite/FTS5 implementation detail into the domain
   * port — a tolerated trade-off. Renaming it to something storage-neutral
   * (e.g. `degradedSearch`) would break every implementation and caller for a
   * purely cosmetic gain, so it stays as-is, documented honestly.
   */
  readonly usingLike: boolean;

  // ---- single-item write --------------------------------------------------

  /** Save a new observation or upsert an existing one by topic_key. */
  save(input: ObservationInput): { observation: Observation; evolved: boolean };

  /**
   * Save a batch of observations. When `opts.atomic` is true, all writes share
   * a single SQLite transaction (all-or-nothing). When false (default) each item
   * gets its own transaction so a sibling failure never rolls back a success.
   */
  saveBatch(
    items: ObservationInput[],
    opts?: { atomic?: boolean },
  ): BatchResult<{ observation: Observation; evolved: boolean }>[];

  // ---- update -------------------------------------------------------------

  /**
   * In-place partial update of a LIVE observation by id. Does NOT bump revision
   * or create a snapshot — use the topic_key upsert path for that.
   */
  update(id: string, fields: UpdateFields): Observation;

  /** Batch variant of `update`. */
  updateBatch(
    items: { id: string; fields: UpdateFields }[],
    opts?: { atomic?: boolean },
  ): BatchResult<Observation>[];

  // ---- read ---------------------------------------------------------------

  /**
   * Look up an observation by id. Tolerates a leading "#" prefix. Like every id-keyed
   * method here, it only answers for this repository's project: another project's id
   * reads as absent (and `update` rejects it as unknown).
   */
  get(id: string): Observation | undefined;

  /** Batch variant of `get`. */
  getBatch(ids: string[]): BatchResult<Observation>[];

  /**
   * Full-text search over the project's observations (BM25 + proximity boost).
   */
  search(
    query: string,
    opts?: { scope?: Scope; type?: ObservationType; limit?: number },
  ): SearchHit[];

  /**
   * Return recent sessions and the most recently updated observations for
   * the project.
   */
  recentContext(opts?: {
    scope?: Scope;
    limit?: number;
    sessionLimit?: number;
  }): { sessions: Session[]; observations: Observation[] };

  // ---- sessions -----------------------------------------------------------

  /** Open a new session and set it as the active session for subsequent saves. */
  startSession(title?: string, scope?: Scope): Session;

  /**
   * Summarise and close a session. Uses the active session when no sessionId
   * is provided; creates a new one-shot session when neither exists.
   */
  saveSession(
    summary: string,
    opts?: { sessionId?: string; title?: string; scope?: Scope },
  ): Session;

  // ---- anchors ------------------------------------------------------------

  /**
   * Return all memory anchors pointing at the given graph node id, including
   * the human-facing label and the anchored source file.
   */
  anchorsForNode(nodeId: string): {
    observationId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
  }[];

  /**
   * Return all anchors attached to a given observation, including the save-time
   * file hash used for drift detection.
   */
  anchorsForObservation(observationId: string): {
    nodeId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
    anchorHash?: string;
  }[];

  /**
   * Return up to `limit` LIVE observations anchored to `nodeId`, most recently
   * updated first (`observations.updated_at DESC`). Unlike `anchorsForNode` (unordered,
   * unbounded — kept intact for its existing call sites), this is the query behind
   * "recent memories for this node" panels (e.g. `graph serve`'s node detail view).
   */
  recentAnchoredObservations(nodeId: string, limit: number): {
    observationId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
    updatedAt: number;
  }[];

  /**
   * Additive, non-destructive anchor insert for an EXISTING observation: adds each anchor
   * that isn't already present (by `(observation_id, node_id, role)`) and silently skips the
   * rest — never deletes or replaces (unlike the DELETE+reinsert `anchors` path of `save`/
   * `update`). Used by `memory reanchor`, which must union new anchors onto observations
   * that already have some, idempotently. Callers pass already-RESOLVED anchors (this method
   * never calls the label resolver itself). Returns the number of anchors actually inserted.
   */
  addAnchorsIfMissing(
    observationId: string,
    anchors: {
      nodeId: string;
      role?: string;
      anchorLabel?: string;
      anchorFile?: string;
      anchorHash?: string;
    }[],
  ): number;

  // ---- topic-key suggestion -----------------------------------------------

  /** Suggest a normalised topic_key and rank near-matches from existing live keys. */
  suggestTopicKeyWithMatches(
    title: string,
    type: string,
    scope?: Scope,
  ): TopicKeySuggestion;

  // ---- project management -------------------------------------------------

  /**
   * Re-key all observations and sessions from `from` to `to`.
   * Topic-key collisions are resolved by superseding the `from` row.
   * `dryRun: true` computes counts and rolls back without writing.
   */
  mergeProject(
    from: string,
    to: string,
    opts?: { dryRun?: boolean },
  ): { moved: number; superseded: number };

  // ---- lifecycle ----------------------------------------------------------

  /** Close the underlying database connection. */
  /**
   * Export every observation of this project (live and superseded) with its anchors,
   * deterministically ordered (createdAt, id) so snapshots diff cleanly.
   */
  exportAll(): ExportedObservation[];

  /**
   * Merge exported observations into this project. Deterministic by (revision, updatedAt):
   * unknown ids insert verbatim (timestamps/revisions preserved, except that timestamps are
   * clamped to the import time; projectKey remapped to this store's key); known ids update
   * only when strictly newer; live topic_key collisions resolve toward the newer side,
   * superseding the older one. An id already owned by ANOTHER project is never touched —
   * it is skipped and counted in `skippedForeign`. An unknown superseded snapshot whose
   * row has already moved past it here (e.g. removed by `memory compact`) is not
   * re-inserted; it counts as `skippedOlder`.
   */
  importObservations(items: ExportedObservation[]): ImportReport;

  close(): void;
}
