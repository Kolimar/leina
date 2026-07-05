// project-detect.ts — derive a stable project key from the current working directory.
//
// Detection order (each step fails-open to the next):
//   0. config-lock  — .leina/config.json project_name
//   1. git-remote   — git remote get-url origin → parse URL → repo name
//   2. git-root     — git rev-parse --show-toplevel → basename
//   3. child-git-auto — exactly one immediate child dir with .git → recurse; many → throw
//   4. dir-basename — basename(cwd) always succeeds
//
// All keys pass through normalizeProjectKey (defined below). Do NOT use normalizeLabel
// from id.ts for project keys — that function collapses to underscores and is reserved
// for graph node IDs. Project keys use hyphens (FR-11).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { safeGitOutput } from "../../infrastructure/install/safe-exec.ts";
import { readWorkspaceConfig } from "./workspace-config.ts";

// ---------------------------------------------------------------------------
// normalizeProjectKey — project-key normalization (FR-11)
// ---------------------------------------------------------------------------

/**
 * Normalize a raw name into a stable project key.
 *
 * Rules (applied in order):
 *   1. NFKC-normalize (collapses compatibility variants)
 *   2. Lowercase
 *   3. Replace path separators and drive-letter colons with `-` before the
 *      general rule so they never produce a bare `-` collision
 *   4. Collapse runs of non-alphanumeric characters to a single `-`
 *   5. Trim leading/trailing `-`
 *   6. Fallback to `"project"` if the result would be empty
 *
 * Intentionally uses HYPHENS — not underscores. Do NOT reuse normalizeLabel
 * from id.ts here; that function uses underscores and is shared with graph
 * node IDs whose schema must not change.
 */
export function normalizeProjectKey(name: string): string {
  const raw = name
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[/\\:]+/g, "-") // path separators / drive letters → hyphen first
    .replaceAll(/[^a-z0-9]+/g, "-") // all other non-alphanumeric runs → hyphen
    .replaceAll(/(^-+)|(-+$)/g, ""); // trim leading/trailing hyphens
  return raw.length > 0 ? raw : "project";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectionMethod =
  | "config-lock"
  | "git-remote"
  | "git-root"
  | "child-git-auto"
  | "dir-basename";

export interface ProjectDetection {
  key: string;
  method: DetectionMethod;
  rawName?: string;
  candidates?: string[];
}

export class AmbiguousProjectError extends Error {
  readonly candidates: string[];
  constructor(candidates: string[]) {
    super(
      `ambiguous project: found ${candidates.length} child repos (${candidates.join(", ")}). ` +
        `Lock the project name by creating .leina/config.json with {"project_name":"<name>"}.`,
    );
    this.name = "AmbiguousProjectError";
    this.candidates = candidates;
  }
}

// ---------------------------------------------------------------------------
// Workspace detection types (FR-01/02/03)
// ---------------------------------------------------------------------------

export type WorkspaceMode = "single" | "workspace";

export interface WorkspaceMember {
  /** Absolute path to the member repo directory. */
  dir: string;
  /** Derived project key for the member repo. */
  repoKey: string;
}

export interface WorkspaceDetection {
  mode: WorkspaceMode;
  /** Empty in single mode. Populated with all (non-excluded) members in workspace mode. */
  members: WorkspaceMember[];
  /** How the mode was determined. */
  source: "flag" | "workspace.json" | "child-git-auto" | "git-root";
}

/**
 * Detect whether `dir` is a single-repo or multi-repo workspace.
 *
 * Precedence (highest → lowest):
 *   1. flags: --single (single) / --workspace (workspace) override everything
 *   2. workspace.json present at dir root → workspace mode
 *   3. ≥2 immediate child dirs with .git → workspace mode
 *   4. .git in the root or exactly 1 child .git → single
 *
 * Never throws. Advisory logged to stderr when repos are truncated at `max`.
 */
export function detectWorkspaceMode(
  dir: string,
  flags: { single?: boolean; workspace?: boolean },
): WorkspaceDetection {
  const resolved = resolve(dir);

  // 1. Explicit flags — highest precedence
  if (flags.single) {
    return { mode: "single", members: [], source: "flag" };
  }
  if (flags.workspace) {
    const members = buildMembers(resolved, []);
    return { mode: "workspace", members, source: "flag" };
  }

  // 2. workspace.json marker
  const wsCfg = readWorkspaceConfig(resolved);
  if (wsCfg !== null) {
    const members = buildMembers(resolved, wsCfg.exclude);
    // Advisory: if any exclude entry doesn't match any found repo name
    const memberNames = new Set(members.map((m) => basename(m.dir)));
    for (const ex of wsCfg.exclude) {
      if (!memberNames.has(ex) && !findChildRepos(resolved).includes(ex)) {
        process.stderr.write(
          `leina: workspace.json exclude: '${ex}' does not match any child repo (ignored)\n`,
        );
      }
    }
    return { mode: "workspace", members, source: "workspace.json" };
  }

  // 3. Auto-detect from child .git dirs
  const children = findChildRepos(resolved);
  if (children.length >= 2) {
    const members = children.map((name) => ({
      dir: join(resolved, name),
      repoKey: deriveProjectKey(join(resolved, name)).key,
    }));
    return { mode: "workspace", members, source: "child-git-auto" };
  }

  // 4. Single mode: .git in root, or exactly 1 child, or no .git found
  return { mode: "single", members: [], source: "git-root" };
}

