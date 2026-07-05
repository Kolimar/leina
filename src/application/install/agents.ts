// AGENTS.md merge — the universal soft-enforcement surface. Validated 2026-06-01: AGENTS.md is
// read by Devin (cloud + CLI, which also reads CLAUDE.md) and Claude Code, so one
// committed file carries the protocol to every host. We own ONLY the marked section; anything the
// user wrote outside the markers is preserved, and re-running replaces our block in place.

import { PROTOCOL_START, PROTOCOL_END, PROTOCOL_BODY } from "./protocol.ts";
export { PROTOCOL_START, PROTOCOL_END } from "./protocol.ts";

export function mergeAgentsMd(existing: string | null): string {
  const section = `${PROTOCOL_START}\n${PROTOCOL_BODY}\n${PROTOCOL_END}`;

  if (existing === null || existing.trim() === "") {
    return `# AGENTS.md\n\n${section}\n`;
  }

  // Markers only count when they OWN a whole line — so prose that merely mentions the marker
  // strings is never mistaken for our managed section.
  const lines = existing.split("\n");
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === PROTOCOL_START) starts.push(i);
    if (t === PROTOCOL_END) ends.push(i);
  }

  // No managed section yet — append, keeping all existing content intact.
  if (starts.length === 0 && ends.length === 0) {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${sep}${section}\n`;
  }

  // Exactly one well-formed pair — replace it in place. Anything else (orphaned, reversed or
  // duplicated markers) is refused rather than guessed: this tool must never clobber blindly.
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) {
    throw new Error(
      `malformed leina managed section — expected exactly one "${PROTOCOL_START}" … ` +
        `"${PROTOCOL_END}" block, each on its own line. Fix or remove it, then re-run init.`,
    );
  }

  const before = lines.slice(0, starts[0]);
  const after = lines.slice(ends[0]! + 1);
  return [...before, section, ...after].join("\n");
}

/**
 * Remove the leina managed protocol block from an AGENTS.md (or similar) file.
 * Inverse of `mergeAgentsMd`. Pure (string|null → string|null), idempotent, no-clobber.
 *
 *  - null / blank input           → null (no file to modify)
 *  - block absent                 → null (idempotent no-op)
 *  - exactly one well-formed pair → content with the block (and its surrounding blank lines)
 *                                   stripped; if the file becomes empty or whitespace-only,
 *                                   returns null
 *  - malformed markers            → null (no-clobber; never throws)
 */
export function removeAgentsMdBlock(existing: string | null): string | null {
  if (!existing?.trim()) return null;

  const lines = existing.split("\n");
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === PROTOCOL_START) starts.push(i);
    if (t === PROTOCOL_END) ends.push(i);
  }

  // Block absent → idempotent no-op
  if (starts.length === 0 && ends.length === 0) return null;

  // Malformed (orphaned, reversed, or duplicated markers) → no-clobber
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) return null;

  const startIdx = starts[0]!;
  const endIdx = ends[0]!;

  // Trim one blank line immediately BEFORE the block (separator that mergeAgentsMd added).
  const trimBefore = startIdx > 0 && lines[startIdx - 1]!.trim() === "" ? startIdx - 1 : startIdx;
  const before = lines.slice(0, trimBefore);
  const after = lines.slice(endIdx + 1);

  const result = [...before, ...after].join("\n");
  return result.trim() === "" ? null : result;
}
