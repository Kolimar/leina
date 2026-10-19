// application/harness/adapters/writer.ts — the single component of the sync
// engine that touches disk. Adapters are pure; all idempotency and
// clobber-safety live here, backed by the committed lockfile.
//
// COMPATIBILITY CONTRACT: `.harness/harness.lock.json` keeps the origin
// harness-framework's v1 format byte-for-byte —
//   { version: 1, sourceHash, artifacts: [{ path, adapter, kind, blockId?, contentHash }] }
// — so repos synced by the original `npx harness sync` are picked up in place.
// (The origin validated it with zod; leina hand-rolls the same checks — zero
// new dependencies.)

import path from "node:path";
import fs from "node:fs/promises";
import { chmodSync, lstatSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { HARNESS_DIR, harnessDir } from "../config-io.ts";
import { readJsonIfExists, readTextIfExists } from "../io.ts";
import { blockHandEdited, removeManagedBlock, sha256, upsertManagedBlock } from "./managed-block.ts";
import {
  mergeCursorHooks,
  mergeOpencodeInstructions,
  stripHarnessJsonEntries,
  type JsonMergeResult,
} from "./json-merge.ts";
import { type FileSet, type GeneratedFile, type WriteKind } from "./types.ts";

export interface LockfileArtifact {
  path: string;
  adapter: string;
  kind: WriteKind;
  blockId?: string;
  contentHash: string;
}

export interface Lockfile {
  version: 1;
  sourceHash: string;
  artifacts: LockfileArtifact[];
}

/** Repo-relative lockfile path (forward slashes — the form sync reports). */
export const LOCKFILE_REL = `${HARNESS_DIR}/harness.lock.json`;

export function lockfilePath(repoRoot: string): string {
  return path.join(harnessDir(repoRoot), "harness.lock.json");
}

const WRITE_KINDS: readonly string[] = ["owned", "managed-block", "json-merge"];

/**
 * Lexical safety of a repo-relative artifact path. The lockfile is committed —
 * attacker-controlled in a cloned repo — and its paths drive deletes (orphan
 * cleanup, deinit) and rewrites, so only plain relative paths strictly inside
 * the repo pass: no absolute (POSIX, drive, UNC) paths, no `..` segment (either
 * separator), no NUL, and nothing in git's own metadata dir.
 */
export function isSafeArtifactPath(rel: string): boolean {
  if (rel.includes("\0")) return false;
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  const segments = rel.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return false; // the repo root itself
  return !segments.some((s) => s === ".." || s.toLowerCase() === ".git");
}

export const OUTSIDE_REPO_DETAIL = "refused: path resolves outside the repository (absolute, `..` or symlinked)";

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Realpath containment for a repo-relative artifact path — the check that
 * must precede every rm/write the lockfile can steer. The target (symlinks
 * followed) or, when it does not exist yet, its nearest existing ancestor must
 * resolve inside the repo's real root; a dangling link anywhere on the way is
 * refused (it cannot be proven safe). Returns the absolute path to operate on,
 * or undefined to refuse. Synchronous so the sync engine and the synchronous
 * deinit share one implementation.
 */
export function containedArtifactPath(repoRoot: string, rel: string): string | undefined {
  if (!isSafeArtifactPath(rel)) return undefined;
  let realRoot: string;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    return undefined;
  }
  const absolute = path.resolve(repoRoot, rel);
  for (let probe = absolute; ; probe = path.dirname(probe)) {
    let exists = true;
    try {
      lstatSync(probe);
    } catch {
      exists = false;
    }
    if (exists) {
      try {
        return isWithin(realRoot, realpathSync(probe)) ? absolute : undefined;
      } catch {
        return undefined; // dangling symlink
      }
    }
    if (path.dirname(probe) === probe) return undefined;
  }
}

