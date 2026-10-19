// Build manifest + staleness check. The manifest records the source file set and,
// per file, the mtime AND a content hash captured at build time; isStale() compares
// the current sources against it so the server can self-refresh a graph whose sources
// changed under it. The content hash lets isStale() ignore mtime-only changes
// (git checkout, save-without-edit) that don't actually alter the source.
//
// It also records what the graph was built WITH, not only from: the leina version and
// the extractor schema version (a graph built by an older extractor is stale after an
// upgrade, even though no source changed), and the resolution-affecting config files
// (tsconfig*.json, jsconfig.json, package.json — an edited `paths` map re-routes imports).
// fullExtractionReason() exposes the same "basis" comparison to incremental extraction:
// any per-file result cached by a previous build is invalid when it returns non-null.
//
// It also records the git commit SHA the graph was built against, so memory
// observations anchored to graph nodes can later be validated against a known snapshot,
// and the reduced-precision paths the build fell back to (`degraded`, for `leina status`).
//
// Pure (no SDK, no extractor imports) so it stays cheap to load and unit-test.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { safeGitOutput } from "../../infrastructure/install/safe-exec.ts";
import { readPackageVersion } from "../../version.ts";
import { exceedsSourceCap, listConfigFiles, listSourceFiles } from "./sources.ts";

// 2: per-file entries went from a bare mtime number to { mtime, hash }, commitSha added.
// 3: leinaVersion, extractorSchema, configs and degraded added. A manifest of another
// version is never read as current (readManifest → null); isStale() reports it as
// "leina upgraded" so the next read rebuilds and re-stamps it in the new shape.
export const MANIFEST_VERSION = 3;

/**
 * Bump whenever an extractor change alters the graph a build produces for UNCHANGED sources
 * (new node/edge kinds, id scheme, resolution rules, a re-vendored grammar). Unlike the
 * package version, it also moves for a working-copy (`npm link`) install, whose version does
 * not change per commit. A mismatch makes the graph stale and forces a full extraction.
 */
export const EXTRACTOR_SCHEMA_VERSION = 1;

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
  /** Package version of the leina that built this graph. */
  leinaVersion: string;
  /** EXTRACTOR_SCHEMA_VERSION of the leina that built this graph. */
  extractorSchema: number;
  fileCount: number;
  // relPOSIX path -> { mtime, hash } captured at build time
  files: Record<string, ManifestFileEntry>;
  /** Resolution-affecting config files (sources.ts isResolutionConfig), same entry shape. */
  configs: Record<string, ManifestFileEntry>;
  /** Reduced-precision paths the build fell back to (BuildReport.degraded). */
  degraded: string[];
}

export interface StaleResult {
  stale: boolean;
  // "fresh" | "no-manifest" | "leina upgraded (…)" | "extractor changed (…)"
  // | "added:<rel>" | "removed:<rel>" | "touched:<rel>" | "config changed:<rel>"
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

/** relPOSIX -> { mtime, hash } for `files`, skipping vanished and (optionally) oversize ones. */
function fingerprint(root: string, files: string[], capped: boolean): Record<string, ManifestFileEntry> {
  const map: Record<string, ManifestFileEntry> = {};
  for (const abs of files) {
    try {
      const st = statSync(abs);
      // Never hash (or track) a source above the size cap — the build skips it too.
      if (capped && exceedsSourceCap(st.size)) continue;
      map[toRel(root, abs)] = { mtime: st.mtimeMs, hash: sha256(abs) };
    } catch {
      // file vanished between listing and stat/read — skip it; next build re-syncs.
    }
  }
  return map;
}

export interface WriteManifestOptions {
  /** Resolution configs from the same listing as `files`; listed afresh when omitted. */
  configs?: string[];
  /** BuildReport.degraded of the build being stamped. */
  degraded?: string[];
}

export function writeManifest(root: string, files: string[], opts: WriteManifestOptions = {}): void {
  const r = resolvePath(root);
  const map = fingerprint(r, files, true);
  const manifest: BuildManifest = {
    manifestVersion: MANIFEST_VERSION,
    builtAt: Date.now(),
    commitSha: gitCommitSha(r),
    sourceRoot: r,
    leinaVersion: readPackageVersion(),
    extractorSchema: EXTRACTOR_SCHEMA_VERSION,
    fileCount: Object.keys(map).length,
    files: map,
    configs: fingerprint(r, opts.configs ?? listConfigFiles(root), false),
    degraded: opts.degraded ?? [],
  };
  const p = manifestPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(manifest, null, 2), "utf8");
}

