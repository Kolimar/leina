// Source-file enumeration — the set of files the graph is built from.
// Extracted from build.ts so the freshness/manifest layer can list sources
// without pulling in the heavy extractor stack (tree-sitter, ts-morph, sidecars).
//
// Discovery honours the repo's own idea of what is "the project":
//   · inside a git work tree it asks git (`ls-files --cached --others
//     --exclude-standard`): tracked files plus untracked-but-not-ignored ones, so
//     .gitignore'd output (coverage/, generated clients, local scratch) is never
//     indexed, and nested repositories / linked worktrees are never descended into
//     (git lists them as a bare `dir/`).
//   · outside git (or when git is unavailable / lists nothing, e.g. a root that is
//     itself ignored) it walks the tree, skipping any subdirectory that carries its
//     own `.git` entry — the same nested-repo rule.
// Both paths then apply the same filters: IGNORE_DIRS, hidden directories (except
// the CI/devcontainer config dirs yaml-infra indexes), minified bundles, and the
// extension set. Workspace members are separate repos and are built separately
// (application/workspace/build.ts), each as its own root.

import { lstatSync, readdirSync, statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve } from "node:path";
import { safeGitRawOutput } from "../../infrastructure/install/safe-exec.ts";
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

// Hidden directories hold tool state, not project sources: agent worktrees
// (.claude/worktrees/<name> is a full checkout — indexing it duplicates every symbol),
// editor/IDE state, framework caches (.svelte-kit, .nuxt, .turbo, .cache), package
// manager payloads (.yarn/releases). They are skipped everywhere EXCEPT the CI and
// dev-environment config dirs whose YAML the yaml-infra extractor turns into
// config/service nodes (workflows, pipelines, devcontainer compose files).
const INDEXED_HIDDEN_DIRS = new Set([
  ".github",
  ".gitlab",
  ".gitea",
  ".forgejo",
  ".circleci",
  ".buildkite",
  ".devcontainer",
]);

/** True for a directory name source discovery never descends into. */
function isSkippedDir(name: string): boolean {
  if (IGNORE_DIRS.has(name)) return true;
  return name.startsWith(".") && !INDEXED_HIDDEN_DIRS.has(name);
}

// Resolution-affecting config files: the TS compiler options/paths (tsconfig*.json,
// jsconfig.json) and package manifests (workspaces, exports/imports maps). They are not
// graph sources, but a change to one can re-route imports, so the build manifest
// fingerprints them (manifest.ts) and a change makes the graph stale.
/** True for a resolution-affecting config file name (tsconfig*.json, jsconfig.json, package.json). */
export function isResolutionConfig(name: string): boolean {
  if (name === "package.json" || name === "jsconfig.json" || name === "tsconfig.json") return true;
  // tsconfig.<variant>.json / tsconfig-<variant>.json (base, build, app, spec, …)
  const sep = name.charAt("tsconfig".length);
  return name.startsWith("tsconfig") && (sep === "." || sep === "-") && name.endsWith(".json");
}

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

/** What one discovery pass finds under a root (absolute or root-relative paths, as given). */
export interface ProjectFiles {
  /** Graph sources: code files (detectLang) and YAML infra config (detectIsConfig). */
  sources: string[];
  /** Resolution-affecting config files (isResolutionConfig) — fingerprinted, never extracted. */
  configs: string[];
}

const projectFilesMemo = new AsyncLocalStorage<Map<string, ProjectFiles>>();

/**
 * Run `fn` with source-walk memoization enabled for its dynamic extent: every
 * listing of the same root inside shares one discovery pass. Re-entrant —
 * nested scopes join the outer memo (same logical operation). The memo is
 * dropped when `fn` settles; nothing persists across operations.
 */
export async function withSourceListMemo<T>(fn: () => Promise<T>): Promise<T> {
  if (projectFilesMemo.getStore() !== undefined) return fn();
  return projectFilesMemo.run(new Map(), fn);
}

/**
 * Drop the memoized listing of `root` for the current operation, so the next listing
 * re-discovers. For an operation that waited (a cross-process build lock) and must judge
 * freshness on what is on disk NOW, not on the listing taken before the wait.
 */
