// application/project/registry.ts — pure merge logic for the global project registry.
//
// The registry (`~/.leina/projects.json`, read/written by
// infrastructure/config/project-registry-store.ts) is a minimal, best-effort list of
// projects leina has touched: `{projectKey, root, lastBuild}[]`, keyed by `root`. It powers
// the project selector in `graph serve` — NOT a source of truth for anything else.
//
// Kept here (application layer) as pure functions with no fs/IO: callers inject the list
// they read and get back the list to write, same seam as `deriveMemoryState`'s injected
// `NodeVerifier` in application/memory/query.ts.

export interface ProjectEntry {
  /** Derived project key (see application/project/detect-key.ts). */
  projectKey: string;
  /** Absolute path to the project root. Identity key for upsert/merge. */
  root: string;
  /** Epoch ms of the most recent successful build/refresh. */
  lastBuild: number;
}

/** A registry entry annotated with liveness (see `withAvailability`). */
export interface ProjectEntryWithAvailability extends ProjectEntry {
  /** True when `root` no longer exists on disk. Never removed — see module doc. */
  unavailable?: boolean;
}

/**
 * Upsert `entry` into `list`, keyed by `root`. An existing entry for the same root is
 * replaced in place (so `lastBuild` advances without duplicating the row); a new root is
 * appended. Pure: returns a new array, never mutates `list`.
 */
export function upsertProject(list: ProjectEntry[], entry: ProjectEntry): ProjectEntry[] {
  const idx = list.findIndex((p) => p.root === entry.root);
  if (idx === -1) return [...list, entry];
  const next = list.slice();
  next[idx] = entry;
  return next;
}

/** The outcome of pruning a registry: entries kept vs. dropped (see `pruneRegistry`). */
export interface PruneResult {
  kept: ProjectEntry[];
  removed: ProjectEntry[];
}

/**
 * Partition `list` into entries whose root still exists (`kept`) and those whose root is
 * gone (`removed`). Unlike `withAvailability` — which annotates but never drops, so a
 * moved-back repo auto-heals — this is the explicit, user-invoked garbage collection
 * (`leina graph gc`): the caller writes back only `kept`. Pure: `exists` is injected and
 * the input list is never mutated.
 */
export function pruneRegistry(list: ProjectEntry[], exists: (root: string) => boolean): PruneResult {
  const kept: ProjectEntry[] = [];
  const removed: ProjectEntry[] = [];
  for (const entry of list) {
    (exists(entry.root) ? kept : removed).push(entry);
  }
  return { kept, removed };
}

/**
 * Annotate each entry with `unavailable: true` when its root is no longer reachable.
 * Roots are NEVER dropped from the list — a disconnected drive or a repo moved back into
 * place auto-heals on the next read. `exists` is injected (rather than calling `fs`
 * directly) so this stays a pure function of its inputs, matching the `NodeVerifier`
 * seam used for memory drift detection.
 */
export function withAvailability(
  list: ProjectEntry[],
  exists: (root: string) => boolean,
): ProjectEntryWithAvailability[] {
  return list.map((p) => (exists(p.root) ? { ...p } : { ...p, unavailable: true }));
}
