// application/env/store.ts — pure parsing/serialization of the leina env store.
//
// The store backs `leina env` (and later the TUI): a single global dotenv-style file at
// $LEINA_HOME/.env holding variables that skills need to call external services.
//
// GOVERNING PRINCIPLE — "names, not values": an AI agent driving this CLI only ever
// handles variable NAMES. Values enter through a hidden TTY prompt or piped stdin (never
// argv, never the agent transcript), leave only via `env exec` process injection or an
// explicit TTY-gated --reveal, and are always MASKED in listings. These are pure
// string→data functions (repo convention); the CLI owns all I/O and prompting.
//
// File format: `KEY=value` lines, one per variable, single-line values, `#` comments and
// blank lines preserved verbatim on rewrite. Values are stored raw after the first `=`
// (a surrounding quote pair is stripped on parse for dotenv compatibility). A hand-edited
// file may space the key (`TOKEN =x`) or repeat it: every verb identifies a line by the
// SAME parsed key (lineKey), a repeated key resolves to its last value (dotenv/shell
// semantics), and `set` collapses the repeats into one line.

export interface EnvEntry {
  key: string;
  value: string;
}

/** KEY validation: conventional environment variable names. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The variable a line assigns, exactly as parseEnvFile reads it; null for comments,
// blanks and lines it skips.
function lineKey(line: string): string | null {
  const t = line.trim();
  if (t === "" || t.startsWith("#")) return null;
  const eq = t.indexOf("=");
  if (eq <= 0) return null;
  const key = t.slice(0, eq).trim();
  return ENV_KEY_RE.test(key) ? key : null;
}

export function parseEnvFile(content: string | null): EnvEntry[] {
  if (content === null) return [];
  const out: EnvEntry[] = [];
  const at = new Map<string, number>();
  for (const line of content.split("\n")) {
    const key = lineKey(line);
    if (key === null) continue;
    const t = line.trim();
    let value = t.slice(t.indexOf("=") + 1);
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    // A repeated key keeps its first position but takes the last value, so `get`,
    // `list` and `exec` all agree on one value.
    const prev = at.get(key);
    if (prev === undefined) {
      at.set(key, out.length);
      out.push({ key, value });
    } else {
      out[prev] = { key, value };
    }
  }
  return out;
}

/**
 * Upsert KEY=value into the file content, preserving comments, blank lines and unknown
 * lines verbatim. The first line assigning KEY is replaced; any later repeat is dropped.
 * Returns the new content. Idempotent for identical (key, value).
 */
export function upsertEnvVar(content: string | null, key: string, value: string): string {
  if (!ENV_KEY_RE.test(key)) throw new Error(`invalid variable name "${key}"`);
  if (value.includes("\n")) throw new Error("values must be single-line");
  const line = `${key}=${value}`;
  const lines = (content ?? "").split("\n");
  let replaced = false;
  const next: string[] = [];
  for (const l of lines) {
    if (lineKey(l) !== key) {
      next.push(l);
    } else if (!replaced) {
      replaced = true;
      next.push(line);
    }
  }
  if (!replaced) {
    // Drop a single trailing blank line so appends stay tidy.
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    if (next.length === 0) {
      next.push("# leina env store — values for skills that call external services.", "# Managed by `leina env`; plain text, keep permissions at 0600.", "");
    }
    next.push(line);
  }
  return next.join("\n") + (next[next.length - 1] === "" ? "" : "\n");
}

/**
 * Remove every line assigning KEY (comments/unknown lines preserved). Null when absent.
 */
export function removeEnvVar(content: string | null, key: string): string | null {
  if (content === null) return null;
  const lines = content.split("\n");
  const next = lines.filter((l) => lineKey(l) !== key);
  return next.length === lines.length ? null : next.join("\n");
}

/** Mask a secret for display: never enough to reconstruct it. */
export function maskValue(value: string): string {
  if (value.length === 0) return "(empty)";
  if (value.length <= 6) return "****";
  return `${value.slice(0, 3)}****`;
}
