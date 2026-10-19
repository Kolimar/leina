// infrastructure/env/env-file.ts — I/O for the leina env store ($LEINA_HOME/.env).
//
// Secrets live here in plain text BY EXPLICIT DESIGN DECISION: 0600 permissions +
// masking + process-injection instead
// of an OS keychain, which would need native dependencies. Every write replaces the file
// with a fresh owner-only one; reads report the current mode so doctor can warn about a
// loosened file.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { leinaHome } from "../install/share-paths.ts";

export function envFilePath(): string {
  return join(leinaHome(), ".env");
}

export function readEnvFile(): string | null {
  const p = envFilePath();
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/**
 * Replace the store atomically with an owner-only file. The content goes to a temp file
 * in the same directory that is CREATED with mode 0600 — rewriting in place would put the
 * new secret into the existing inode, which may have been loosened to 0644, before any
 * chmod could tighten it — is fsynced, then renamed over the store. A crash or ENOSPC
 * midway leaves the previous store intact instead of a truncated file that has lost every
 * secret. (Windows: mode bits are a no-op there; ACLs default to the owner.)
 */
export function writeEnvFile(content: string): void {
  const p = envFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600); // "wx": create fresh, never reuse an existing path
    const buf = Buffer.from(content, "utf8");
    for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, p);
  } catch (e) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already failing — keep the original error */ }
    }
    try { unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw e;
  }
}

/**
 * True when the store exists with permissions looser than owner-only (POSIX group/other
 * bits set). Always false on Windows, where POSIX mode bits are not meaningful.
 */
export function envFilePermsTooOpen(): boolean {
  if (process.platform === "win32") return false;
  const p = envFilePath();
  if (!existsSync(p)) return false;
  try {
    return (statSync(p).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}
