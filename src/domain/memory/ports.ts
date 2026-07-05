// domain/memory/ports.ts — Port interfaces for the memory domain.
// Phase 1 (PR-1): interface definitions only — zero behavior change.
// Concrete implementation (MemoryStore) remains in src/memory/store.ts;
// Phase-3 reorganisation will move it to infrastructure/sqlite/memory-repository.ts.
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
// Mirrors the shape in src/memory/store.ts (which will become the infrastructure
// adapter in Phase 3). Defined here so domain code can reference it without
// importing from infrastructure.
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
// Formalises the existing proto-port in src/memory/store.ts.
// The concrete implementation lives in src/memory/anchor-verify.ts;
// the port type is defined here so application-layer code can depend on
// the abstraction, not the infrastructure module.
// Signature matches the ACTUAL existing type (source of truth in Phase 1):
//   (label: string) => ResolvedAnchor[]
// ---------------------------------------------------------------------------

export type AnchorResolver = (label: string) => ResolvedAnchor[];

// ---------------------------------------------------------------------------
// MemoryRepository — port for memory storage (driven adapter).
// Source of truth: MemoryStore in src/memory/store.ts (Phase 1 is behavior-neutral;
// the interface matches the ACTUAL public surface of MemoryStore verbatim).
// ---------------------------------------------------------------------------

export interface MemoryRepository {
  // ---- mode ---------------------------------------------------------------

  /**
   * True when the repository is running in LIKE-search degraded mode because
   * SQLite FTS5 is unavailable on this Node build (Node 22/23). Full stemmed
   * BM25 search is replaced by substring LIKE matching. Callers (e.g. wiring.ts)
   * use this flag to emit a warning to stderr.
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

  /** Look up an observation by id. Tolerates a leading "#" prefix. */
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

  /**
   * Copy observations, sessions and anchors from a legacy per-repo memory.db
   * into this (global) store, remapping `fromKey` → `toKey`. Idempotent.
   */
  importFromLegacy(
    legacyDbPath: string,
    fromKey: string,
    toKey: string,
  ): { moved: number; skipped: number };

  // ---- lifecycle ----------------------------------------------------------

  /** Close the underlying database connection. */
  /**
   * Export every observation of this project (live and superseded) with its anchors,
   * deterministically ordered (createdAt, id) so snapshots diff cleanly.
   */
  exportAll(): ExportedObservation[];

  /**
   * Merge exported observations into this project. Deterministic by (revision, updatedAt):
   * unknown ids insert verbatim (timestamps/revisions preserved; projectKey remapped to
   * this store's key); known ids update only when strictly newer; live topic_key
   * collisions resolve toward the newer side, superseding the older one.
   */
  importObservations(items: ExportedObservation[]): ImportReport;

  close(): void;
}
