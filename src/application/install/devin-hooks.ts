// devin-hooks.ts — pure writers for the Devin (Claude-compatible) hooks surface.
//
// Two destinations, same managed shape, both merge-safe + idempotent:
//   - Project file:    .devin/hooks.v1.json                              (FR-1..FR-3)
//   - User-global:     ~/.config/devin/config.json under the "hooks" key (FR-4)
//
// On-disk JSON shape (Devin / Claude-compatible):
//   { "<EventName>": [ { "matcher": "<regex>", "hooks": [ { "type": "command", "command": "..." } ] } ] }
//
// We own 6 event keys (PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / PostCompaction / Stop). Within each
// event we own SPECIFIC matchers (see MANAGED_MATCHERS); on a re-run, only entries whose
// (event, matcher) pair matches a managed pair are replaced. Everything else in the file —
// other event keys, other matchers under a managed event, unrelated top-level keys — is kept
// verbatim. The gate logic itself lives in gate.ts (decideAgentGate / runAgentGate).

import type { FileArtifact } from "../../domain/install/artifact.ts";
import type { McpCommand } from "./protocol.ts";
import { parseJsonRoot, shellJoin } from "./hooks-common.ts";

// ---------------------------------------------------------------------------
// Type contracts (mirrored from the SDD design — section 2)
// ---------------------------------------------------------------------------

export type DevinHookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "SessionStart"
  | "PostCompaction"
  | "Stop";

export const DEVIN_MANAGED_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "PostCompaction",
  "Stop",
] as const satisfies readonly DevinHookEventName[];

export interface DevinHookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

export interface DevinHookMatcher {
  matcher: string;
  hooks: DevinHookEntry[];
}

export type DevinHooksFile = Record<DevinHookEventName, DevinHookMatcher[]>;

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/** Parse-or-throw guard reused by both Devin writers. Refuses to clobber malformed JSON. */
function parseRootObject(existing: string | null | undefined, label: string): Record<string, unknown> {
  const root = parseJsonRoot(existing);
  if (root === null) {
    throw new Error(`${label}: existing file is not a valid JSON object; refusing to clobber it`);
  }
  return root;
}

/**
 * The (event, matcher) pairs we own. A second `init` replaces entries with these matchers in
 * place; any other matcher under the same event is preserved.
 */
const MANAGED_MATCHERS: Record<DevinHookEventName, readonly string[]> = {
  // ADR-1: existing string preserved verbatim (idempotency/merge-safety); new matcher added.
  PreToolUse: ["^(edit|write|exec)$", "^(grep|glob)$"],
  PostToolUse: [
    "^(edit|write)$",
    // exec: the gate inspects the command line for `leina memory (context|search|verified)`
    // to flip the per-session memory-loaded marker (CLI-only — no MCP tool to key on).
    "^exec$",
    // Palanca C: retrospective nudge for native grep/read/glob tools.
    "^(read|grep|glob)$",
  ],
  UserPromptSubmit: [""],
  SessionStart: [""],
  // PostCompaction: non-tool event; empty matcher fires for all compaction events.
  PostCompaction: [""],
  // Stop: fires when the agent finishes a turn; empty matcher fires unconditionally.
  Stop: [""],
};