/** Structural validation of the v1 lockfile — same constraints as the origin zod schema. */
export function parseLockfile(value: unknown): Lockfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || typeof root.sourceHash !== "string" || !Array.isArray(root.artifacts)) {
    return undefined;
  }
  const artifacts: LockfileArtifact[] = [];
  for (const raw of root.artifacts) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const a = raw as Record<string, unknown>;
    if (
      typeof a.path !== "string" ||
      // Stricter than the origin schema on purpose: a lockfile naming a path
      // outside the repo is hostile, never a format variant — ignore it whole.
      !isSafeArtifactPath(a.path) ||
      typeof a.adapter !== "string" ||
      typeof a.kind !== "string" ||
      !WRITE_KINDS.includes(a.kind) ||
      typeof a.contentHash !== "string" ||
      (a.blockId !== undefined && typeof a.blockId !== "string")
    ) {
      return undefined;
    }
    artifacts.push({
      path: a.path,
      adapter: a.adapter,
      kind: a.kind as WriteKind,
      ...(a.blockId !== undefined ? { blockId: a.blockId } : {}),
      contentHash: a.contentHash,
    });
  }
  return { version: 1, sourceHash: root.sourceHash, artifacts };
}

export async function readLockfile(repoRoot: string): Promise<Lockfile | undefined> {
  const raw = await readJsonIfExists(lockfilePath(repoRoot));
  if (raw.value === undefined) return undefined;
  return parseLockfile(raw.value);
}

/**
 * Atomic write for files the USER co-owns (CLAUDE.md, opencode.json,
 * .cursor/hooks.json, the lockfile): write to a temp file in the SAME
 * directory, then rename over the target — rename(2) is atomic on POSIX, so a
 * crash mid-write can never leave a truncated half-file behind. Permissions:
 * an explicit `mode` wins; otherwise an existing target's mode is preserved
 * (rename would silently replace it with the temp file's default).
 */
