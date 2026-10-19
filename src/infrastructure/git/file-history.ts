// infrastructure/git/file-history.ts — find a file's committed version by content hash.
//
// `leina memory reanchor` upgrades pre-3.0 file-level anchors (a sha256 of the whole file
// at save time) to symbol fingerprints. When the working tree no longer has that exact
// version, it is usually still in history: this walks the commits touching the file on any
// ref (newest first) and returns the content whose sha256 matches. Read-only git (log / show), hardened binary
// (safe-exec), fail-soft: any git error is "not found".

import { createHash } from "node:crypto";
import { safeGitRawOutput } from "../install/safe-exec.ts";

/** How many of a file's most recent commits are searched. */
export const FILE_HISTORY_DEPTH = 300;

const MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

interface PathHistory {
  commits: string[];
  next: number;
  bySha256: Map<string, string>;
}

/**
 * A `(relPath, sha256) → content | null` lookup over the history of the repo at `root`.
 * `relPath` is relative to `root`. Versions are read lazily (newest first) and cached for
 * the lookup's lifetime, so several anchors into one file cost one history walk.
 */
export function makeGitFileHistory(
  root: string,
  depth = FILE_HISTORY_DEPTH,
): (relPath: string, sha256: string) => string | null {
  const opts = { maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS };
  const byPath = new Map<string, PathHistory>();
  return (relPath, sha256) => {
    let h = byPath.get(relPath);
    if (h === undefined) {
      const log = safeGitRawOutput(["log", "--all", "--format=%H", `-n${depth}`, "--", relPath], root, opts);
      h = { commits: log === null ? [] : log.split("\n").filter((l) => l !== ""), next: 0, bySha256: new Map() };
      byPath.set(relPath, h);
    }
    const cached = h.bySha256.get(sha256);
    if (cached !== undefined) return cached;
    while (h.next < h.commits.length) {
      const commit = h.commits[h.next++]!;
      // `<rev>:./<path>` is relative to `root` (the cwd), whatever the repo toplevel is.
      const text = safeGitRawOutput(["show", `${commit}:./${relPath}`], root, opts);
      if (text === null) continue;
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      if (!h.bySha256.has(digest)) h.bySha256.set(digest, text);
      if (digest === sha256) return text;
    }
    return null;
  };
}
