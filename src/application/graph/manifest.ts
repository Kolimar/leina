// Build manifest + staleness check. The manifest records the source file set and,
// per file, the mtime AND a content hash captured at build time; isStale() compares
// the current sources against it so the server can self-refresh a graph whose sources
// changed under it. The content hash lets isStale() ignore mtime-only changes
// (git checkout, save-without-edit) that don't actually alter the source.
//
// It also records the git commit SHA the graph was built against, so memory
// observations anchored to graph nodes can later be validated against a known snapshot.
//
// Pure (no SDK, no extractor imports) so it stays cheap to load and unit-test.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { safeGitOutput } from "../../infrastructure/install/safe-exec.ts";
import { listSourceFiles } from "./sources.ts";

// Bumped to 2 when per-file entries went from a bare mtime number to { mtime, hash }
// and commitSha was added. A manifest written by an older binary (version mismatch
// or missing) is treated as absent so the next build re-stamps it in the new shape.
export const MANIFEST_VERSION = 2;

export interface ManifestFileEntry {
  mtime: number; // mtimeMs captured at build time
  hash: string; // sha256 hex of file content at build time
}

export interface BuildManifest {
  manifestVersion: number;
  builtAt: number;
  // git HEAD the graph was built against, or null outside a git repo.
  commitSha: string | null;
  sourceRoot: string;
  fileCount: number;
  // relPOSIX path -> { mtime, hash } captured at build time
  files: Record<string, ManifestFileEntry>;
}

export interface StaleResult {
  stale: boolean;
  // "fresh" | "no-manifest" | "added:<rel>" | "removed:<rel>" | "touched:<rel>"
  reason: string;
}

export function manifestPath(root: string): string {
  return join(resolvePath(root), ".leina", "graph.manifest.json");
}

// POSIX relpath, matching the sourceFile keys used across the graph (build.ts).
function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function sha256(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

// git HEAD for provenance. Returns null outside a git repo or if git is unavailable.
function gitCommitSha(root: string): string | null {
  const out = safeGitOutput(["rev-parse", "HEAD"], root);
  return out && out.length > 0 ? out : null;
}

export function writeManifest(root: string, files: string[]): void {
  const r = resolvePath(root);
  const map: Record<string, ManifestFileEntry> = {};
  for (const abs of files) {
    try {
      const mtime = statSync(abs).mtimeMs;
      map[toRel(r, abs)] = { mtime, hash: sha256(abs) };
    } catch {
      // file vanished between listing and stat/read — skip it; next build re-syncs.
    }
  }
  const manifest: BuildManifest = {
    manifestVersion: MANIFEST_VERSION,
    builtAt: Date.now(),
    commitSha: gitCommitSha(r),
    sourceRoot: r,
    fileCount: Object.keys(map).length,
    files: map,
  };
  const p = manifestPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(manifest, null, 2), "utf8");
}

export function readManifest(root: string): BuildManifest | null {
  try {
    const raw = readFileSync(manifestPath(root), "utf8");
    const parsed = JSON.parse(raw) as BuildManifest;
    if (parsed?.manifestVersion !== MANIFEST_VERSION) return null;
    if (typeof parsed.files !== "object" || parsed.files === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// graphStatus — composite status for the graph.status capability (D2 decision).
// Composes isStale() + readManifest() without modifying either function.
// Takes `root` (not a port) because it only reads the filesystem, not the graph DB.
// ---------------------------------------------------------------------------

export interface GraphStatusResult {
  stale: boolean;
  reason: string;
  commitSha: string | null;
  builtAt: number | null;
  fileCount: number;
}

export function graphStatus(root: string): GraphStatusResult {
  const staleResult = isStale(root);
  const manifest = readManifest(root);
  return {
    stale: staleResult.stale,
    reason: staleResult.reason,
    commitSha: manifest?.commitSha ?? null,
    builtAt: manifest?.builtAt ?? null,
    fileCount: manifest?.fileCount ?? 0,
  };
}

// Compares current sources against the manifest. Returns on the first staleness
// signal so the reason is deterministic. Absent/corrupt/old-version manifest => stale.
// A bumped mtime is confirmed against the content hash before counting as "touched",
// so a checkout or save-without-edit that only moves the mtime stays fresh.
export function isStale(root: string, files?: string[]): StaleResult {
  const manifest = readManifest(root);
  if (!manifest) return { stale: true, reason: "no-manifest" };

  const r = resolvePath(root);
  const current = files ?? listSourceFiles(root);
  const currentRel = new Map<string, string>();
  for (const abs of current) currentRel.set(toRel(r, abs), abs);

  const added = findAdded(currentRel, manifest);
  if (added) return added;

  // Removed or touched: walk what the manifest tracked.
  for (const rel of Object.keys(manifest.files)) {
    const result = checkTrackedFile(rel, manifest.files[rel]!, currentRel.get(rel));
    if (result) return result;
  }

  return { stale: false, reason: "fresh" };
}

// Added: a current source the manifest never recorded.
function findAdded(
  currentRel: Map<string, string>,
  manifest: BuildManifest,
): StaleResult | null {
  for (const rel of currentRel.keys()) {
    if (!(rel in manifest.files)) return { stale: true, reason: `added:${rel}` };
  }
  return null;
}

// One tracked file: removed (gone/unstattable), touched (content changed), or
// fresh (null). Returns the first staleness signal found.
function checkTrackedFile(
  rel: string,
  entry: ManifestFileEntry,
  abs: string | undefined,
): StaleResult | null {
  if (!abs) return { stale: true, reason: `removed:${rel}` };
  let mtime: number;
  try {
    mtime = statSync(abs).mtimeMs;
  } catch {
    return { stale: true, reason: `removed:${rel}` };
  }
  // strict >: manifest mtimes are captured at/after read time, so equal is fresh.
  // When the mtime moved, confirm with the content hash — an mtime bump with
  // identical content (checkout, save-without-edit) is NOT a real change.
  if (mtime > entry.mtime) {
    let hash: string;
    try {
      hash = sha256(abs);
    } catch {
      return { stale: true, reason: `removed:${rel}` };
    }
    // eslint-disable-next-line security/detect-possible-timing-attacks -- comparing file content hashes for staleness/cache invalidation, not secrets/tokens; timing is irrelevant.
    if (hash !== entry.hash) return { stale: true, reason: `touched:${rel}` };
  }
  return null;
}
