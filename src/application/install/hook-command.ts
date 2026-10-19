// hook-command.ts — the launch line every managed agent hook runs, and its parser.
//
// Every host writer (devin-hooks.ts, claude-hooks.ts) emits the same shape:
//   <node> [node flags] <cli entry> agent-hook <Event> --host <claude|devin> [--scope user]
// The explicit flags tell the gate which OUTPUT PROTOCOL to speak (Claude Code never shows
// a hook's stderr on exit 0; Devin keeps its stderr nudges) and whether the entry is the
// machine-wide copy that must defer to a project's own wiring. Entries written before the
// flags existed carry neither and are still recognised (`devin-hook` was the original
// subcommand name; the CLI keeps it as an alias).
//
// The parser is what `doctor` uses to find every managed entry and the CLI path it bakes,
// and what the gate uses to tell a project's own wiring from the user-global copy. Pure.

import type { McpCommand } from "./protocol.ts";
import { shellJoin } from "./hooks-common.ts";

export type HookHost = "claude" | "devin";
export type HookScope = "project" | "user";

/** Subcommands that identify a managed gate entry (`devin-hook` = the pre-2.0 alias). */
const GATE_SUBCOMMANDS = new Set(["agent-hook", "devin-hook"]);

export function isHookHost(value: string | undefined): value is HookHost {
  return value === "claude" || value === "devin";
}

/** The managed gate command for one event. */
export function agentHookCommand(cli: McpCommand, event: string, host: HookHost, scope: HookScope): string {
  const scopeArgs = scope === "user" ? ["--scope", "user"] : [];
  return shellJoin([cli.command, ...cli.args, "agent-hook", event, "--host", host, ...scopeArgs]);
}

export interface ParsedHookCommand {
  /** The node binary the entry launches. */
  node: string;
  /** The CLI entry (the token right before the subcommand) — what doctor checks. */
  cli: string;
  event?: string;
  /** Absent on entries written before the flag existed. */
  host?: HookHost;
  scope: HookScope;
}

/** Split a command line the way shellJoin built it: spaces, with "..." grouping. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(command); m !== null; m = re.exec(command)) tokens.push(m[1] ?? m[2] ?? "");
  return tokens;
}

/** Parse a managed gate command; undefined for anything that is not one of ours. */
export function parseManagedHookCommand(command: unknown): ParsedHookCommand | undefined {
  if (typeof command !== "string") return undefined;
  const tokens = tokenize(command);
  const at = tokens.findIndex((t) => GATE_SUBCOMMANDS.has(t));
  if (at < 1) return undefined;
  const flag = (name: string): string | undefined => {
    const i = tokens.indexOf(name, at + 1);
    return i < 0 ? undefined : tokens[i + 1];
  };
  const host = flag("--host");
  return {
    node: tokens[0]!,
    cli: tokens[at - 1]!,
    ...(tokens[at + 1] !== undefined && !tokens[at + 1]!.startsWith("--") ? { event: tokens[at + 1] } : {}),
    ...(isHookHost(host) ? { host } : {}),
    scope: flag("--scope") === "user" ? "user" : "project",
  };
}

/**
 * The pre-3.0 Devin project file ran `<cli> refresh <project>` after every edit/write — a
 * full synchronous rebuild per agent edit. Recognised so writers strip it and doctor names it.
 */
export function isLegacyRefreshCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const tokens = tokenize(command);
  const at = tokens.indexOf("refresh");
  return at >= 2 && /(?:^|[\\/])index\.(?:js|ts)$/.test(tokens[at - 1]!);
}

export interface FoundHookCommand {
  event: string;
  matcher?: string;
  command: string;
}

/**
 * Every hook command under a hooks object (`{ "<Event>": [ { matcher, hooks: [...] } ] }`).
 * Tolerant: anything not shaped like a hook entry is skipped.
 */
export function hookCommandsIn(hooks: unknown): FoundHookCommand[] {
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const out: FoundHookCommand[] = [];
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const { matcher, hooks: cmds } = entry as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(cmds)) continue;
      for (const cmd of cmds as unknown[]) {
        const command = (cmd as { command?: unknown } | null)?.command;
        if (typeof command !== "string") continue;
        out.push({ event, ...(typeof matcher === "string" ? { matcher } : {}), command });
      }
    }
  }
  return out;
}

/**
 * The hooks object of a host config file's text: the whole file for `.devin/hooks.v1.json`
 * ("root"), the `hooks` key everywhere else. Undefined when absent or unparseable.
 */
export function hooksObjectOf(text: string | null, shape: "root" | "hooks-key"): unknown {
  if (text === null || text.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return shape === "root" ? parsed : (parsed as Record<string, unknown>).hooks;
  } catch {
    return undefined;
  }
}

/** Managed gate commands in a host config file's text, optionally only one scope. */
export function managedHookCommands(
  text: string | null,
  shape: "root" | "hooks-key",
  scope?: HookScope,
): ParsedHookCommand[] {
  return hookCommandsIn(hooksObjectOf(text, shape))
    .map((h) => parseManagedHookCommand(h.command))
    .filter((p): p is ParsedHookCommand => p !== undefined && (scope === undefined || p.scope === scope));
}
