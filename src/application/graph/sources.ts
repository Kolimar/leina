// Source-file enumeration — the set of files the graph is built from.
// Extracted from build.ts so the freshness/manifest layer can list sources
// without pulling in the heavy extractor stack (tree-sitter, ts-morph, sidecars).

import { readdirSync, statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve } from "node:path";
import { detectLang } from "./detect.ts";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  // .NET build outputs: obj/ holds generated .cs (*.g.cs, AssemblyInfo) that would
  // otherwise be indexed as sources and re-stale the graph on every dotnet build.
  // The Roslyn sidecar already skips these — keep both lists in sync.
  "obj",
  "bin",
]);

// Minified bundles (vendored vis-network, copied dist artifacts) are generated,
// unreadable code: indexing one floods the graph with meaningless one-letter god
// nodes. Match by the conventional `.min.<ext>` infix regardless of extension.
const MINIFIED_RE = /\.min\.[^.]+$/i;

/** True for conventionally-named minified artifacts (`foo.min.js`, `lib.min.mjs`, …). */
export function isMinifiedArtifact(name: string): boolean {
  return MINIFIED_RE.test(name);
}

// Per-file size cap. Extractors (tree-sitter, YAML, ts-morph) and the manifest hash read
// each source whole; a multi-megabyte source is virtually always generated (parser
// tables, unsuffixed bundles, data dumps) and costs memory and time out of proportion.
// Files above the cap are skipped CONSISTENTLY: the build never extracts nor hashes them
// (partitionBySize + writeManifest), and the freshness check neither counts an untracked
// one as "added" nor ignores a tracked one that grew past it (manifest.ts). The walk
// itself stays stat-free — the cap is checked where a stat already happens or only for
// files the manifest does not track, so the read-path gate pays nothing extra.
// 4 MiB matches the harness untracked-file cap (infrastructure/harness/git.ts) and keeps
// the largest hand-written sources seen in real repos (TypeScript's checker.ts ≈ 3 MB).
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** True when a source of `bytes` bytes is above the per-file cap. */
export function exceedsSourceCap(bytes: number): boolean {
  return bytes > MAX_SOURCE_BYTES;
}

/**
 * Split listed sources into the files to extract and the oversize ones (with their
 * size, for the diagnostic). A file that vanished since the walk stays in `kept`: the
 * extractors and writeManifest already tolerate that race.
 */
export function partitionBySize(files: string[]): {
  kept: string[];
  oversize: { file: string; bytes: number }[];
} {
  const kept: string[] = [];
  const oversize: { file: string; bytes: number }[] = [];
  for (const file of files) {
    let bytes: number;
    try {
      bytes = statSync(file).size;
    } catch {
      kept.push(file);
      continue;
    }
    if (exceedsSourceCap(bytes)) oversize.push({ file, bytes });
    else kept.push(file);
  }
  return { kept, oversize };
}

/**
 * Returns true for `.yml` and `.yaml` files (infra config sources).
 * `detectLang()` in detect.ts is NOT modified — it remains code-only.
 */
export function detectIsConfig(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = path.slice(dot).toLowerCase();
  return ext === ".yml" || ext === ".yaml";
}

// ---------------------------------------------------------------------------
// Intra-operation memoization of the source walk.
//
// The freshness gate (manifest.ts isStale) and a stale-triggered rebuild
// (build.ts buildGraph / workspace/build.ts per member) each call
// listSourceFiles — on the stale→auto-rebuild path that meant walking the whole
// tree twice within ONE logical operation. The memo below deduplicates those
// walks WITHOUT any cross-operation caching:
//
//   · Scope: AsyncLocalStorage. Only calls within the dynamic extent of one
//     withSourceListMemo(fn) share a memo. Concurrent operations in the same
//     process (e.g. two MCP tool calls in flight) never see each other's memo,
//     and every NEW operation re-walks from scratch. This is deliberate — the
//     freshness gate is correctness-critical: any cache that survives an
//     operation could report 'fresh' for a repo whose sources changed between
//     operations, which must never happen. Long-lived processes (MCP server,
//     TUI, serve) therefore still pay one walk per gate, by design.
//   · Why not key a persistent cache on the root dir's mtime: a directory's
//     mtime only changes when a DIRECT child is added/removed/renamed — edits
//     and additions in nested subdirectories leave it untouched, so an
//     mtime-keyed cache would yield false 'fresh' verdicts. No correct cheap
//     invalidation signal exists, so we stop at intra-operation memoization.
// ---------------------------------------------------------------------------

const sourceListMemo = new AsyncLocalStorage<Map<string, string[]>>();

/**
 * Run `fn` with source-walk memoization enabled for its dynamic extent: every
 * listSourceFiles(root) call inside shares one walk per root. Re-entrant —
 * nested scopes join the outer memo (same logical operation). The memo is
 * dropped when `fn` settles; nothing persists across operations.
 */
export async function withSourceListMemo<T>(fn: () => Promise<T>): Promise<T> {
  if (sourceListMemo.getStore() !== undefined) return fn();
  return sourceListMemo.run(new Map(), fn);
}

export function listSourceFiles(root: string): string[] {
  const memo = sourceListMemo.getStore();
  const memoKey = resolve(root);
  const cached = memo?.get(memoKey);
  // Defensive copy — callers may sort/mutate their listing without corrupting the memo.
  if (cached) return [...cached];
  const found: string[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        // Include code files (detectLang) OR YAML infra config (detectIsConfig).
        // The fine-grained routing (which extractor handles what) is done later by
        // ext.supports() in build.ts — here we just discover candidates.
        if (isMinifiedArtifact(e.name)) continue;
        if (detectLang(e.name) !== null || detectIsConfig(e.name)) found.push(full);
      }
    }
  }
  walk(root);
  // Store a pristine copy so a caller mutating `found` cannot poison later hits.
  memo?.set(memoKey, [...found]);
  return found;
}
