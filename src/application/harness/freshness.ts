// application/harness/freshness.ts — the working-tree FINGERPRINT that ties a
// persisted verify report to the exact tree it judged. verify records it next
// to the report; the commit guard (hooks.ts) recomputes it and trusts the
// report only when both match — "commit only when the gates pass" must not
// honor a verdict about a different tree.
//
// Content-based on purpose. The previous heuristic compared mtimes of
// .git/index and friends against the report, which misfired both ways: a
// read-only `git status` (it refreshes the index) made a green report stale,
// while overwriting a previously clean tracked file through the shell left it
// fresh. Here the identity of the tree is the changed-file set against the
// recorded base (committed + staged + worktree + untracked, exactly what
// verify's gates see) plus a per-file content identity. Everything outside
// that set is, by definition, identical to the base.
//
// Bounds (the guard runs on every commit/push command): per-file identities
// for the first FINGERPRINT_FILE_CAP paths only (the full path list is always
// compared); content is hashed for files up to HASH_MAX_FILE_BYTES within a
// total HASH_BUDGET_BYTES, larger or over-budget files fall back to
// size + mtime. Known gaps: git-ignored files are invisible to the diff (and
// to the gates), and an mtime-preserving rewrite of an over-budget file
// evades the fallback — the harness is a guardrail against accidents, not a
// sandbox (docs/concepts/07-harness.md).

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type GitPort } from "../../domain/harness/ports.ts";

const FINGERPRINT_VERSION = 1;
const FINGERPRINT_FILE_CAP = 2000;
const HASH_MAX_FILE_BYTES = 8 * 1024 * 1024;
const HASH_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * Paths that never make a report stale: task state (the report itself, the
 * contract, retries, plan …) and leina's own artifacts (graph, session
 * markers) — written by the harness and the hooks, not by the task.
 */
const EXCLUDED_PREFIXES = [".harness/state/", ".leina/"];

export interface FileIdentity {
  /** Absent from the working tree (a deletion is part of the diff). */
  missing?: true;
  size?: number;
  mtimeMs?: number;
  /** sha256 of the content (or of a symlink's target path), when within budget. */
  sha256?: string;
}

export interface WorktreeFingerprint {
  version: number;
  /** Base ref the changed set was computed against (absent: HEAD / index fallback). */
  base?: string;
  /** Every changed path (relative to the harness root), sorted, exclusions removed. */
  files: string[];
  /** Content identity per path, for the first FINGERPRINT_FILE_CAP files. */
  identities: Record<string, FileIdentity>;
}

/** Fingerprint of the current working tree, or undefined when no diff can be computed. */
export async function fingerprintWorktree(
  repoRoot: string,
  git: GitPort,
  base: string | undefined,
): Promise<WorktreeFingerprint | undefined> {
  const changed = await git.changedFiles(repoRoot, base);
  if (changed === null) return undefined;
  const files = changed.filter((f) => !EXCLUDED_PREFIXES.some((prefix) => f.startsWith(prefix)));
  const identities: Record<string, FileIdentity> = {};
  const budget = { bytes: HASH_BUDGET_BYTES };
  for (const file of files.slice(0, FINGERPRINT_FILE_CAP)) {
    identities[file] = await identify(path.join(repoRoot, file), budget);
  }
  return { version: FINGERPRINT_VERSION, ...(base !== undefined ? { base } : {}), files, identities };
}

/**
 * Does the working tree still match the fingerprint a report recorded? A
 * missing or malformed fingerprint (a report from an older leina, or one
 * written by hand) cannot vouch for any tree, so it never matches.
 */
export async function worktreeMatches(repoRoot: string, git: GitPort, recorded: unknown): Promise<boolean> {
  if (!isFingerprint(recorded)) return false;
  const current = await fingerprintWorktree(repoRoot, git, recorded.base);
  if (current === undefined) return false;
  if (current.files.length !== recorded.files.length) return false;
  if (current.files.some((f, i) => f !== recorded.files[i])) return false;
  for (const [file, identity] of Object.entries(recorded.identities)) {
    const now = current.identities[file];
    if (typeof identity !== "object" || identity === null || now === undefined) return false;
    if (!sameIdentity(identity, now)) return false;
  }
  return true;
}

async function identify(abs: string, budget: { bytes: number }): Promise<FileIdentity> {
  let info;
  try {
    // lstat: a symlink's identity is its target path (what git tracks), never
    // the content behind it.
    info = await fs.lstat(abs);
  } catch {
    return { missing: true };
  }
  const base = { size: info.size, mtimeMs: info.mtimeMs };
  try {
    if (info.isSymbolicLink()) return { ...base, sha256: sha256(await fs.readlink(abs)) };
    if (info.isFile() && info.size <= HASH_MAX_FILE_BYTES && info.size <= budget.bytes) {
      budget.bytes -= info.size;
      return { ...base, sha256: sha256(await fs.readFile(abs)) };
    }
  } catch {
    // unreadable — size + mtime is all we can vouch for
  }
  return base;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  if (a.missing === true || b.missing === true) return a.missing === b.missing;
  if (a.size !== b.size) return false;
  // Content hash when both sides have one (a touch alone stays fresh);
  // otherwise the size + mtime fallback.
  if (a.sha256 !== undefined && b.sha256 !== undefined) return a.sha256 === b.sha256;
  return a.mtimeMs === b.mtimeMs;
}

function isFingerprint(value: unknown): value is WorktreeFingerprint {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === FINGERPRINT_VERSION &&
    (v.base === undefined || typeof v.base === "string") &&
    Array.isArray(v.files) &&
    v.files.every((f) => typeof f === "string") &&
    typeof v.identities === "object" &&
    v.identities !== null &&
    !Array.isArray(v.identities)
  );
}