/** Build the full managed hooks block for the PROJECT file (includes freshness refresh). */
function buildManagedHooks(cli: McpCommand, project: string): DevinHooksFile {
  const cliLine = shellJoin([cli.command, ...cli.args]);
  const cmd = (sub: string): DevinHookEntry => ({
    type: "command",
    command: `${cliLine} ${sub}`,
  });

  return {
    PreToolUse: [
      { matcher: "^(edit|write|exec)$", hooks: [cmd("devin-hook PreToolUse")] },
      // Palanca A: native grep/glob tool → advisory to prefer leina query/affected.
      { matcher: "^(grep|glob)$", hooks: [cmd("devin-hook PreToolUse")] },
    ],
    PostToolUse: [
      // Freshness: rebuild the graph after a code edit.
      { matcher: "^(edit|write)$", hooks: [cmd(`refresh ${project}`)] },
      // Marker write: the gate inspects the exec command for `leina memory
      // (context|search|verified)` and flips the session gate when memory is loaded.
      { matcher: "^exec$", hooks: [cmd("devin-hook PostToolUse")] },
      // Palanca C: retrospective nudge after native grep/read/glob — one-shot per session.
      { matcher: "^(read|grep|glob)$", hooks: [cmd("devin-hook PostToolUse")] },
    ],
    UserPromptSubmit: [
      // Hard gate on the first user message of a fresh session — blocks with FIRST_TURN_GATE
      // until the agent calls mem_context (PostToolUse marker fires below). Paired with the
      // SessionStart additionalContext so a well-behaved agent loads memory BEFORE this fires.
      { matcher: "", hooks: [cmd("devin-hook UserPromptSubmit")] },
    ],
    SessionStart: [
      { matcher: "", hooks: [cmd("devin-hook SessionStart")] },
    ],
    // PostCompaction: re-inject memory + graph context after a compaction event and re-arm
    // the session marker. `summary` is intentionally ignored; injection is unconditional.
    PostCompaction: [
      { matcher: "", hooks: [cmd("devin-hook PostCompaction")] },
    ],
    // Stop: advisory nudge to persist session memory. Gate checks session.memory-saved marker;
    // emits STOP_SAVE_NUDGE on stderr if absent. stdout ALWAYS empty. Never blocks.
    Stop: [
      { matcher: "", hooks: [cmd("devin-hook Stop")] },
    ],
  };
}

/**
 * Merge `managed` into `prior` for the events we own, preserving all other entries:
 *  - Event keys NOT in DEVIN_MANAGED_EVENTS are passed through untouched (handled by caller).
 *  - Within a managed event, matchers NOT in MANAGED_MATCHERS[event] are kept verbatim;
 *    matchers that ARE managed get replaced by the entry from `managed`.
 */
function mergeManagedEvent(
  event: DevinHookEventName,
  prior: DevinHookMatcher[],
  managed: DevinHookMatcher[],
): DevinHookMatcher[] {
  const ownedMatchers = new Set(MANAGED_MATCHERS[event]);
  // Strip the managed matchers from the prior list (we'll re-emit them from `managed`).
  const preserved = prior.filter((m) => !ownedMatchers.has(m.matcher));
  // Emit preserved unmanaged entries first, then the managed ones in declared order.
  return [...preserved, ...managed];
}

/** Coerce an unknown value into DevinHookMatcher[] or [] if it isn't shaped like one. */
function asMatcherArray(value: unknown): DevinHookMatcher[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is DevinHookMatcher =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as DevinHookMatcher).matcher === "string" &&
      Array.isArray((entry as DevinHookMatcher).hooks),
  );
}

// ---------------------------------------------------------------------------
// Public writers
// ---------------------------------------------------------------------------

/**
 * Build a `.devin/hooks.v1.json` artifact, merging into `existing` if given.
 * Idempotent on its own output; merge-safe with unmanaged event keys and matchers.
 */
export function devinHooksJson(
  cli: McpCommand,
  project: string,
  existing?: string | null,
): FileArtifact {
  const root = parseRootObject(existing, ".devin/hooks.v1.json");
  const managed = buildManagedHooks(cli, project);

  const out: Record<string, unknown> = { ...root };
  for (const event of DEVIN_MANAGED_EVENTS) {
    const prior = asMatcherArray(root[event]);
    out[event] = mergeManagedEvent(event, prior, managed[event]);
  }

  return {
    path: ".devin/hooks.v1.json",
    content: `${JSON.stringify(out, null, 2)  }\n`,
  };
}