/** The parsed manifest file whatever its version, or null when absent/unparseable. */
function readRawManifest(root: string): Partial<BuildManifest> | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(root), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function isEntryMap(v: unknown): v is Record<string, ManifestFileEntry> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The raw manifest as a current-shape BuildManifest, or null when it is not one. */
function asCurrent(raw: Partial<BuildManifest> | null): BuildManifest | null {
  if (raw?.manifestVersion !== MANIFEST_VERSION) return null;
  if (!isEntryMap(raw.files) || !isEntryMap(raw.configs)) return null;
  return {
    ...(raw as BuildManifest),
    degraded: Array.isArray(raw.degraded) ? raw.degraded.filter((d) => typeof d === "string") : [],
  };
}

export function readManifest(root: string): BuildManifest | null {
  return asCurrent(readRawManifest(root));
}

// ---------------------------------------------------------------------------
// Build basis — what the graph was built WITH (leina, extractor schema, configs).
// ---------------------------------------------------------------------------

/** Numeric dotted-version compare (pre-release tags ignored): <0, 0, >0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const d = (Number.isFinite(pa[i]) ? pa[i]! : 0) - (Number.isFinite(pb[i]) ? pb[i]! : 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Why the graph's build basis no longer matches this leina — a different manifest format,
 * package version or extractor schema — or null when it matches. The graph was produced by
 * other extractor code, so neither it nor any per-file result cached alongside it is valid.
 */
function basisChange(raw: Partial<BuildManifest>): string | null {
  const current = readPackageVersion();
  if (raw.manifestVersion !== MANIFEST_VERSION || typeof raw.leinaVersion !== "string") {
    return typeof raw.leinaVersion === "string"
      ? `leina upgraded (${raw.leinaVersion} → ${current})`
      : `leina upgraded (graph built by an older leina → ${current})`;
  }
  if (raw.leinaVersion !== current) {
    const verb = compareVersions(current, raw.leinaVersion) < 0 ? "downgraded" : "upgraded";
    return `leina ${verb} (${raw.leinaVersion} → ${current})`;
  }
  if (raw.extractorSchema !== EXTRACTOR_SCHEMA_VERSION) {
    return `extractor changed (schema ${String(raw.extractorSchema)} → ${EXTRACTOR_SCHEMA_VERSION})`;
  }
  return null;
}

/** First resolution-config change (added/removed/edited) against the manifest, or null. */
function configChange(r: string, manifest: BuildManifest, currentConfigs: string[]): StaleResult | null {
  const current = new Map<string, string>();
  for (const abs of currentConfigs) current.set(toRel(r, abs), abs);
  for (const rel of current.keys()) {
    if (!(rel in manifest.configs)) return { stale: true, reason: `config changed:${rel}` };
  }
  for (const [rel, entry] of Object.entries(manifest.configs)) {
    const abs = current.get(rel);
    if (!abs || changedSince(abs, entry, false) !== null) return { stale: true, reason: `config changed:${rel}` };
  }
  return null;
}

