// hooks-common.ts — primitives shared by the per-host hook writers.
//
// devin-hooks.ts (.devin/hooks.v1.json + the Devin user-global config) and
// claude-hooks.ts (.claude/settings.json) emit the same on-disk entry shape:
//   { "<Event>": [ { "matcher": "...", "hooks": [{ "type": "command", "command": "..." }] } ] }
// They share the quoting and root-parsing primitives below. OWNERSHIP, however, is
// deliberately different per host and must stay in each writer:
//   - Devin replaces whole (event, matcher) pairs it owns — the file is fully managed.
//   - Claude marks its entries with a command token (AGENT_HOOK_MARK) and merges inside
//     entries, because users hand-edit .claude/settings.json around ours.
// Do not force one ownership model onto the other.

/** One command entry inside a hook matcher block. */
export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
  [k: string]: unknown;
}

/** One matcher block under an event key. */
export interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
  [k: string]: unknown;
}

/** Quote parts containing spaces, then space-join — the launch form every emitted hook uses. */
export function shellJoin(parts: string[]): string {
  return parts.map((p) => (p.includes(" ") ? `"${p}"` : p)).join(" ");
}

/**
 * Parse a JSON object root. Returns {} for a missing/blank file, null when the content
 * is malformed or not an object — each writer maps null to its own no-clobber contract
 * (Devin throws, Claude returns null).
 */
export function parseJsonRoot(existing: string | null | undefined): Record<string, unknown> | null {
  if (!existing?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
