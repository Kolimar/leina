// .gitignore merge — keeps leina runtime data out of version control. `init` writes the
// per-project `.leina/` dir (graph.db, WAL/SHM sidecars) into ANY project that uses
// leina; those are runtime data, not source, and must never be committed. We own ONLY the
// marked section; anything the user wrote outside the markers is preserved, and re-running
// replaces our block in place.
//
// Note: memory.db is now global (~/.leina/memory.db) — it is NOT inside the repo dir.
// config.json is committable (it locks the project name) and is re-included via the negation.

// gitignore comments start with `#`, so the markers double as inert comment lines.
export const GITIGNORE_START = "# leina:ignore:start";
export const GITIGNORE_END = "# leina:ignore:end";

// Two-line body: ignore all contents of .leina/ (so git descends the dir and evaluates
// the negation below), but re-include config.json so the project-name lock can be committed.
// Using `.leina/*` instead of `.leina/` is required: a directory-level ignore
// prevents git from descending, making any nested negation dead.
export const GITIGNORE_BODY = ".leina/*\n!.leina/config.json\n!.leina/memory-export.jsonl";

export function mergeGitignore(existing: string | null): string {
  const section = `${GITIGNORE_START}\n${GITIGNORE_BODY}\n${GITIGNORE_END}`;

  if (existing === null || existing.trim() === "") {
    return `${section}\n`;
  }

  // Markers only count when they OWN a whole line — so a path or comment that merely contains the
  // marker text is never mistaken for our managed section.
  const lines = existing.split("\n");
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === GITIGNORE_START) starts.push(i);
    if (t === GITIGNORE_END) ends.push(i);
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
      `malformed leina managed section — expected exactly one "${GITIGNORE_START}" … ` +
        `"${GITIGNORE_END}" block, each on its own line. Fix or remove it, then re-run init.`,
    );
  }

  const before = lines.slice(0, starts[0]);
  const after = lines.slice(ends[0]! + 1);
  return [...before, section, ...after].join("\n");
}

/**
 * Remove the leina managed gitignore block from a `.gitignore` file.
 * Inverse of `mergeGitignore`. Pure (string|null → string|null), idempotent, no-clobber.
 *
 *  - null / blank input           → null (no file to modify)
 *  - block absent                 → null (idempotent no-op)
 *  - exactly one well-formed pair → content with the block stripped; trailing blank lines
 *                                   added by mergeGitignore are also removed; if the result
 *                                   is whitespace-only, returns null
 *  - malformed markers            → null (no-clobber; never throws)
 */
export function removeGitignoreBlock(existing: string | null): string | null {
  if (!existing?.trim()) return null;

  const lines = existing.split("\n");
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === GITIGNORE_START) starts.push(i);
    if (t === GITIGNORE_END) ends.push(i);
  }

  // Block absent → idempotent no-op
  if (starts.length === 0 && ends.length === 0) return null;

  // Malformed (orphaned, reversed, or duplicated markers) → no-clobber
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) return null;

  const startIdx = starts[0]!;
  const endIdx = ends[0]!;

  // Trim one blank line immediately BEFORE the block (separator that mergeGitignore added).
  const trimBefore = startIdx > 0 && lines[startIdx - 1]!.trim() === "" ? startIdx - 1 : startIdx;
  const before = lines.slice(0, trimBefore);
  const after = lines.slice(endIdx + 1);

  const result = [...before, ...after].join("\n");
  return result.trim() === "" ? null : result;
}
