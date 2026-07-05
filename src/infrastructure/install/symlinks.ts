// symlinks.ts — Idempotent linkOrCopy for the global share install.
//
// Mac/Linux: symlinks. The share lives at $LEINA_HOME/share/<kind>/<name>/ and each host's
// global dir gets one symlink per skill/agent pointing back to the share. A single source of
// truth means `leina install-global` (and an eventual self-update) propagates to every
// registered host without touching per-project files.
//
// Windows: `fs.symlinkSync` may fail with EPERM unless Developer Mode is on. We catch that and
// fall back to a recursive copy with a warning on stderr — the user gets the files either way,
// just without the auto-propagation guarantee.
//
// Refuse-to-clobber: if the destination already exists and points elsewhere (wrong target, real
// directory, or unrelated file), we do NOT delete it. We back it up as `<dest>.bak-<ISO>` and
// then install fresh. Idempotent re-run: matching symlinks are left alone.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface LinkResult {
  /** Absolute destination path that was installed (or removed). */
  path: string;
  /** What actually happened on disk this invocation. */
  action: "symlinked" | "copied" | "unchanged" | "backed-up-and-replaced" | "unlinked" | "skipped-unmanaged";
  /** Backup path, if we displaced something. */
  backup?: string;
}

/**
 * Ensure `dest` is a symlink (or copy fallback) of `src`. Both paths must be absolute.
 *
 * - `unchanged` — dest already points where we want; no-op.
 * - `symlinked` — dest didn't exist; created the symlink.
 * - `copied` — symlink failed (Windows EPERM); recursively copied src→dest instead.
 * - `backed-up-and-replaced` — dest existed and pointed elsewhere; moved aside and replaced.
 *
 * Never deletes data it didn't create. Backup uses an ISO timestamp so concurrent runs don't collide.
 */
export function linkOrCopy(src: string, dest: string): LinkResult {
  const absSrc = resolve(src);
  const absDest = resolve(dest);

  if (!existsSync(absSrc)) {
    throw new Error(`linkOrCopy: source does not exist: ${absSrc}`);
  }

  mkdirSync(dirname(absDest), { recursive: true });

  let displaced: string | undefined;

  if (existsSync(absDest) || isBrokenSymlink(absDest)) {
    const lst = lstatSync(absDest);
    if (lst.isSymbolicLink()) {
      const target = resolve(dirname(absDest), readlinkSync(absDest));
      if (target === absSrc) {
        return { path: absDest, action: "unchanged" };
      }
    }
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    displaced = `${absDest}.bak-${stamp}`;
    renameSync(absDest, displaced);
  }

  try {
    // `dir` hint is harmless on POSIX and required on Windows for directory symlinks.
    symlinkSync(absSrc, absDest, statSync(absSrc).isDirectory() ? "dir" : "file");
    return {
      path: absDest,
      action: displaced ? "backed-up-and-replaced" : "symlinked",
      backup: displaced,
    };
  } catch (err) {
    // EPERM / ENOTSUP / EACCES → copy fallback (Windows without Developer Mode is the
    // primary culprit). Anything else is a real failure — re-throw.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EACCES") {
      throw err;
    }
    process.stderr.write(
      `Notice: symlink failed (${code}) at ${absDest}; falling back to copy. ` +
        "Enable Developer Mode on Windows to use symlinks instead.\n",
    );
    copyTree(absSrc, absDest);
    return {
      path: absDest,
      action: "copied",
      backup: displaced,
    };
  }
}

/** Recursive copy. Used as the Windows fallback for linkOrCopy. */
export function copyTree(src: string, dest: string): void {
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyTree(join(src, entry), join(dest, entry));
    }
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

/** Best-effort detection of a dangling symlink (target doesn't exist). */
function isBrokenSymlink(p: string): boolean {
  try {
    const lst = lstatSync(p);
    if (!lst.isSymbolicLink()) return false;
    return !existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Remove a previously-installed symlink (only if it IS a symlink and points into our share).
 * Safety: never deletes a real file or a symlink pointing outside `expectedSrcPrefix`.
 */
export function unlinkIfManaged(dest: string, expectedSrcPrefix: string): boolean {
  if (!existsSync(dest) && !isBrokenSymlink(dest)) return false;
  const lst = lstatSync(dest);
  if (!lst.isSymbolicLink()) return false;
  const target = resolve(dirname(dest), readlinkSync(dest));
  const rel = relative(resolve(expectedSrcPrefix), target);
  if (rel.startsWith("..") || rel === target) return false; // not inside the share
  unlinkSync(dest);
  return true;
}
