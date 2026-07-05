// safe-exec.ts — Hardened child-process helpers that restrict PATH to fixed,
// unwritable system directories. Prevents CWE-426 (untrusted search path) by
// ensuring spawned binaries (e.g. `git`) are resolved only from well-known
// locations, regardless of what the inherited PATH contains.
//
// Pure utility — no project-specific imports.

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Hardcoded list of directories considered safe for binary lookup.
 * These are standard system paths that are typically not user-writable.
 * On Windows the system root is derived from the SYSTEMROOT env var.
 */
const SAFE_PATH_DIRS: readonly string[] = (() => {
  if (process.platform === "win32") {
    const sysRoot = process.env.SYSTEMROOT ?? "C:\\Windows";
    return [
      `${sysRoot}\\System32`,
      `${sysRoot}`,
      `${sysRoot}\\System32\\Wbem`,
      // Git for Windows default location
      "C:\\Program Files\\Git\\cmd",
      "C:\\Program Files\\Git\\bin",
    ];
  }
  // POSIX (macOS / Linux)
  return ["/usr/bin", "/bin", "/usr/local/bin", "/usr/sbin", "/sbin"];
})();

/** Joined PATH string using the platform separator. */
export const SAFE_PATH: string = SAFE_PATH_DIRS.join(
  process.platform === "win32" ? ";" : ":",
);

// Resolve `git` to an ABSOLUTE path inside the fixed, unwritable SAFE_PATH_DIRS,
// rather than letting the OS search $PATH for it. This is the stronger form of
// the CWE-426 mitigation: the executable is pinned to a known-good location, so
// a poisoned/inherited PATH can never select a malicious `git`. Resolved once
// and cached. Falls back to the bare name only if no candidate exists (e.g. a
// non-standard layout) — execFileSync then errors out and safeGitOutput → null.
const GIT_BINARY: string = (() => {
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  for (const dir of SAFE_PATH_DIRS) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "git";
})();

/**
 * Run `git` from a fixed, unwritable location with a hardened PATH. The binary
 * is resolved to an absolute path under SAFE_PATH_DIRS (never via $PATH search),
 * and the child still gets `PATH=SAFE_PATH` for any sub-process it spawns.
 * Returns the trimmed stdout on success, or `null` on any error.
 *
 * @param args   git subcommand + flags (e.g. `["rev-parse", "HEAD"]`)
 * @param cwd    working directory for the git invocation
 * @param opts   optional overrides merged into ExecFileSyncOptions
 */
export function safeGitOutput(
  args: string[],
  cwd: string,
  opts?: Partial<ExecFileSyncOptions>,
): string | null {
  try {
    const out = execFileSync(GIT_BINARY, args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      ...opts,
      encoding: "utf8",
      env: { ...opts?.env, PATH: SAFE_PATH },
    });
    return out.trim();
  } catch {
    return null;
  }
}
