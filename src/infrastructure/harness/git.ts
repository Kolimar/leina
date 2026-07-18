// infrastructure/harness/git.ts — GitPort implementation for the harness
// engine. Reuses the hardened safe-exec pattern (git pinned to an absolute
// path under fixed system directories, PATH restricted — CWE-426 mitigation)
// rather than spawning `git` off the inherited PATH.
//
// All methods are fail-soft: any git error maps to undefined/null/empty per
// the port contract — the gates decide how to degrade (skip vs error).

import { safeGitOutput } from "../install/safe-exec.ts";
import { type GitDiffOptions, type GitPort } from "../../domain/harness/ports.ts";

/** Generous limits for repo-sized operations (diffs can be big and slow). */
const GIT_OPTS = { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 } as const;

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
    return run(repoRoot, args);
  }
}
