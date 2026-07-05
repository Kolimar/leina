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
// (a surrounding quote pair is stripped on parse for dotenv compatibility).

export interface EnvEntry {
  key: string;
  value: string;
}

/** KEY validation: conventional environment variable names. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvFile(content: string | null): EnvEntry[] {
  if (content === null) return [];
  const out: EnvEntry[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) continue;
    let value = t.slice(eq + 1);
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}

/**
 * Upsert KEY=value into the file content, preserving comments, blank lines and unknown
 * lines verbatim. Returns the new content. Idempotent for identical (key, value).
 */
export function upsertEnvVar(content: string | null, key: string, value: string): string {
  if (!ENV_KEY_RE.test(key)) throw new Error(`invalid variable name "${key}"`);
  if (value.includes("\n")) throw new Error("values must be single-line");
  const line = `${key}=${value}`;
  const lines = (content ?? "").split("\n");
  let replaced = false;
  const next = lines.map((l) => {
    const t = l.trim();
    if (!replaced && !t.startsWith("#") && t.startsWith(`${key}=`)) {
      replaced = true;
      return line;
    }
    return l;
  });
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

/** Remove KEY from the content (comments/unknown lines preserved). Null when absent. */
export function removeEnvVar(content: string | null, key: string): string | null {
  if (content === null) return null;
  const lines = content.split("\n");
  const next = lines.filter((l) => {
    const t = l.trim();
    return t.startsWith("#") || !t.startsWith(`${key}=`);
  });
  return next.length === lines.length ? null : next.join("\n");
}

/** Mask a secret for display: never enough to reconstruct it. */
export function maskValue(value: string): string {
  if (value.length === 0) return "(empty)";
  if (value.length <= 6) return "****";
  return `${value.slice(0, 3)}****`;
}
