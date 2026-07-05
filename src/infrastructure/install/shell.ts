// shell.ts — host-shell interop detection.
//
// Windows + Git Bash / MSYS2 is the one environment where the npm-generated POSIX shim for our
// `bin` (`leina`, no extension) mis-resolves its own `$0`/basedir to a drive-less
// `/Users/...` path. MSYS then expands that by prepending the Git install root, producing
// invocations like:
//   node "C:\Program Files\Git\Users\<user>\AppData\Roaming\npm\node_modules\...\dist\cli\index.js"
// which fails with MODULE_NOT_FOUND even though the package is installed correctly. The fix is
// environmental (use cmd.exe / PowerShell, or a node wrapper) — the package cannot change how npm
// emits the shim — so we DETECT the condition and surface the exact remedy from `doctor` and the
// lifecycle commands (setup/activate/init). There is deliberately NO npm postinstall hook: pnpm
// and bun skip dependency lifecycle scripts by default and --ignore-scripts is common, so a
// runtime advisory is the only delivery that works under every package manager.
//
// Detection is intentionally conservative: a false positive here only prints an advisory, never
// blocks anything.

export interface GitBashDetection {
  /** True when running on win32 under an MSYS/MinGW (Git Bash) shell. */
  isGitBashOnWindows: boolean;
  /** The MSYSTEM value that triggered detection (MINGW64/MINGW32/MSYS), if any. */
  msystem?: string;
}

/**
 * Detect whether the current process is running under Git Bash / MSYS2 on Windows.
 *
 * Signals (any is sufficient):
 *  - `MSYSTEM` env var (set by Git Bash to MINGW64 / MINGW32 / MSYS) — the strongest signal.
 *  - a POSIX-style `SHELL` ending in `bash` while `platform === "win32"`.
 *
 * Parameterized on `env`/`platform` so it is trivially unit-testable without mutating globals.
 */
export function detectGitBashOnWindows(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): GitBashDetection {
  if (platform !== "win32") return { isGitBashOnWindows: false };

  const msystem = typeof env.MSYSTEM === "string" ? env.MSYSTEM.trim() : "";
  if (msystem.length > 0) return { isGitBashOnWindows: true, msystem };

  const shell = typeof env.SHELL === "string" ? env.SHELL : "";
  if (/(^|[\\/])bash(\.exe)?$/i.test(shell)) return { isGitBashOnWindows: true };

  return { isGitBashOnWindows: false };
}

/**
 * One-line, copy-pasteable remediation for the Git Bash shim breakage. Kept here (not inlined in
 * the doctor formatter) so the lifecycle-command advisory and `doctor` emit identical guidance.
 *
 * `cliEntry` is the absolute path to the installed `dist/cli/index.js` when known; the caller
 * passes it so the printed `node "<path>"` command is exact.
 */
export function gitBashAdvisory(
  cliEntry = "<npm-prefix>/node_modules/leina/dist/cli/index.js",
): string {
  return [
    "Git Bash / MSYS detected on Windows: the npm POSIX shim can mis-resolve the CLI path",
    String.raw`(e.g. "C:\Program Files\Git\Users\...") and fail with MODULE_NOT_FOUND.`,
    "Use ONE of these instead:",
    "  • Run leina from cmd.exe or PowerShell (the .cmd/.ps1 shim resolves correctly), or",
    `  • Call node directly:  node "${cliEntry}" --help , or`,
    "  • Add a Git Bash wrapper to ~/.bashrc:",
    '      leina() { node "$APPDATA/npm/node_modules/leina/dist/cli/index.js" "$@"; }',
  ].join("\n");
}

/**
 * The Git Bash advisory as a pure decision: the full text when the condition holds, null
 * otherwise. Lifecycle handlers (setup/activate/init) call this with the live env/platform
 * and write the result to stderr — the pure form keeps the win32 branch unit-testable from
 * any host.
 */
export function shellInteropAdvisory(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cliEntry?: string,
): string | null {
  const detection = detectGitBashOnWindows(env, platform);
  return detection.isGitBashOnWindows ? gitBashAdvisory(cliEntry) : null;
}

// ---------------------------------------------------------------------------
// Git Bash wrapper writer (the FIX for the shim breakage, not just the advisory)
// ---------------------------------------------------------------------------

export const SHELL_WRAPPER_START = "# leina:shell-wrapper:start";
export const SHELL_WRAPPER_END = "# leina:shell-wrapper:end";

/**
 * Merge the Git Bash `leina()` wrapper function into a ~/.bashrc, owning only the marked
 * block (same convention as every other managed block). Pure + idempotent: returns null
 * when the content already contains an identical block, the merged content otherwise.
 * The wrapper calls node with the ABSOLUTE cli entry, sidestepping npm's POSIX shim
 * that MSYS mis-resolves.
 */
export function mergeShellWrapper(existing: string | null, cliEntry: string): string | null {
  const block = [
    SHELL_WRAPPER_START,
    "# Work around the npm POSIX shim mis-resolving under MSYS/Git Bash (MODULE_NOT_FOUND).",
    `leina() { node "${cliEntry}" "$@"; }`,
    SHELL_WRAPPER_END,
  ].join("\n");

  if (existing === null || existing.trim() === "") return `${block}\n`;

  const lines = existing.split("\n");
  const start = lines.findIndex((l) => l.trim() === SHELL_WRAPPER_START);
  const end = lines.findIndex((l) => l.trim() === SHELL_WRAPPER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const replaced = [...lines.slice(0, start), block, ...lines.slice(end + 1)].join("\n");
    return replaced === existing ? null : replaced;
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${block}\n`;
}
