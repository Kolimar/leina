// application/memory/compact.ts — `memory compact` use-case (maintenance verb).
//
// Every topic_key upsert snapshots the prior revision as a 'superseded' row that
// lives forever in the GLOBAL memory.db, so the base `observations` table grows
// monotonically (years of sessions, many projects) and exportAll()/scans pay that
// weight. compact GCs those snapshots for ONE project, optionally purges idle
// sessions, and VACUUMs the file to give the space back to the OS.
//
// Port note: this file defines its own narrow port (CompactCapableRepository)
// instead of widening domain/memory/ports.ts MemoryRepository. compact is a
// physical-storage maintenance verb only the SQLite adapter can honour (VACUUM,
// FTS index rebuild); forcing it onto every MemoryRepository implementation
// (e.g. WorkspaceMemoryFederator) would push infrastructure concerns into
// implementations that have no storage of their own. Application-defined ports
// follow the existing precedent of NodeVerifier in application/memory/query.ts.

/** Sessions purge never removes this many of the project's newest sessions (by default). */
export const DEFAULT_KEEP_SESSIONS = 5;

export interface CompactOptions {
  /**
   * Retain the N most recent superseded snapshots per (scope, topic). Default 0:
   * delete every superseded snapshot — the live row of each topic is ALWAYS
   * preserved (compact only ever touches rows with superseded_by set), so 0 is
   * safe: no live memory, session summary, or live anchor is ever removed.
   */
  keepPerTopic?: number;
  /**
   * Purge sessions whose last activity (ended_at, or started_at for
   * never-closed sessions) is older than this many days. Default: undefined —
   * sessions are never touched unless explicitly requested.
   */
  sessionsOlderThanDays?: number;
  /**
   * The N most recent sessions (by start time) always survive the sessions purge, however
   * idle — so a project that sat untouched for months still has its last session summaries
   * to resume from. Default DEFAULT_KEEP_SESSIONS (5); 0 lets the age cutoff alone decide.
   */
  keepSessions?: number;
  /** Compute and report counts, then roll back — no writes, no VACUUM. */
  dryRun?: boolean;
  /** Reference timestamp for the sessions cutoff (test seam; defaults to Date.now()). */
  now?: number;
}

export interface CompactReport {
  /** Superseded snapshot rows deleted from `observations`. */
  supersededRemoved: number;
  /** `memory_anchors` rows cascade-deleted with those snapshots. */
  anchorsRemoved: number;
  /** `sessions` rows purged (0 unless sessionsOlderThanDays was given). */
  sessionsRemoved: number;
  /** On-disk size (db + WAL sidecar) before compaction, in bytes. */
  dbBytesBefore: number;
  /**
   * On-disk size after VACUUM + checkpoint; equals dbBytesBefore on dry runs. Not the
   * final size when `reclaimPending` is set (VACUUM's pages still sit in the WAL).
   */
  dbBytesAfter: number;
  dryRun: boolean;
  /**
   * True when the post-VACUUM checkpoint could not fold the WAL back into the main file
   * because another connection was still reading an older snapshot: the space is given
   * back once those other processes close, so dbBytesAfter (which then includes the
   * rewritten pages in the WAL) must not be presented as the result.
   */
  reclaimPending?: boolean;
  /**
   * Set when the GC committed but VACUUM could not run (e.g. another process grabbed the
   * db in between). The removals above stand and the db is consistent; only the disk
   * space was not given back — re-running compact later finishes the job.
   */
  vacuumError?: string;
}

/** Narrow port: a memory repository that supports physical compaction. */
export interface CompactCapableRepository {
  compact(opts?: CompactOptions): CompactReport;
}

/** Structural capability check — the CLI holds a MemoryRepository, not the concrete class. */
export function supportsCompact(repo: unknown): repo is CompactCapableRepository {
  return typeof (repo as { compact?: unknown } | null | undefined)?.compact === "function";
}

/**
 * Validate options and delegate to the repository. Idempotent: a second run
 * finds nothing to delete and reports zeros.
 */
export function compactMemory(repo: unknown, opts: CompactOptions = {}): CompactReport {
  if (!supportsCompact(repo)) {
    throw new Error("this memory backend does not support compact");
  }
  const keep = opts.keepPerTopic ?? 0;
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error("keepPerTopic must be a non-negative integer");
  }
  if (
    opts.sessionsOlderThanDays !== undefined &&
    (!Number.isFinite(opts.sessionsOlderThanDays) || opts.sessionsOlderThanDays <= 0)
  ) {
    throw new Error("sessionsOlderThanDays must be a positive number of days");
  }
  const keepSessions = opts.keepSessions ?? DEFAULT_KEEP_SESSIONS;
  if (!Number.isInteger(keepSessions) || keepSessions < 0) {
    throw new Error("keepSessions must be a non-negative integer");
  }
  return repo.compact({ ...opts, keepPerTopic: keep, keepSessions });
}
