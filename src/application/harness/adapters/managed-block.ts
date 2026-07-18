// application/harness/adapters/managed-block.ts — HTML-comment managed blocks
// for files harness co-owns with the user (AGENTS.md, CLAUDE.md).
//
// COMPATIBILITY CONTRACT: the marker format is byte-identical to the origin
// harness-framework (`<!-- harness:begin id=… adapter=… v=1 hash=sha256:… -->`)
// so repos already synced by the original `npx harness sync` keep updating in
// place under leina. Do not rebrand these markers.

import crypto from "node:crypto";

/**
 * Managed blocks let harness co-own files the user also edits (AGENTS.md,
 * CLAUDE.md). Everything outside the markers is never touched. The hash
 * attribute records the inner content harness last wrote, so a hand-edit
 * inside the block is detected (hash mismatch) and never clobbered without
 * --force. Idempotent: re-syncing unchanged rules is a byte-identical no-op.
 */

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function beginMarker(blockId: string, adapter: string, hash: string): string {
  return `<!-- harness:begin id=${blockId} adapter=${adapter} v=1 hash=sha256:${hash} -->`;
}

function endMarker(blockId: string): string {
  return `<!-- harness:end id=${blockId} -->`;
}

const BEGIN_RE = (blockId: string) =>
  // eslint-disable-next-line security/detect-non-literal-regexp -- blockId comes from our own adapters/lockfile and is regex-escaped
  new RegExp(`<!-- harness:begin id=${escapeRe(blockId)}[^>]*hash=sha256:([0-9a-f]{64})[^>]*-->`);

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type BlockAction = "created" | "updated" | "unchanged" | "conflict";

export interface BlockUpdate {
  content: string;
  action: BlockAction;
  /** Present on conflict: what harness wanted to write. */
  desired?: string;
}

export function renderBlock(blockId: string, adapter: string, body: string): string {
  const inner = body.trim();
  return `${beginMarker(blockId, adapter, sha256(inner))}\n${inner}\n${endMarker(blockId)}`;
}

/**
 * Insert or update a managed block inside `existing` (undefined = new file).
 * Conflict = the current inner content no longer matches the recorded hash
 * (someone edited inside the block); the file is left untouched.
 */
export function upsertManagedBlock(
  existing: string | undefined,
  blockId: string,
  adapter: string,
  body: string,
  { force = false }: { force?: boolean } = {},
): BlockUpdate {
  const block = renderBlock(blockId, adapter, body);

  if (existing === undefined || existing.trim() === "") {
    return { content: `${block}\n`, action: "created" };
  }

  const begin = existing.match(BEGIN_RE(blockId));
  const end = existing.indexOf(endMarker(blockId));

  if (begin?.index === undefined || end === -1 || end < begin.index) {
    // No (complete) block yet — append at the bottom, preserving user content.
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    return { content: `${existing}${sep}${block}\n`, action: "created" };
  }

  const innerStart = begin.index + begin[0].length;
  const currentInner = existing.slice(innerStart, end).replace(/^\n/, "").replace(/\n$/, "");
  const recordedHash = begin[1];

  if (!force && sha256(currentInner) !== recordedHash) {
    return { content: existing, action: "conflict", desired: block };
  }

  const updated =
    existing.slice(0, begin.index) + block + existing.slice(end + endMarker(blockId).length);
  return { content: updated, action: updated === existing ? "unchanged" : "updated" };
}

/** Remove a managed block entirely (rule/adapter removed). */
export function removeManagedBlock(
  existing: string,
  blockId: string,
): { content: string; removed: boolean } {
  const begin = existing.match(BEGIN_RE(blockId));
  const endM = endMarker(blockId);
  const end = existing.indexOf(endM);
  if (begin?.index === undefined || end === -1) return { content: existing, removed: false };
  const before = existing.slice(0, begin.index).replace(/\n+$/, "\n");
  const after = existing.slice(end + endM.length).replace(/^\n+/, "\n");
  return { content: `${`${before}${after}`.trim()}\n`, removed: true };
}
