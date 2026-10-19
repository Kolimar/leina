// hook-scope.ts — which copy of the managed wiring answers a hook event.
//
// The same managed gate can be wired in up to four places: a project's own files
// (`.devin/hooks.v1.json`, `.claude/settings.json`, written by `init`) and the machine-wide
// copies (`~/.config/devin/config.json`, `~/.claude/settings.json`, written by `activate`).
// A host fires every copy it reads, so without coordination one tool call would run the gate
// — injection, nudges, harness verify — once per copy. Claude Code reads its two files;
// Devin reads its own two AND Claude Code's two (it loads `.claude/` hooks by default).
//
// Rule: for each event, the highest-priority copy the running host reads answers; every
// lower copy stands down (silent exit 0). Project wiring beats user-global wiring, and a
// host's own format beats the borrowed one. Only entries that name their host and scope
// (the current launch form) can stand down: an entry without the flags cannot tell where it
// was written, so it always runs, exactly as before. Pure — the caller supplies what each
// copy wires.

import type { HookHost, HookScope } from "./hook-command.ts";

export type HookSource = "devin-project" | "claude-project" | "devin-user" | "claude-user";

/** The copy an entry belongs to: the host it was written for, and its scope. */
export function hookSourceOf(host: HookHost, scope: HookScope): HookSource {
  return `${host}-${scope}`;
}

/** The copies each running host fires, highest priority first. */
const READ_ORDER: Record<HookHost, readonly HookSource[]> = {
  claude: ["claude-project", "claude-user"],
  devin: ["devin-project", "claude-project", "devin-user", "claude-user"],
};

/** The copies that outrank `own` for a running host (empty for the top copy). */
export function higherPrioritySources(running: HookHost, own: HookSource): readonly HookSource[] {
  const order = READ_ORDER[running];
  const rank = order.indexOf(own);
  return rank < 0 ? [] : order.slice(0, rank);
}

/**
 * Should the invocation from copy `own` stand down for `event`? True when a higher-priority
 * copy the running host also fires wires the same event — that copy answers instead.
 * `wiresEvent(source)` says whether a copy carries a managed entry for `event`.
 */
export function shouldDeferHook(
  running: HookHost,
  own: HookSource,
  wiresEvent: (source: HookSource) => boolean,
): boolean {
  return higherPrioritySources(running, own).some(wiresEvent);
}

/**
 * The host actually running the hook. Each host documents its own project-dir variable, so
 * Devin is recognised by `DEVIN_PROJECT_DIR` and Claude Code by `CLAUDE_PROJECT_DIR`;
 * without either, the entry's own host.
 */
export function runningHookHost(env: NodeJS.ProcessEnv, entryHost: HookHost): HookHost {
  const set = (v: string | undefined): boolean => typeof v === "string" && v.trim().length > 0;
  if (set(env.DEVIN_PROJECT_DIR)) return "devin";
  if (set(env.CLAUDE_PROJECT_DIR)) return "claude";
  return entryHost;
}