/**
 * Merge a managed Devin hooks block into the user-global `~/.config/devin/config.json` under
 * the top-level `"hooks"` key. Preserves every other top-level key (e.g. `mcpServers`) and
 * every unmanaged hook entry already living under `"hooks"`.
 *
 * @param existing  current file contents, or null when the file does not exist yet
 * @param hooks     the managed hooks block to install (typically from buildUserGlobalHooks)
 */
export function devinUserConfigWithHooks(
  existing: string | null,
  hooks: DevinHooksFile,
): string {
  const root = parseRootObject(existing, "~/.config/devin/config.json");
  const priorHooks =
    typeof root.hooks === "object" && root.hooks !== null && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : {};

  const mergedHooks: Record<string, unknown> = { ...priorHooks };
  for (const event of DEVIN_MANAGED_EVENTS) {
    const prior = asMatcherArray(priorHooks[event]);
    mergedHooks[event] = mergeManagedEvent(event, prior, hooks[event]);
  }

  const out = { ...root, hooks: mergedHooks };
  return `${JSON.stringify(out, null, 2)  }\n`;
}

/**
 * Build the user-global flavour of the managed hooks block — identical to the project block
 * MINUS the per-project freshness refresh (one global path can't be correct for every repo).
 * Gate entries (PreToolUse, PostToolUse marker, UserPromptSubmit, SessionStart) resolve the
 * marker from `cwd()` so they remain project-agnostic and safe to install globally.
 */
export function buildUserGlobalHooks(cli: McpCommand): DevinHooksFile {
  const project = buildManagedHooks(cli, "/unused");
  return {
    ...project,
    PostToolUse: project.PostToolUse.filter((m) => !m.matcher.startsWith("^(edit|write)")),
  };
}

/**
 * Remove all managed hook matchers from a user-global `~/.config/devin/config.json` content.
 * Inverse of `devinUserConfigWithHooks`. Pure (string|null → string|null), idempotent, no-clobber.
 *
 * For each event in DEVIN_MANAGED_EVENTS, strips the matchers whose `matcher` value is in
 * MANAGED_MATCHERS[event]. Events that become empty after stripping are pruned from the hooks
 * object. Unmanaged event keys and unmanaged matchers under managed events are preserved.
 *
 *  - null / blank / malformed JSON   → null (no-clobber)
 *  - no managed hooks present        → null (idempotent no-op)
 *  - managed hooks present           → new content with managed matchers removed
 */
export function removeUserGlobalHooks(existing: string | null): string | null {
  if (!existing?.trim()) return null;

  // Use the shared parser — malformed JSON → throws in parseRootObject, so we catch here
  // to honour the no-clobber / never-throw contract.
  let root: Record<string, unknown>;
  try {
    root = parseRootObject(existing, "~/.config/devin/config.json");
  } catch {
    return null; // malformed → no-clobber
  }

  const hooksRaw = root.hooks;
  if (hooksRaw === undefined || hooksRaw === null || typeof hooksRaw !== "object" || Array.isArray(hooksRaw)) {
    return null; // no hooks key at all (or wrong shape) → nothing to remove
  }
  const hooksObj = hooksRaw as Record<string, unknown>;

  let changed = false;
  const newHooks: Record<string, unknown> = { ...hooksObj };

  for (const event of DEVIN_MANAGED_EVENTS) {
    const ownedMatchers = new Set(MANAGED_MATCHERS[event]);
    const priorArray = asMatcherArray(hooksObj[event]);

    // Filter out managed matchers
    const kept = priorArray.filter((m) => !ownedMatchers.has(m.matcher));

    if (kept.length !== priorArray.length) {
      changed = true;
      // Prune the event key entirely if no matchers remain
      if (kept.length === 0) {
        delete newHooks[event];
      } else {
        newHooks[event] = kept;
      }
    }
  }

  if (!changed) return null; // nothing was removed → idempotent no-op

  // Prune the hooks key if it becomes empty
  const out = { ...root };
  if (Object.keys(newHooks).length === 0) {
    delete out.hooks;
  } else {
    out.hooks = newHooks;
  }
  return `${JSON.stringify(out, null, 2)  }\n`;
}