/** Build workspace members from child repos, honouring exclude list. */
function buildMembers(resolved: string, exclude: string[]): WorkspaceMember[] {
  const excludeSet = new Set(exclude);
  const children = findChildRepos(resolved);
  return children
    .filter((name) => !excludeSet.has(name))
    .map((name) => ({
      dir: join(resolved, name),
      repoKey: deriveProjectKey(join(resolved, name)).key,
    }));
}

// ---------------------------------------------------------------------------
// config.json helpers
// ---------------------------------------------------------------------------

export function readProjectConfig(cwd: string): { project_name: string } | null {
  const cfgPath = join(cwd, ".leina", "config.json");
  try {
    const raw = readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "project_name" in parsed &&
      typeof (parsed).project_name === "string" &&
      (parsed as { project_name: string }).project_name.trim().length > 0
    ) {
      return { project_name: (parsed as { project_name: string }).project_name };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeProjectConfig(cwd: string, name: string): void {
  const dir = join(cwd, ".leina");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify({ project_name: name }, null, 2)  }\n`);
}

// ---------------------------------------------------------------------------
// URL parsing — pure helper, no I/O
// ---------------------------------------------------------------------------

/**
 * Parsed result from a git remote URL.
 * `name`  — repo name (last path segment, .git stripped)
 * `org`   — org/user (penultimate segment), or undefined for local paths
 */
export interface ParsedRemote {
  name: string;
  org?: string;
}

/**
 * Parse a git remote URL into { name, org? }.
 * Returns null if the name segment is empty.
 *
 * Handles:
 *   https://github.com/org/repo.git
 *   git@github.com:org/repo.git  (scp-like SSH)
 *   ssh://git@host:22/org/repo.git  (SSH with port)
 *   /local/path/to/repo.git
 */
export function parseRemote(url: string): ParsedRemote | null {
  let u = url.trim().replace(/\/+$/, ""); // strip trailing slashes
  if (!u) return null;

  // Strip trailing .git
  if (u.endsWith(".git")) u = u.slice(0, -4);

  // Normalise scp-like SSH (git@host:org/repo) by replacing the first colon after @host
  // with a slash so we can handle all forms uniformly via lastIndexOf("/").
  // Pattern: something@host:path (no schema prefix)
  if (!u.includes("://") && u.includes("@") && u.includes(":")) {
    const atIdx = u.indexOf("@");
    const colonIdx = u.indexOf(":", atIdx);
    if (colonIdx > atIdx) {
      u = `${u.slice(0, colonIdx)  }/${  u.slice(colonIdx + 1)}`;
    }
  }

  // Now split on "/" to get path segments
  const parts = u.split("/").filter((s) => s.length > 0);
  if (parts.length === 0) return null;

  const name = parts[parts.length - 1]!.trim();
  if (!name) return null;

  // org is the penultimate segment if it exists and doesn't look like a host
  let org: string | undefined;
  if (parts.length >= 2) {
    const candidate = parts[parts.length - 2]!;
    // Skip if it looks like a hostname (contains dot) or has a port (@host:22 → "git@host")
    // After normalisation the host/user comes before org, so penultimate is ok
    if (!candidate.includes(".") && !candidate.includes("@")) {
      org = candidate || undefined;
    }
  }

  return { name, org };
}

/**
 * Backward-compatible wrapper — returns only the repo name (last segment).
 * Callers and snapshots using `repoNameFromRemote` are not affected (NFR-02).
 */
export function repoNameFromRemote(url: string): string | null {
  return parseRemote(url)?.name ?? null;
}

// ---------------------------------------------------------------------------
// B2: org/repo project key format (FR-11)
// ---------------------------------------------------------------------------

/**
 * Read config.json and return the `project_key_format` field if present.
 * Returns null when absent or not "org/repo".
 */
export function readProjectKeyFormat(cwd: string): "org/repo" | null {
  const cfgPath = join(cwd, ".leina", "config.json");
  try {
    const raw = readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "project_key_format" in parsed &&
      (parsed).project_key_format === "org/repo"
    ) {
      return "org/repo";
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git helpers — fail-open (return null on any error)
// ---------------------------------------------------------------------------

const NOISE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
  "vendor",
  "target",
  ".venv",
  "__pycache__",
]);

function gitOutput(args: string[], cwd: string): string | null {
  return safeGitOutput(args, cwd);
}

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

export function deriveProjectKey(cwd: string): ProjectDetection {
  const resolved = resolve(cwd);

  // Step 0: config-lock
  const fromConfig = detectFromConfig(resolved);
  if (fromConfig) return fromConfig;

  // Step 1: git-remote
  const fromRemote = detectFromGitRemote(resolved);
  if (fromRemote) return fromRemote;

  // Step 2: git-root basename
  const fromRoot = detectFromGitRoot(resolved);
  if (fromRoot) return fromRoot;

  // Step 3: child-git-auto
  const fromChild = detectFromChildGit(resolved);
  if (fromChild) return fromChild;

  // Step 4: dir-basename fallback
  const rawName = basename(resolved);
  return { key: normalizeProjectKey(rawName), method: "dir-basename", rawName };
}

/**
 * Derive the project key for a **workspace root** without risking
 * `AmbiguousProjectError`.
 *
 * Workspace roots contain multiple child git repos; running the normal
 * `child-git-auto` detection step (step 3 of `deriveProjectKey`) would throw
 * because finding ≥2 child repos is ambiguous for the single-repo path — but it
 * is the *expected* state for a workspace root.  This function skips that step:
 *
 *   config-lock → git-remote → git-root-basename → dir-basename
 *
 * It is intentionally never throws and is the **only** safe way to get a
 * project key for a workspace root directory.
 *
 * @param wsRoot - absolute or relative path to the workspace root
 */
export function deriveWorkspaceRootKey(wsRoot: string): string {
  const resolved = resolve(wsRoot);

  // Step 0: config-lock (.leina/config.json project_name)
  const fromConfig = detectFromConfig(resolved);
  if (fromConfig) return fromConfig.key;

  // Step 1: git-remote origin URL basename
  const fromRemote = detectFromGitRemote(resolved);
  if (fromRemote) return fromRemote.key;

  // Step 2: git rev-parse --show-toplevel basename
  const fromRoot = detectFromGitRoot(resolved);
  if (fromRoot) return fromRoot.key;

  // Step 3: INTENTIONALLY SKIPPED — child-git-auto throws AmbiguousProjectError
  //         when ≥2 child repos exist, which is the normal state for a workspace root.

  // Step 4: dir-basename — always succeeds (never empty after normalisation)
  return normalizeProjectKey(basename(resolved));
}

// Step 0: config-lock
function detectFromConfig(resolved: string): ProjectDetection | null {
  const cfg = readProjectConfig(resolved);
  if (!cfg) return null;
  const rawName = cfg.project_name;
  return { key: normalizeProjectKey(rawName), method: "config-lock", rawName };
}

// Step 1: git-remote
function detectFromGitRemote(resolved: string): ProjectDetection | null {
  const remoteUrl = gitOutput(["remote", "get-url", "origin"], resolved);
  if (!remoteUrl) return null;
  const parsed = parseRemote(remoteUrl);
  if (!parsed) return null;

  // B2: if project_key_format = "org/repo", use "org/repo" as the key
  const fmt = readProjectKeyFormat(resolved);
  if (fmt === "org/repo" && parsed.org) {
    const rawName = `${parsed.org}/${parsed.name}`;
    return { key: normalizeProjectKey(rawName), method: "git-remote", rawName };
  }

  const rawName = parsed.name;
  return { key: normalizeProjectKey(rawName), method: "git-remote", rawName };
}

// Step 2: git-root basename
function detectFromGitRoot(resolved: string): ProjectDetection | null {
  const toplevel = gitOutput(["rev-parse", "--show-toplevel"], resolved);
  if (!toplevel) return null;
  const rawName = basename(toplevel);
  return { key: normalizeProjectKey(rawName), method: "git-root", rawName };
}

// Step 3: child-git-auto
function detectFromChildGit(resolved: string): ProjectDetection | null {
  try {
    const candidates = findChildRepos(resolved);

    if (candidates.length === 1) {
      const childDir = join(resolved, candidates[0]!);
      // Recursively derive from child dir — but override method to child-git-auto
      // If child itself is ambiguous, bubble it up
      const inner = deriveProjectKey(childDir);
      return {
        key: inner.key,
        method: "child-git-auto",
        rawName: inner.rawName ?? candidates[0],
        candidates: undefined,
      };
    } else if (candidates.length > 1) {
      throw new AmbiguousProjectError(candidates);
    }
    // zero candidates → fall through
  } catch (e) {
    if (e instanceof AmbiguousProjectError) throw e;
    // Other fs errors → fail-open, fall through
  }
  return null;
}

/**
 * Scan immediate child directories (skipping noise) for ones containing a `.git`.
 * If more than `max` repos are found, an advisory is emitted to stderr and the
 * list is truncated (advisory-only, not an error).
 *
 * @param resolved - absolute directory to scan
 * @param max      - advisory limit (default 200). Callers can override.
 */
export function findChildRepos(resolved: string, max = 200): string[] {
  let names: string[];
  try {
    names = readdirSync(resolved);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const name of names) {
    if (NOISE_DIRS.has(name)) continue;
    const childPath = join(resolved, name);
    try {
      if (existsSync(join(childPath, ".git"))) {
        candidates.push(name);
      }
    } catch {
      // skip unreadable entries
    }
  }
  if (candidates.length > max) {
    process.stderr.write(
      `leina: found ${candidates.length} child repos, truncating to ${max}. ` +
        `Declare a workspace.json to be explicit about which repos to include.\n`,
    );
    return candidates.slice(0, max);
  }
  return candidates;
}
