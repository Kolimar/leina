// infrastructure/env/env-file.ts — I/O for the leina env store ($LEINA_HOME/.env).
//
// Secrets live here in plain text BY EXPLICIT DESIGN DECISION: 0600 permissions +
// masking + process-injection instead
// of an OS keychain, which would need native dependencies. Every write (re)asserts 0600;
// reads report the current mode so doctor can warn about a loosened file.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { leinaHome } from "../install/share-paths.ts";

export function envFilePath(): string {
  return join(leinaHome(), ".env");
}

export function readEnvFile(): string | null {
  const p = envFilePath();
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Write the store and (re)assert owner-only permissions. */
export function writeEnvFile(content: string): void {
  const p = envFilePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, { mode: 0o600 });
  try {
    chmodSync(p, 0o600); // writeFileSync's mode only applies on CREATE — re-assert on rewrite
  } catch {
    /* Windows: mode bits are a no-op; ACLs default to the owner */
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
