// cli/io.ts — shared process/console/fs glue for the CLI command handlers.
// Kept deliberately tiny and dependency-free so every handler module can import it
// without pulling in heavier wiring.

import { existsSync, readFileSync } from "node:fs";

/** Runtime failure (no graph, ambiguous project, no match, I/O): message on stderr, exit 1. */
export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Exit code of a usage error — distinct from a runtime failure (1) so callers can tell them apart. */
export const EXIT_USAGE = 2;

// The command being run ("memory search"), set once by the dispatcher so a handler's usage
// error points at the right help without every call site naming its own command.
let commandPath = "";

export function setCommandPath(path: string): void {
  commandPath = path;
}

/**
 * Usage error (unknown command/sub-command/flag, missing or invalid argument or flag value):
 * `leina <path>: <msg>` plus a one-line hint on stderr, exit 2. `path` defaults to the
 * command being run; "" points at the root help. Never returns.
 */
export function usageError(msg: string, path: string = commandPath): never {
  console.error(`${path === "" ? "leina" : `leina ${path}`}: ${msg}`);
  console.error(path === "" ? "run 'leina --help' for the list of commands" : `run 'leina ${path} --help' for usage`);
  process.exit(EXIT_USAGE);
}

/** A path as it should appear inside a suggested command: single-quoted when the shell needs it. */
export function shellArg(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
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
