// Which TypeScript files an incremental build must re-extract (pure; see ts-facts.ts).
//
// A cached per-file result stays valid while nothing it was computed from changed: the file
// itself, and what the checker sees from it — the files it imports, transitively, and the
// global declarations. So, against the previous build's cache:
//
// - a changed or added file is re-extracted;
// - a removed or added file, a changed file whose SHAPE changed, and a file whose imports now
//   resolve to other files are SEEDS: every file that imports a seed, transitively, is
//   re-extracted as well (the dependency graph is the previous build's, recorded per file);
// - a change to a GLOBAL file (or to a file becoming one) has no dependency edges to follow
//   and forces a full extraction, as does re-extracting at least half of the files anyway.

import type { TsCachedFile, TsSpec } from "../../sqlite/ts-extract-cache.ts";
import type { FileFacts } from "./ts-facts.ts";

export type TsPlan = { kind: "full"; reason: string } | { kind: "incremental"; dirty: Set<string> };

export interface TsPlanInput {
  /** Listed files (root-relative POSIX) → current content hash. */
  current: ReadonlyMap<string, string>;
  /** The previous build's cache, keyed like `current`. */
  cached: ReadonlyMap<string, TsCachedFile>;
  /** Facts of a changed or added file, from its current text. */
  factsOf(rel: string): FileFacts;
  /** Where a cached specifier of `rel` resolves today (root-relative POSIX), or null. */
  resolve(rel: string, spec: TsSpec): string | null;
  /** Re-resolve every specifier, not only unresolved ones (implied when files were added/removed). */
  reResolveAll?: boolean;
  /** Fraction of the files at which re-extracting everything is cheaper (default 0.5). */
  fullRatio?: number;
}

interface FileDiff {
  changed: string[];
  added: string[];
  removed: string[];
}

function diffFiles(current: ReadonlyMap<string, string>, cached: ReadonlyMap<string, TsCachedFile>): FileDiff {
  const changed: string[] = [];
  const added: string[] = [];
  for (const [rel, sum] of current) {
    const c = cached.get(rel);
    if (c === undefined) added.push(rel);
    else if (c.hash !== sum) changed.push(rel);
  }
  const removed = [...cached.keys()].filter((rel) => !current.has(rel));
  return { changed, added, removed };
}

/** Unchanged files whose imports resolve elsewhere now (a file added next to the old target…). */
function resolutionChanges(input: TsPlanInput, all: boolean): string[] {
  const out: string[] = [];
  for (const [rel, c] of input.cached) {
    if (input.current.get(rel) !== c.hash) continue;
    const moved = c.specs.some((spec) => (all || spec[2] === null) && input.resolve(rel, spec) !== spec[2]);
    if (moved) out.push(rel);
  }
  return out;
}

/** Every file that imports one of `seeds`, transitively, over the cached dependency graph. */
function importersOf(cached: ReadonlyMap<string, TsCachedFile>, seeds: Iterable<string>): Set<string> {
  const importers = new Map<string, string[]>();
  for (const [rel, c] of cached) {
    for (const [, , target] of c.specs) {
      if (target === null || target === rel) continue;
      const list = importers.get(target);
      if (list === undefined) importers.set(target, [rel]);
      else list.push(rel);
    }
  }
  const reached = new Set<string>(seeds);
  const queue = [...reached];
  const out = new Set<string>();
  while (queue.length > 0) {
    for (const importer of importers.get(queue.pop()!) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      out.add(importer);
      queue.push(importer);
    }
  }
  return out;
}

export function planTsExtraction(input: TsPlanInput): TsPlan {
  const { current, cached } = input;
  if (cached.size === 0) return { kind: "full", reason: "no cached extraction" };
  const { changed, added, removed } = diffFiles(current, cached);

  const goneGlobal = removed.find((rel) => cached.get(rel)?.global === true);
  if (goneGlobal !== undefined) return { kind: "full", reason: `global declarations removed: ${goneGlobal}` };
  const seeds = new Set<string>([...added, ...removed]);
  for (const rel of [...changed, ...added]) {
    const facts = input.factsOf(rel);
    const old = cached.get(rel);
    if (facts.global || old?.global === true) return { kind: "full", reason: `global declarations changed: ${rel}` };
    if (old !== undefined && old.shape !== facts.shape) seeds.add(rel);
  }
  const reResolveAll = input.reResolveAll === true || added.length > 0 || removed.length > 0;
  const moved = resolutionChanges(input, reResolveAll);
  for (const rel of moved) seeds.add(rel);

  const dirty = new Set<string>([...changed, ...added, ...moved]);
  for (const rel of importersOf(cached, seeds)) {
    if (current.has(rel)) dirty.add(rel);
  }
  if (dirty.size > 0 && dirty.size >= current.size * (input.fullRatio ?? 0.5)) {
    return { kind: "full", reason: `${dirty.size} of ${current.size} files affected` };
  }
  return { kind: "incremental", dirty };
}
