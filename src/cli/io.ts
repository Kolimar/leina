// cli/io.ts — shared process/console/fs glue for the CLI command handlers.
// Kept deliberately tiny and dependency-free so every handler module can import it
// without pulling in heavier wiring.

import { existsSync, readFileSync } from "node:fs";

/** Print a message to stderr and exit with code 1. Never returns. */
export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Read a file if it exists, else return null. */
export function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Read all of stdin synchronously (fd 0). Returns "" if nothing/unreadable. */
export function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
