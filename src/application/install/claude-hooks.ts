// application/install/claude-hooks.ts — merge-safe writer for Claude Code project hooks.
//
// Claude Code reads hooks from the project's `.claude/settings.json` (committable). The
// managed entries call back into the host-neutral gate (`leina agent-hook <Event>`) with
// absolute node+cli paths — the exact launch form deriveCliCommand builds for Devin, and
// for the same reason: GUI hosts do not inherit the shell PATH.
//
// Ownership rule (same convention as devin-hooks.ts): an entry is OURS iff its command
// contains the AGENT_HOOK_MARK token. Everything else in the file — other hooks, other
// matchers, unknown top-level keys — is preserved verbatim. Pure string -> string|null.

import type { McpCommand } from "./protocol.ts";
import { type HookCommand, type HookEntry, parseJsonRoot, shellJoin } from "./hooks-common.ts";

export const AGENT_HOOK_MARK = " agent-hook ";

/** Gate events registered for Claude Code, with each event's tool matcher. */
const MANAGED_EVENTS: { event: string; matcher?: string }[] = [
  // startup|resume|clear: fresh-session context injection. Claude Code's `compact` source
  // re-fires SessionStart, covering what Devin models as PostCompaction.
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  // The gate reacts to shell commands (memory markers) and native search (nudge).
  { event: "PostToolUse", matcher: "Bash|Grep|Read|Glob" },
  { event: "Stop" },
];

interface ClaudeSettingsShape {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

function gateCommand(cliBase: McpCommand, event: string): string {
  return shellJoin([cliBase.command, ...cliBase.args, "agent-hook", event]);
}

const isOurs = (h: HookCommand): boolean =>
  typeof h.command === "string" && h.command.includes(`${AGENT_HOOK_MARK.trim()  } `) ||
  (typeof h.command === "string" && h.command.includes(AGENT_HOOK_MARK));

function parseSettings(existing: string | null): ClaudeSettingsShape | null {
  return parseJsonRoot(existing); // null = no-clobber
}

/**
 * Merge the managed agent-hook entries into a `.claude/settings.json`. Returns the new
 * content, or null when nothing changes (idempotent) or the file is unparseable (no-clobber).
 */
export function claudeHooksJson(cliBase: McpCommand, existing: string | null): string | null {
  const root = parseSettings(existing);
  if (root === null) return null;
  const hooks: Record<string, HookEntry[]> = (root.hooks ?? {});

  for (const { event, matcher } of MANAGED_EVENTS) {
    const entries: HookEntry[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    // Drop any previous entry of OURS for this event, then append the current form.
    const kept = entries
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((e) => (e.hooks?.length ?? 0) > 0 || Object.keys(e).some((k) => k !== "hooks" && k !== "matcher"));
    const ours: HookEntry = {
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [{ type: "command", command: gateCommand(cliBase, event) }],
    };
    hooks[event] = [...kept, ours];
  }

  root.hooks = hooks;
  const next = `${JSON.stringify(root, null, 2)}\n`;
  return existing !== null && next === existing ? null : next;
}

/** Strip every managed agent-hook entry; drops empty events / the hooks key. Null = no change. */
export function removeClaudeHooks(existing: string | null): string | null {
  const root = parseSettings(existing);
  if (root === null || existing === null || root.hooks === undefined) return null;
  let changed = false;
  const hooks = root.hooks;

  for (const event of Object.keys(hooks)) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    const next = entries
      .map((e) => {
        const keptCmds = (e.hooks ?? []).filter((h) => !isOurs(h));
        if (keptCmds.length !== (e.hooks?.length ?? 0)) changed = true;
        return { ...e, hooks: keptCmds };
      })
      .filter((e) => (e.hooks?.length ?? 0) > 0);
    if (next.length === 0) delete hooks[event];
    else hooks[event] = next;
  }

  if (!changed) return null;
  if (Object.keys(hooks).length === 0) delete root.hooks;
  return `${JSON.stringify(root, null, 2)}\n`;
}
