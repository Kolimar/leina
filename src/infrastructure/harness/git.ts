// infrastructure/harness/git.ts — GitPort implementation for the harness
// engine. Reuses the hardened safe-exec pattern (git pinned to an absolute
// path under fixed system directories, PATH restricted — CWE-426 mitigation)
// rather than spawning `git` off the inherited PATH.
//
// All methods are fail-soft: any git error maps to undefined/null/empty per
// the port contract — the gates decide how to degrade (skip vs error).

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeGitOutput } from "../install/safe-exec.ts";
import { type GitDiffOptions, type GitPort } from "../../domain/harness/ports.ts";

/** Generous limits for repo-sized operations (diffs can be big and slow). */
const GIT_OPTS = { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 } as const;

/** Untracked files above this size are left out of the synthetic diff. */
const UNTRACKED_MAX_BYTES = 4 * 1024 * 1024;
/** Aggregate budget for the whole untracked scan — mirrors GIT_OPTS.maxBuffer. */
const UNTRACKED_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const UNTRACKED_MAX_FILES = 2000;

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

    // `--relative`: paths relative to `repoRoot` and limited to its subtree,
    // like `ls-files` below. Without it a harness rooted in a monorepo package
    // (packages/app/.harness) got toplevel-relative diff paths
    // (packages/app/src/a.ts) next to package-relative untracked ones, and the
    // contract scope (src/**) — relative to the harness root — never matched.
    const diff = run(repoRoot, ["diff", "--name-only", "--relative", base ?? "HEAD"]);
    if (diff !== null) {
      addAll(diff);
    } else {
      // No commits yet (unresolvable HEAD/base): every tracked file is staged-new.
      addAll(run(repoRoot, ["diff", "--name-only", "--relative", "--cached"]));
    }
    addAll(run(repoRoot, ["ls-files", "--others", "--exclude-standard"]));
    return [...files].sort();
  }

  async diffUnified(repoRoot: string, options: GitDiffOptions = {}): Promise<string | null> {
    // `--relative`: file headers relative to `repoRoot` (see changedFiles).
    const args = ["diff", "--unified=0", "--relative"];
    if (options.cached) args.push("--cached");
    else args.push(options.base ?? "HEAD");
    if (options.paths && options.paths.length > 0) args.push("--", ...options.paths);
    const tracked = run(repoRoot, args);
    if (tracked === null) return null;
    if (options.cached) return tracked; // --cached means "the index" — untracked is not part of it
    // `git diff` never shows untracked content, so a brand-new file would slip
    // past content gates (no-secrets!) until staged. Append each untracked
    // text file as a synthetic new-file diff — same shape content gates parse.
    return tracked + (await untrackedAsAddedLines(repoRoot, options.paths));
  }
}

/**
 * Async on purpose (this runs inside the engine's parallel gate pool) and
 * budgeted: per-file and aggregate byte/file caps keep a pathological repo
 * (huge un-ignored build output) from freezing verify or ballooning memory.
 * Skips are never fully silent — a truncation notice rides along as a `\`
 * marker line, which diff parsers ignore but a human reading the raw diff
 * (or the gate's output) can see.
 */
async function untrackedAsAddedLines(repoRoot: string, paths?: string[]): Promise<string> {
  const lsArgs = ["ls-files", "--others", "--exclude-standard"];
  if (paths && paths.length > 0) lsArgs.push("--", ...paths);
  const out = run(repoRoot, lsArgs);
  if (out === null) return "";

  const chunks: string[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  let files = 0;
  for (const raw of out.split("\n")) {
    const rel = raw.trim();
    if (rel.length === 0) continue;
    if (files >= UNTRACKED_MAX_FILES || totalBytes >= UNTRACKED_MAX_TOTAL_BYTES) {
      skipped.push(`${rel} (scan budget exhausted)`);
      continue;
    }
    let content: string;
    try {
      const absolute = join(repoRoot, rel);
      // lstat, NOT stat: an untracked symlink pointing outside the repo
      // (~/.ssh/id_rsa, ~/.leina/.env) must never have its TARGET read into
      // the synthetic diff — that would dump the secret into
      // verify-report.json and the model context. A tracked symlink is safe
      // (git diff shows the target path, not the content); the untracked scan
      // is the only place we read file bodies ourselves, so skip links here.
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (!info.isFile()) continue; // FIFO/socket/device — readFile could block forever
      if (info.size > UNTRACKED_MAX_BYTES) {
        skipped.push(`${rel} (larger than ${UNTRACKED_MAX_BYTES} bytes)`);
        continue;
      }
      content = await readFile(absolute, "utf8");
    } catch {
      continue; // unreadable — leave it to the tracked diff once staged
    }
    if (content.includes("\0")) continue; // binary
    files += 1;
    totalBytes += content.length;
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    chunks.push(
      `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n` +
        `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
    );
  }
  if (skipped.length > 0) {
    chunks.push(
      `\\ harness: ${skipped.length} untracked file(s) NOT scanned by content gates — stage them (git add) for a full check: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}\n`,
    );
  }
  return chunks.length > 0 ? `\n${chunks.join("")}` : "";
}
