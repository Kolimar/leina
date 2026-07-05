// symlinks.ts — Idempotent linkOrCopy for the global share install.
//
// Mac/Linux: symlinks. The share lives at $LEINA_HOME/share/<kind>/<name>/ and each host's
// global dir gets one symlink per skill/agent pointing back to the share. A single source of
// truth means `leina install-global` (and an eventual self-update) propagates to every
// registered host without touching per-project files.
//
// Windows: creating SYMLINKS requires elevation or Developer Mode, but directory JUNCTIONS
// do not — so on win32 directories are linked with `symlinkSync(..., "junction")` (which
// Node/libuv reports back through `lstat().isSymbolicLink()` and `readlinkSync` just like a
// symlink, so junctions ARE managed links to doctor/repair/deactivate). Only FILE links can
// still hit EPERM/EACCES there; those fall back to a real copy with a warning on stderr —
// the user gets the files either way, just without the auto-propagation guarantee. The copy
// fallback is deliberately visible downstream: `inspectHostLinks` (doctor) classifies a real
// dir/file at a managed destination as "copy-fallback"/"copy-stale" and repair refreshes it
// on the next populate, while `unlinkIfManaged` (deactivate/uninstall) leaves copies alone —
// it never deletes anything that is not a link into our share.
//
// `readlinkSync` on a Windows junction/symlink may return the target in extended-length
// form (`\\?\C:\...`); `normalizeLinkTarget` strips that prefix so idempotency and
// managed-link checks compare like with like on every platform.
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
 * Link type per platform: on win32 directories use "junction" (works WITHOUT Developer
 * Mode/elevation, unlike "dir" symlinks) and files use "file" (may still need privilege —
 * the EPERM copy-fallback in linkOrCopy covers that). On POSIX the type hint is advisory.
 * Pure function of its inputs so the win32 branch is unit-testable from any platform.
 */
export function symlinkTypeFor(isDirectory: boolean, plat: NodeJS.Platform = process.platform): "dir" | "file" | "junction" {
  if (isDirectory) return plat === "win32" ? "junction" : "dir";
  return "file";
}

/**
 * Strip Windows extended-length prefixes from a readlink() result so link targets compare
 * equal to `path.resolve` output. Junctions in particular always come back as `\\?\C:\...`.
 * No-op on POSIX targets. Pure — unit-testable from any platform.
 */
export function normalizeLinkTarget(target: string): string {
  if (target.startsWith("\\\\?\\UNC\\")) return `\\\\${target.slice(8)}`;
  if (target.startsWith("\\\\?\\")) return target.slice(4);
  return target;
}

/** Resolve where the link at `p` points, normalized for cross-platform comparison. */
export function resolveLinkTarget(p: string): string {
  return resolve(dirname(p), normalizeLinkTarget(readlinkSync(p)));
}

// Test seam — lets unit tests simulate a Windows EPERM (symlink creation denied) on any
// platform, so the copy fallback is testable without a real unprivileged win32 box.
type SymlinkImpl = (target: string, path: string, type: "dir" | "file" | "junction") => void;
let symlinkImpl: SymlinkImpl = symlinkSync;
export function __setSymlinkImplForTests(impl: SymlinkImpl | null): void {
  symlinkImpl = impl ?? symlinkSync;
}

/**
 * Ensure `dest` is a symlink/junction (or copy fallback) of `src`. Both paths must be absolute.
 *
 * - `unchanged` — dest already points where we want; no-op.
 * - `symlinked` — dest didn't exist; created the link (junction for dirs on win32).
 * - `copied` — link creation failed (Windows EPERM); recursively copied src→dest instead.
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
      if (resolveLinkTarget(absDest) === absSrc) {
        return { path: absDest, action: "unchanged" };
      }
    }
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    displaced = `${absDest}.bak-${stamp}`;
    renameSync(absDest, displaced);
  }

  try {
    symlinkImpl(absSrc, absDest, symlinkTypeFor(statSync(absSrc).isDirectory()));
    return {
      path: absDest,
      action: displaced ? "backed-up-and-replaced" : "symlinked",
      backup: displaced,
    };
  } catch (err) {
    // EPERM / ENOTSUP / EACCES → copy fallback (a Windows FILE link without Developer
    // Mode is the primary culprit; directory junctions never need privilege). Anything
    // else is a real failure — re-throw.
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
 * The Windows copy fallback is a real dir/file, so it is intentionally left alone here.
 */
export function unlinkIfManaged(dest: string, expectedSrcPrefix: string): boolean {
  if (!existsSync(dest) && !isBrokenSymlink(dest)) return false;
  const lst = lstatSync(dest);
  if (!lst.isSymbolicLink()) return false;
  const target = resolveLinkTarget(dest);
  const rel = relative(resolve(expectedSrcPrefix), target);
  if (rel.startsWith("..") || rel === target) return false; // not inside the share
  unlinkSync(dest);
  return true;
}