export function forgetSourceList(root: string): void {
  projectFilesMemo.getStore()?.delete(resolve(root));
}

type FileKind = "source" | "config";

/** Classify a file name: graph source, resolution config, or neither. */
function classify(name: string): FileKind | null {
  // Include code files (detectLang) OR YAML infra config (detectIsConfig). The
  // fine-grained routing (which extractor handles what) is done later by
  // ext.supports() in build.ts — here we just discover candidates.
  if (isMinifiedArtifact(name)) return null;
  if (detectLang(name) !== null || detectIsConfig(name)) return "source";
  return isResolutionConfig(name) ? "config" : null;
}

/** Every file the project consists of (sources + resolution configs), memoized per operation. */
export function listProjectFiles(root: string): ProjectFiles {
  const memo = projectFilesMemo.getStore();
  const memoKey = resolve(root);
  const cached = memo?.get(memoKey);
  // Defensive copies — callers may sort/mutate their listing without corrupting the memo.
  if (cached) return { sources: [...cached.sources], configs: [...cached.configs] };
  const found = listViaGit(root) ?? listViaWalk(root);
  memo?.set(memoKey, { sources: [...found.sources], configs: [...found.configs] });
  return found;
}

export function listSourceFiles(root: string): string[] {
  return listProjectFiles(root).sources;
}

export function listConfigFiles(root: string): string[] {
  return listProjectFiles(root).configs;
}

// Generous bounds for the one git call on the read path: a monorepo's listing can run to
// tens of MB, and a cold cache on a slow disk can take seconds. On timeout/overflow the
// call returns null and discovery falls back to the walk.
const GIT_LIST_TIMEOUT_MS = 15_000;
const GIT_LIST_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Discovery through git: tracked + untracked-not-ignored files under `root`, relative to it
 * (git scopes `ls-files` to the cwd subtree). Null when `root` is not inside a git work tree,
 * git is unavailable, or git lists nothing at all — the last case covers a root that is
 * itself ignored by an enclosing repo (`leina build coverage/`), where the walk is the only
 * way to see its files.
 */
function listViaGit(root: string): ProjectFiles | null {
  const out = safeGitRawOutput(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    root,
    {
      timeout: GIT_LIST_TIMEOUT_MS,
      maxBuffer: GIT_LIST_MAX_BUFFER,
      // HOME/XDG_CONFIG_HOME let git find the user's global excludes file, so
      // --exclude-standard matches what `git status` considers ignored.
      env: { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME },
    },
  );
  if (!out) return null;
  const found: ProjectFiles = { sources: [], configs: [] };
  for (const rel of out.split("\0")) {
    // "dir/" entries are untracked nested repositories / worktrees — never descended into.
    if (rel === "" || rel.endsWith("/")) continue;
    const segments = rel.split("/");
    const name = segments.pop()!;
    if (segments.some(isSkippedDir)) continue;
    const kind = classify(name);
    if (!kind) continue;
    const full = join(root, rel);
    // The index can name things that are not regular files on disk: a tracked file deleted
    // in the working tree, a submodule gitlink, a symlink. The walk never yields those
    // (Dirent.isFile), so neither does this path — lstat on candidates only.
    if (!isRegularFile(full)) continue;
    found[kind === "source" ? "sources" : "configs"].push(full);
  }
  return found;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Discovery by walking the tree (outside git): same filters, plus the nested-repo rule. */
function listViaWalk(root: string): ProjectFiles {
  const found: ProjectFiles = { sources: [], configs: [] };
  function walk(dir: string, isRoot: boolean): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A subdirectory with its own `.git` (dir or file) is another repository or a linked
    // worktree: its code belongs to that checkout, not to this project.
    if (!isRoot && entries.some((e) => e.name === ".git")) return;
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!isSkippedDir(e.name)) walk(full, false);
      } else if (e.isFile()) {
        const kind = classify(e.name);
        if (kind) found[kind === "source" ? "sources" : "configs"].push(full);
      }
    }
  }
  walk(root, true);
  return found;
}
