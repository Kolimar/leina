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
import { harnessDir } from "../config-io.ts";
import { readJsonIfExists, readTextIfExists } from "../io.ts";
import { blockHandEdited, removeManagedBlock, sha256, upsertManagedBlock } from "./managed-block.ts";
import { mergeCursorHooks, mergeOpencodeInstructions, type JsonMergeResult } from "./json-merge.ts";
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

export function lockfilePath(repoRoot: string): string {
  return path.join(harnessDir(repoRoot), "harness.lock.json");
}

const WRITE_KINDS: readonly string[] = ["owned", "managed-block", "json-merge"];

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
 * After a managed block is stripped: a file that held nothing but the harness
 * block is a husk once the block is gone — remove it (and prune now-empty
 * parents) rather than leaving a 1-byte shell; otherwise write the remaining
 * content back.
 */
async function finalizeStrippedFile(repoRoot: string, absolute: string, content: string): Promise<void> {
  if (content.trim() === "") {
    await fs.rm(absolute);
    await pruneEmptyDirs(repoRoot, absolute);
  } else {
    await fs.writeFile(absolute, content, "utf8");
  }
}

export type ApplyAction = "created" | "updated" | "unchanged" | "conflict" | "error";

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

/**
 * Orphan cleanup: artifacts recorded in the previous lockfile that no adapter
 * generates anymore (rule or platform removed). Owned files are deleted when
 * untouched; managed blocks are stripped from their host file when their
 * interior is untouched (hand-edits conflict, like owned files). json-merge
 * cleanup is inherent: the next merge strips stale entries. (A json-merge
 * artifact whose platform disappeared entirely — e.g. the origin's
 * .claude/settings.json hooks — is left for the owner to clean; stale
 * `harness hook` wiring is inert once the hook CLI answers it.)
 */
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
    const absolute = path.join(repoRoot, stale.path);
    const existing = await readTextIfExists(absolute);
    if (existing === undefined) continue;

    if (stale.kind === "owned") {
      if (sha256(existing) === stale.contentHash || options.force) {
        if (!options.check) {
          await fs.rm(absolute);
          await pruneEmptyDirs(repoRoot, absolute);
        }
        items.push({
          path: stale.path,
          adapter: stale.adapter,
          kind: "owned",
          action: "updated",
          detail: "removed (orphaned artifact)",
        });
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
        items.push({
          path: stale.path,
          adapter: stale.adapter,
          kind: "managed-block",
          action: "updated",
          detail: "removed orphaned block",
        });
      }
    }
  }
  return { items, retained };
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
      const absolute = path.join(repoRoot, file.path);
      const existing = await readTextIfExists(absolute);
      const prevEntry = previous?.artifacts.find(
        (a) => a.path === file.path && a.adapter === adapter && a.blockId === file.blockId,
      );

      const { item, finalContent } =
        file.kind === "managed-block"
          ? applyManagedBlock(file, adapter, existing, options.force ?? false)
          : file.kind === "json-merge"
            ? applyJsonMerge(file, adapter, existing)
            : applyOwned(file, adapter, existing, prevEntry, options.force ?? false);

      if (!options.check && finalContent !== undefined && item.action !== "unchanged") {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, finalContent, "utf8");
        if (file.mode !== undefined) await fs.chmod(absolute, file.mode);
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

  const driftCount = items.filter((i) => i.action !== "unchanged").length;
  const conflictCount = items.filter((i) => i.action === "conflict" || i.action === "error").length;

  if (!options.check) {
    const lockfile: Lockfile = { version: 1, sourceHash: options.sourceHash, artifacts: newArtifacts };
    await fs.mkdir(harnessDir(repoRoot), { recursive: true });
    await fs.writeFile(lockfilePath(repoRoot), `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
  }

  return { items, driftCount, conflictCount };
}
