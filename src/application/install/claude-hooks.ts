// application/install/claude-hooks.ts — merge-safe writer for Claude Code hooks.
//
// Claude Code reads hooks from the project's `.claude/settings.json` (committable, written by a
// FULL `init`) and from the user's `~/.claude/settings.json` (written by `setup`/`activate`,
// fires in every project). The managed entries call back into the host-neutral gate
// (`leina agent-hook <Event> --host claude [--scope user]`) with absolute node+cli paths — the
// exact launch form deriveCliCommand builds for Devin, and for the same reason: GUI hosts do
// not inherit the shell PATH.
//
// Ownership rule: an entry is OURS iff its command parses as a managed gate command
// (hook-command.ts). Everything else in the file — other hooks, other matchers, unknown
// top-level keys — is preserved verbatim. Pure string -> string|null.

import type { McpCommand } from "./protocol.ts";
import { type HookCommand, type HookEntry, parseJsonRoot } from "./hooks-common.ts";
import { agentHookCommand, type HookScope, parseManagedHookCommand } from "./hook-command.ts";

/** Token every managed gate command carries — a cheap "is there leina wiring here?" probe. */
export const AGENT_HOOK_MARK = " agent-hook ";

/**
 * The Claude Code tools the harness enforcement branch acts on (agent-gate.ts
 * HARNESS_EDIT_TOOLS / HARNESS_BASH_TOOLS): the integrity seal, the contract scope and the
 * commit guard only run when Claude Code fires PreToolUse for them. `Bash` also carries the
 * advisory (git commit, grep). An exact-name list — Claude Code matches `|`-separated names
 * literally.
 */
export const CLAUDE_PRE_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash";

/** Gate events registered for Claude Code, with each event's tool matcher. */
const MANAGED_EVENTS: { event: string; matcher?: string }[] = [
  // startup|resume|clear|compact: context injection. Claude Code's `compact` source re-fires
  // SessionStart, covering what Devin models as PostCompaction.
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: CLAUDE_PRE_TOOL_MATCHER },
  // The gate reacts to shell commands (memory markers) and native search (nudge).
  { event: "PostToolUse", matcher: "Bash|Grep|Read|Glob" },
  { event: "Stop" },
];

interface ClaudeSettingsShape {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

const isOurs = (h: HookCommand): boolean => parseManagedHookCommand(h.command) !== undefined;

function parseSettings(existing: string | null): ClaudeSettingsShape | null {
  return parseJsonRoot(existing); // null = no-clobber
}

/**
 * Merge the managed agent-hook entries into a Claude Code settings file — the project's
 * `.claude/settings.json` (scope "project", the default) or `~/.claude/settings.json`
 * (scope "user"). Returns the new content, or null when nothing changes (idempotent) or the
 * file is unparseable (no-clobber). Any previous managed entry — an older launch form, a
 * stale CLI path, a missing flag — is replaced by the current one.
 */
export function claudeHooksJson(cliBase: McpCommand, existing: string | null, scope: HookScope = "project"): string | null {
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
      hooks: [{ type: "command", command: agentHookCommand(cliBase, event, "claude", scope) }],
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
