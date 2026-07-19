// domain/harness/ports.ts — hexagonal ports for the harness engine's process
// and git access. The application layer (gates, verify) depends ONLY on these
// interfaces; infrastructure/harness/{exec,git}.ts implement them.
//
// Dependency rule: this file MUST import only from other domain/ modules.
// No application/, infrastructure/, or cli/ imports allowed.

// ---------------------------------------------------------------------------
// Process runner port — used by the `command` gate.
// ---------------------------------------------------------------------------

export interface ShellRunOptions {
  /** Working directory for the command (the repo root for gates). */
  cwd: string;
  /** Hard wall-clock limit; the process is killed when exceeded. */
  timeoutMs: number;
  /** Extra environment variables merged over the inherited environment. */
  env?: Record<string, string>;
}

export interface ShellRunResult {
  /** Process exit code; -1 when the process could not be spawned or was killed. */
  exitCode: number;
  stdout: string;
  /** Interleaved stdout+stderr, in arrival order — what a terminal would show. */
  all: string;
  /** True when the process was killed by the timeout. */
  timedOut: boolean;
}

export interface ProcessRunnerPort {
  /**
   * Run a shell command line in `cwd`. Implementations dispatch through the
   * platform shell (`sh -c` on POSIX) because gate commands are authored as
   * shell one-liners (`npm test && npm run lint`). NEVER throws — failures
   * surface as `exitCode: -1` with the error message in `all`.
   */
  runShell(command: string, options: ShellRunOptions): Promise<ShellRunResult>;
}

// ---------------------------------------------------------------------------
// Git port — used by the diff/diff-content gates and verify's changed-files
// resolution.
// ---------------------------------------------------------------------------

export interface GitDiffOptions {
  /** Base ref to diff against; ignored when `cached` is true. Defaults to HEAD. */
  base?: string;
  /** Diff the index against HEAD (fallback for repos with no resolvable base). */
  cached?: boolean;
  /** Git pathspecs appended after `--`. */
  paths?: string[];
}

export interface GitPort {
  isRepo(repoRoot: string): Promise<boolean>;
  /** SHA of HEAD, or undefined when unresolvable (no commits / not a repo). */
  currentHead(repoRoot: string): Promise<string | undefined>;
  /** merge-base of HEAD and `ref`, or undefined when unresolvable. */
  mergeBase(repoRoot: string, ref: string): Promise<string | undefined>;
  /**
   * Changed files relative to `base` (committed + staged + worktree),
   * repo-relative posix paths, sorted. Untracked files are included — a model
   * creating files out of scope must not escape the diff gate by never staging
   * them. When `base` is unresolvable (fresh repo) falls back to the index
   * diff. Returns null only when `repoRoot` is not a git repository.
   */
  changedFiles(repoRoot: string, base?: string): Promise<string[] | null>;
  /**
   * Raw `git diff --unified=0` output for content-level gates. Working-tree
   * diffs (cached: false) also append untracked text files as synthetic
   * new-file diffs, within per-file and aggregate size budgets (content gates
   * must see a secret before it is ever staged); `cached: true` is strictly
   * the index. Returns null when the diff cannot be produced (not a repo).
   */
  diffUnified(repoRoot: string, options?: GitDiffOptions): Promise<string | null>;
}

/** The full set of driven ports the harness engine needs — wired by the caller. */
export interface HarnessPorts {
  proc: ProcessRunnerPort;
  git: GitPort;
}