export async function writeFileAtomic(absolute: string, content: string, mode?: number): Promise<void> {
  let finalMode = mode;
  if (finalMode === undefined) {
    try {
      finalMode = (await fs.stat(absolute)).mode & 0o7777;
    } catch {
      // new file — platform default (umask) applies
    }
  }
  const tmp = atomicTempPath(absolute);
  try {
    await fs.writeFile(tmp, content, "utf8");
    if (finalMode !== undefined) await fs.chmod(tmp, finalMode);
    await fs.rename(tmp, absolute);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function atomicTempPath(absolute: string): string {
  return path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.harness-tmp-${crypto.randomBytes(6).toString("hex")}`,
  );
}

/** Synchronous twin of writeFileAtomic — for deinit and the init seed, which are synchronous. */
export function writeFileAtomicSync(absolute: string, content: string, mode?: number): void {
  let finalMode = mode;
  if (finalMode === undefined) {
    try {
      finalMode = statSync(absolute).mode & 0o7777;
    } catch {
      // new file — platform default (umask) applies
    }
  }
  const tmp = atomicTempPath(absolute);
  try {
    writeFileSync(tmp, content, "utf8");
    if (finalMode !== undefined) chmodSync(tmp, finalMode);
    renameSync(tmp, absolute);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * After a managed block is stripped: a file that held nothing but the harness
 * block is a husk once the block is gone — remove it (and prune now-empty
 * parents) rather than leaving a 1-byte shell; otherwise write the remaining
 * content back atomically.
 */
async function finalizeStrippedFile(repoRoot: string, absolute: string, content: string): Promise<void> {
  if (content.trim() === "") {
    await fs.rm(absolute);
    await pruneEmptyDirs(repoRoot, absolute);
  } else {
    await writeFileAtomic(absolute, content);
  }
}

/** `removed` = an orphan deleted or stripped — reported apart, never as a write. */
export type ApplyAction = "created" | "updated" | "removed" | "unchanged" | "conflict" | "error";

export interface ApplyItem {
  path: string;
  adapter: string;
  kind: GeneratedFile["kind"];
  action: ApplyAction;
  detail?: string;
}

export interface ApplyOutcome {
  items: ApplyItem[];
  /** Files that would change (or conflict) — nonzero means drift in --check. */
  driftCount: number;
  conflictCount: number;
}

export interface ApplyOptions {
  /** Compute actions without writing anything. */
  check?: boolean;
  /** Overwrite conflicting user edits. */
  force?: boolean;
  sourceHash: string;
  /**
   * Adapters whose orphans this run may clean up (default: all). A partial run
   * (`sync --platforms x`) only knows what x wants — every other adapter's
   * previous artifacts are carried over to the new lockfile untouched.
   */
  orphanScope?: ReadonlySet<string>;
}

export interface AdapterFileSet {
  adapter: string;
  fileSet: FileSet;
}

interface FileOutcome {
  item: ApplyItem;
  finalContent: string | undefined;
}

function applyManagedBlock(file: GeneratedFile, adapter: string, existing: string | undefined, force: boolean): FileOutcome {
  const update = upsertManagedBlock(existing, file.blockId ?? "core", adapter, file.content, { force });
  return {
    item: {
      path: file.path,
      adapter,
      kind: file.kind,
      action: update.action,
      ...(update.action === "conflict"
        ? { detail: "content inside the managed block was hand-edited — rerun with --force to overwrite" }
        : {}),
    },
    finalContent: update.action === "conflict" ? undefined : update.content,
  };
}

function applyJsonMerge(file: GeneratedFile, adapter: string, existing: string | undefined): FileOutcome {
  let merged: JsonMergeResult;
  if (file.mergeStrategy === "opencode-instructions") {
    merged = mergeOpencodeInstructions(existing, file.content);
  } else if (file.mergeStrategy === "cursor-hooks") {
    merged = mergeCursorHooks(existing, JSON.parse(file.content) as Record<string, string[]>);
  } else {
    // The origin defaulted to its claude-hooks strategy here; leina's
    // claude-code adapter no longer json-merges hooks, so an unmarked
    // json-merge artifact is an adapter bug, not user data to guess about.
    merged = { content: existing ?? "", changed: false, error: "json-merge artifact without a mergeStrategy" };
  }
  if (merged.error) {
    return {
      item: { path: file.path, adapter, kind: file.kind, action: "error", detail: merged.error },
      finalContent: undefined,
    };
  }
  return {
    item: {
      path: file.path,
      adapter,
      kind: file.kind,
      action: existing === undefined ? "created" : merged.changed ? "updated" : "unchanged",
    },
    finalContent: merged.content,
  };
}

function applyOwned(
  file: GeneratedFile,
  adapter: string,
  existing: string | undefined,
  prevEntry: LockfileArtifact | undefined,
  force: boolean,
): FileOutcome {
  const base = { path: file.path, adapter, kind: file.kind } as const;
  if (existing === undefined) {
    return { item: { ...base, action: "created" }, finalContent: file.content };
  }
  if (existing === file.content) {
    return { item: { ...base, action: "unchanged" }, finalContent: file.content };
  }
  if (sha256(existing) === prevEntry?.contentHash) {
    return { item: { ...base, action: "updated" }, finalContent: file.content };
  }
  if (force) {
    return { item: { ...base, action: "updated", detail: "forced over hand edits" }, finalContent: file.content };
  }
  return {
    item: {
      ...base,
      action: "conflict",
      detail: "file was edited outside harness — rerun with --force to overwrite",
    },
    finalContent: undefined,
  };
}

/** Best-effort: prune now-empty parents left by a removed artifact. */
async function pruneEmptyDirs(repoRoot: string, removedFile: string): Promise<void> {
  let dir = path.dirname(removedFile);
  while (dir !== repoRoot && dir.startsWith(repoRoot)) {
    try {
      await fs.rmdir(dir); // fails on non-empty — that's the stop condition
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Orphan cleanup: artifacts recorded in the previous lockfile that no adapter
 * generates anymore (rule or platform removed). Owned files are deleted when
 * untouched; managed blocks are stripped from their host file when their
 * interior is untouched (hand-edits conflict, like owned files); json-merge
 * entries are stripped from the shared JSON file (user entries stay), so no
 * harness wiring is left behind untracked. A json-merge artifact of an unknown
 * strategy (e.g. the origin's .claude/settings.json hooks) is left for the
 * owner to clean. Every removal is reported as `removed`, never as a write.
 */
async function cleanupOrphans(
  repoRoot: string,
  previous: Lockfile,
  desiredKeys: Set<string>,
  keyOf: (p: string, adapter: string, blockId: string | undefined) => string,
  options: ApplyOptions,
): Promise<{ items: ApplyItem[]; retained: LockfileArtifact[] }> {
  const items: ApplyItem[] = [];
  // Conflicted orphans stay in the lockfile — dropping them would strand the
  // artifact forever (a later --force run would no longer know about it).
  const retained: LockfileArtifact[] = [];
  for (const stale of previous.artifacts) {
    if (desiredKeys.has(keyOf(stale.path, stale.adapter, stale.blockId))) continue;
    if (options.orphanScope && !options.orphanScope.has(stale.adapter)) {
      retained.push(stale);
      continue;
    }
    const absolute = containedArtifactPath(repoRoot, stale.path);
    if (absolute === undefined) {
      // Never followed — and dropped from the lockfile: an entry that cannot
      // be touched safely cannot be managed either.
      items.push({ path: stale.path, adapter: stale.adapter, kind: stale.kind, action: "error", detail: OUTSIDE_REPO_DETAIL });
      continue;
    }
    const existing = await readTextIfExists(absolute);
    if (existing === undefined) continue;

    if (stale.kind === "owned") {
      if (sha256(existing) === stale.contentHash || options.force) {
        if (!options.check) {
          await fs.rm(absolute);
          await pruneEmptyDirs(repoRoot, absolute);
        }
        items.push({ path: stale.path, adapter: stale.adapter, kind: "owned", action: "removed", detail: "orphaned artifact" });
      } else {
        retained.push(stale);
        items.push({
          path: stale.path,
          adapter: stale.adapter,
          kind: "owned",
          action: "conflict",
          detail:
            "orphaned artifact was hand-edited — this stays a conflict on every run (including --check) " +
            "until you delete the file to keep nothing, or rerun with --force to discard your edits",
        });
      }
    } else if (stale.kind === "managed-block") {
      const blockId = stale.blockId ?? "core";
      // Same courtesy as owned artifacts: a block whose interior was
      // hand-edited is not silently discarded.
      if (blockHandEdited(existing, blockId) && !options.force) {
        retained.push(stale);
        items.push({
          path: stale.path,
          adapter: stale.adapter,
          kind: "managed-block",
          action: "conflict",
          detail:
            "orphaned block was hand-edited inside — this stays a conflict on every run (including --check) " +
            "until you delete the block markers to keep your text, or rerun with --force to discard it",
        });
        continue;
      }
      const { content, removed } = removeManagedBlock(existing, blockId);
      if (removed) {
        if (!options.check) await finalizeStrippedFile(repoRoot, absolute, content);
        items.push({ path: stale.path, adapter: stale.adapter, kind: "managed-block", action: "removed", detail: "orphaned block" });
      }
    } else {
      const item = await stripOrphanedJsonEntries(repoRoot, absolute, stale, existing, options);
      if (item?.action === "error") retained.push(stale); // once the file parses again, a later run strips it
      if (item) items.push(item);
    }
  }
  return { items, retained };
}

/** json-merge orphan: strip the harness entries; undefined = nothing to do. */
async function stripOrphanedJsonEntries(
  repoRoot: string,
  absolute: string,
  stale: LockfileArtifact,
  existing: string,
  options: ApplyOptions,
): Promise<ApplyItem | undefined> {
  const stripped = stripHarnessJsonEntries(stale.adapter, existing);
  if (stripped === undefined || (stripped.error === undefined && !stripped.changed)) return undefined;
  const base = { path: stale.path, adapter: stale.adapter, kind: "json-merge" } as const;
  if (stripped.error !== undefined) {
    return { ...base, action: "error", detail: `${stripped.error} — orphaned harness entries left in place` };
  }
  if (!options.check) {
    if (stripped.removeFile) {
      await fs.rm(absolute);
      await pruneEmptyDirs(repoRoot, absolute);
    } else {
      await writeFileAtomic(absolute, stripped.content);
    }
  }
  return {
    ...base,
    action: "removed",
    detail: stripped.removeFile ? "orphaned entries — the file held nothing else" : "orphaned harness entries",
  };
}

export async function applyFileSets(
  repoRoot: string,
  sets: AdapterFileSet[],
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  const previous = await readLockfile(repoRoot);
  const items: ApplyItem[] = [];
  const newArtifacts: Lockfile["artifacts"] = [];
  // Every desired artifact, including conflicted ones — a conflict is not an orphan.
  const desiredKeys = new Set<string>();
  const keyOf = (p: string, adapter: string, blockId: string | undefined) => `${adapter} ${p} ${blockId ?? ""}`;

  for (const { adapter, fileSet } of sets) {
    for (const file of fileSet.files) {
      desiredKeys.add(keyOf(file.path, adapter, file.blockId));
      const prevEntry = previous?.artifacts.find(
        (a) => a.path === file.path && a.adapter === adapter && a.blockId === file.blockId,
      );
      // Adapter paths embed rule/recipe names from the project layer, and the
      // repo may carry symlinks: every write is contained like every delete.
      const absolute = containedArtifactPath(repoRoot, file.path);
      if (absolute === undefined) {
        items.push({ path: file.path, adapter, kind: file.kind, action: "error", detail: OUTSIDE_REPO_DETAIL });
        if (prevEntry) newArtifacts.push(prevEntry);
        continue;
      }
      const existing = await readTextIfExists(absolute);

      const { item, finalContent } =
        file.kind === "managed-block"
          ? applyManagedBlock(file, adapter, existing, options.force ?? false)
          : file.kind === "json-merge"
            ? applyJsonMerge(file, adapter, existing)
            : applyOwned(file, adapter, existing, prevEntry, options.force ?? false);

      if (!options.check && finalContent !== undefined && item.action !== "unchanged") {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await writeFileAtomic(absolute, finalContent, file.mode);
      }

      if (finalContent !== undefined) {
        newArtifacts.push({
          path: file.path,
          adapter,
          kind: file.kind,
          ...(file.blockId !== undefined ? { blockId: file.blockId } : {}),
          contentHash: sha256(file.kind === "owned" ? file.content : finalContent),
        });
      } else if (prevEntry) {
        // Conflicted artifact: keep its last-written hash so a later sync can
        // still distinguish our old content from further hand edits.
        newArtifacts.push(prevEntry);
      }

      items.push(item);
    }
  }

  if (previous) {
    const cleanup = await cleanupOrphans(repoRoot, previous, desiredKeys, keyOf, options);
    items.push(...cleanup.items);
    newArtifacts.push(...cleanup.retained);
  }

  if (!options.check) {
    const lockAbsolute = containedArtifactPath(repoRoot, LOCKFILE_REL);
    if (lockAbsolute === undefined) {
      items.push({ path: LOCKFILE_REL, adapter: "harness", kind: "owned", action: "error", detail: OUTSIDE_REPO_DETAIL });
    } else {
      const lockfile: Lockfile = { version: 1, sourceHash: options.sourceHash, artifacts: newArtifacts };
      await fs.mkdir(harnessDir(repoRoot), { recursive: true });
      // Atomic too: a truncated lockfile would orphan every managed artifact.
      await writeFileAtomic(lockAbsolute, `${JSON.stringify(lockfile, null, 2)}\n`);
    }
  }

  const driftCount = items.filter((i) => i.action !== "unchanged").length;
  const conflictCount = items.filter((i) => i.action === "conflict" || i.action === "error").length;

  return { items, driftCount, conflictCount };
}
