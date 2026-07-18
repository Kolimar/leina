// infrastructure/harness/git.ts — GitPort implementation for the harness
// engine. Reuses the hardened safe-exec pattern (git pinned to an absolute
// path under fixed system directories, PATH restricted — CWE-426 mitigation)
// rather than spawning `git` off the inherited PATH.
//
// All methods are fail-soft: any git error maps to undefined/null/empty per
// the port contract — the gates decide how to degrade (skip vs error).

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeGitOutput } from "../install/safe-exec.ts";
import { type GitDiffOptions, type GitPort } from "../../domain/harness/ports.ts";

/** Generous limits for repo-sized operations (diffs can be big and slow). */
const GIT_OPTS = { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 } as const;

/** Untracked files above this size are left out of the synthetic diff. */
const UNTRACKED_MAX_BYTES = 4 * 1024 * 1024;

function run(repoRoot: string, args: string[]): string | null {
  return safeGitOutput(args, repoRoot, GIT_OPTS);
}

export class HarnessGit implements GitPort {
  async isRepo(repoRoot: string): Promise<boolean> {
    return run(repoRoot, ["rev-parse", "--git-dir"]) !== null;
  }

  async currentHead(repoRoot: string): Promise<string | undefined> {
    return run(repoRoot, ["rev-parse", "HEAD"]) ?? undefined;
  }

  async mergeBase(repoRoot: string, ref: string): Promise<string | undefined> {
    return run(repoRoot, ["merge-base", "HEAD", ref]) ?? undefined;
  }

  async changedFiles(repoRoot: string, base?: string): Promise<string[] | null> {
    if (!(await this.isRepo(repoRoot))) return null;

    const files = new Set<string>();
    const addAll = (out: string | null) => {
      for (const line of (out ?? "").split("\n")) {
        const f = line.trim();
        if (f.length > 0) files.add(f);
      }
    };

    const diff = run(repoRoot, ["diff", "--name-only", base ?? "HEAD"]);
    if (diff !== null) {
      addAll(diff);
    } else {
      // No commits yet (unresolvable HEAD/base): every tracked file is staged-new.
      addAll(run(repoRoot, ["diff", "--name-only", "--cached"]));
    }
    addAll(run(repoRoot, ["ls-files", "--others", "--exclude-standard"]));
    return [...files].sort();
  }

  async diffUnified(repoRoot: string, options: GitDiffOptions = {}): Promise<string | null> {
    const args = ["diff", "--unified=0"];
    if (options.cached) args.push("--cached");
    else args.push(options.base ?? "HEAD");
    if (options.paths && options.paths.length > 0) args.push("--", ...options.paths);
    const tracked = run(repoRoot, args);
    if (tracked === null) return null;
    // `git diff` never shows untracked content, so a brand-new file would sail
    // past content gates (no-secrets!) until staged. Append each untracked
    // text file as a synthetic new-file diff — same shape content gates parse.
    return tracked + untrackedAsAddedLines(repoRoot, options.paths);
  }
}

function untrackedAsAddedLines(repoRoot: string, paths?: string[]): string {
  const lsArgs = ["ls-files", "--others", "--exclude-standard"];
  if (paths && paths.length > 0) lsArgs.push("--", ...paths);
  const out = run(repoRoot, lsArgs);
  if (out === null) return "";

  const chunks: string[] = [];
  for (const raw of out.split("\n")) {
    const rel = raw.trim();
    if (rel.length === 0) continue;
    let content: string;
    try {
      const absolute = join(repoRoot, rel);
      if (statSync(absolute).size > UNTRACKED_MAX_BYTES) continue;
      content = readFileSync(absolute, "utf8");
    } catch {
      continue; // unreadable — leave it to the tracked diff once staged
    }
    if (content.includes("\0")) continue; // binary
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    chunks.push(
      `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n` +
        `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
    );
  }
  return chunks.length > 0 ? `\n${chunks.join("")}` : "";
}