/**
 * Why a build must re-extract EVERY file instead of reusing per-file results cached by a
 * previous build of `root`, or null when reuse is safe as far as the build basis goes (the
 * caller still re-extracts the files whose own content changed). Non-null when there is no
 * previous build, the previous one was made by another leina version / extractor schema /
 * manifest format, or a resolution config (tsconfig*.json, jsconfig.json, package.json) was
 * added, removed or edited since. Call it BEFORE the build stamps its new manifest.
 * `configs` is the build's own listing (listProjectFiles(root).configs); listed when omitted.
 */
export function fullExtractionReason(root: string, configs?: string[]): string | null {
  const raw = readRawManifest(root);
  if (!raw) return "no previous build";
  const basis = basisChange(raw);
  if (basis) return basis;
  const manifest = asCurrent(raw);
  if (!manifest) return "no previous build";
  return configChange(resolvePath(root), manifest, configs ?? listConfigFiles(root))?.reason ?? null;
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
  /** Reduced-precision paths of the last build (empty when none, or never built). */
  degraded: string[];
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
    degraded: manifest?.degraded ?? [],
  };
}

// Compares the build basis and the current sources/configs against the manifest. Returns on
// the first staleness signal so the reason is deterministic. Absent/corrupt manifest =>
// "no-manifest"; another manifest version, leina version or extractor schema => "leina
// upgraded …" / "extractor changed …". A bumped mtime is confirmed against the content hash
// before counting as "touched", so a checkout or save-without-edit stays fresh.
export function isStale(root: string, files?: string[]): StaleResult {
  const raw = readRawManifest(root);
  if (!raw) return { stale: true, reason: "no-manifest" };
  const basis = basisChange(raw);
  if (basis) return { stale: true, reason: basis };
  const manifest = asCurrent(raw);
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

  return configChange(r, manifest, listConfigFiles(root)) ?? { stale: false, reason: "fresh" };
}

// Added: a current source the manifest never recorded — unless it is above the size
// cap, which the build skips (it is permanently untracked, not a pending addition).
// Only untracked files are stat'ed here, so the common case costs nothing extra.
function findAdded(
  currentRel: Map<string, string>,
  manifest: BuildManifest,
): StaleResult | null {
  for (const [rel, abs] of currentRel) {
    if (rel in manifest.files) continue;
    let oversize = false;
    try {
      oversize = exceedsSourceCap(statSync(abs).size);
    } catch {
      // vanished since the walk — report it like any other new file
    }
    if (!oversize) return { stale: true, reason: `added:${rel}` };
  }
  return null;
}

/**
 * How a fingerprinted file differs from its manifest entry: "removed" (gone/unstattable),
 * "touched" (content changed), or null (unchanged). With `capped`, growing past the source
 * size cap counts as touched without hashing a file that may be arbitrarily large.
 */
function changedSince(abs: string, entry: ManifestFileEntry, capped: boolean): "removed" | "touched" | null {
  let mtime: number;
  let size: number;
  try {
    ({ mtimeMs: mtime, size } = statSync(abs));
  } catch {
    return "removed";
  }
  if (capped && exceedsSourceCap(size)) return "touched";
  // strict >: manifest mtimes are captured at/after read time, so equal is fresh.
  // When the mtime moved, confirm with the content hash — an mtime bump with
  // identical content (checkout, save-without-edit) is NOT a real change.
  if (mtime > entry.mtime) {
    let hash: string;
    try {
      hash = sha256(abs);
    } catch {
      return "removed";
    }
    // eslint-disable-next-line security/detect-possible-timing-attacks -- comparing file content hashes for staleness/cache invalidation, not secrets/tokens; timing is irrelevant.
    if (hash !== entry.hash) return "touched";
  }
  return null;
}

// One tracked source: removed, touched, or fresh (null). Returns the first staleness signal.
function checkTrackedFile(
  rel: string,
  entry: ManifestFileEntry,
  abs: string | undefined,
): StaleResult | null {
  if (!abs) return { stale: true, reason: `removed:${rel}` };
  const change = changedSince(abs, entry, true);
  return change ? { stale: true, reason: `${change}:${rel}` } : null;
}
