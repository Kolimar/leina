// application/harness/adapters/json-merge.ts — structural JSON merges into
// files harness never owns (.cursor/hooks.json, opencode.json). Harness entries
// are identified by content (command marker / generated path), stripped, and
// re-inserted — user entries and unrelated settings are preserved verbatim.
//
// Ported from the origin harness-framework's src/adapters/json-merge.ts, minus
// mergeClaudeHooks: under leina the claude-code adapter no longer wires hooks
// into .claude/settings.json (enforcement rides leina's agent-gate instead),
// so only the cursor and opencode strategies remain.

export const HARNESS_CMD_MARKER = "harness hook";

/**
 * A command is harness-managed when it contains the default marker OR invokes
 * one of our hook events — this keeps cleanup working when `hookCommand` is
 * overridden (e.g. "node dist/cli/index.js harness hook stop"). The default
 * `leina harness hook` matches the marker too.
 */
const HOOK_EVENT_RE =
  /\bhook (session-start|pre-edit|pre-bash|stop|cursor-shell|cursor-after-edit|cursor-stop|idle)\b/;

export function isHarnessHookCommand(command: string): boolean {
  return command.includes(HARNESS_CMD_MARKER) || HOOK_EVENT_RE.test(command);
}

export interface JsonMergeResult {
  content: string;
  changed: boolean;
  error?: string;
}

function parseObjectRoot(
  existingJson: string | undefined,
  what: string,
): { root: Record<string, unknown> } | { failure: JsonMergeResult } | { empty: true } {
  if (existingJson === undefined || existingJson.trim() === "") return { empty: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(existingJson);
  } catch (err) {
    return {
      failure: { content: existingJson, changed: false, error: `invalid JSON: ${(err as Error).message}` },
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { failure: { content: existingJson, changed: false, error: `${what} is not a JSON object` } };
  }
  return { root: parsed as Record<string, unknown> };
}

/**
 * .cursor/hooks.json merge: entries are {command} objects per event; harness
 * entries are identified by the command marker, stripped, and re-inserted.
 */
export function mergeCursorHooks(
  existingJson: string | undefined,
  desired: Record<string, string[]>,
): JsonMergeResult {
  const parsed = parseObjectRoot(existingJson, "hooks.json");
  if ("failure" in parsed) return parsed.failure;
  const root: Record<string, unknown> = "root" in parsed ? parsed.root : {};
  if (root.version === undefined) root.version = 1;

  const hooks: Record<string, { command?: string; [key: string]: unknown }[]> =
    typeof root.hooks === "object" && root.hooks !== null && !Array.isArray(root.hooks)
      ? { ...(root.hooks as Record<string, { command?: string }[]>) }
      : {};

  const allEvents = new Set([...Object.keys(hooks), ...Object.keys(desired)]);
  for (const event of allEvents) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = entries.filter((e) => !(typeof e.command === "string" && isHarnessHookCommand(e.command)));
    const additions = (desired[event] ?? []).map((command) => ({ command }));
    const merged = [...kept, ...additions];
    if (merged.length > 0) hooks[event] = merged;
    else delete hooks[event];
  }

  root.hooks = hooks;
  const content = `${JSON.stringify(root, null, 2)}\n`;
  return { content, changed: content !== existingJson };
}

/**
 * Deinit inverse of mergeCursorHooks: drop every harness-managed entry, keep
 * the user's. (A merge with no desired additions is exactly that strip.)
 */
export function stripCursorHooks(existingJson: string): JsonMergeResult {
  return mergeCursorHooks(existingJson, {});
}

/**
 * Deinit inverse of mergeOpencodeInstructions: drop the harness-generated
 * instruction entries (they point at files deinit just deleted).
 */
export function stripOpencodeInstructions(existingJson: string): JsonMergeResult {
  const parsed = parseObjectRoot(existingJson, "opencode.json");
  if ("failure" in parsed) return parsed.failure;
  if (!("root" in parsed)) return { content: existingJson, changed: false };
  const root = parsed.root;

  const existing = Array.isArray(root.instructions) ? (root.instructions as unknown[]) : [];
  const kept = existing.filter((e) => !(typeof e === "string" && e.includes(".harness/generated/")));
  if (kept.length > 0) root.instructions = kept;
  else delete root.instructions;

  const content = `${JSON.stringify(root, null, 2)}\n`;
  return { content, changed: content !== existingJson };
}

/** The empty hooks skeleton the cursor strategy leaves when it created the file. */
function isEmptyCursorHooksSkeleton(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const keys = Object.keys(parsed).filter((k) => k !== "version");
    return (
      keys.length === 1 &&
      keys[0] === "hooks" &&
      typeof parsed.hooks === "object" &&
      parsed.hooks !== null &&
      Object.keys(parsed.hooks).length === 0
    );
  } catch {
    return false;
  }
}

export interface JsonStripResult extends JsonMergeResult {
  /** Nothing but harness-born structure is left — the file itself can go. */
  removeFile: boolean;
}

/**
 * Inverse of a json-merge artifact (orphan cleanup in sync, and deinit). The
 * lockfile records no merge strategy, so it is chosen by the adapter that
 * wrote the entries; undefined = unknown strategy (e.g. the origin's
 * claude-code settings hooks) → leave the file alone. opencode.json stays
 * even when reduced to its $schema — the file itself is the platform marker
 * other tools detect; only the cursor hooks skeleton is harness-born.
 */
export function stripHarnessJsonEntries(adapter: string, existingJson: string): JsonStripResult | undefined {
  if (adapter === "cursor") {
    const result = stripCursorHooks(existingJson);
    return { ...result, removeFile: result.error === undefined && result.changed && isEmptyCursorHooksSkeleton(result.content) };
  }
  if (adapter === "opencode") return { ...stripOpencodeInstructions(existingJson), removeFile: false };
  return undefined;
}

/**
 * opencode.json merge: guarantee the harness-generated rules file is listed in
 * the `instructions` array (set semantics), removing stale harness entries.
 */
export function mergeOpencodeInstructions(
  existingJson: string | undefined,
  instructionPath: string,
): JsonMergeResult {
  const parsed = parseObjectRoot(existingJson, "opencode.json");
  if ("failure" in parsed) return parsed.failure;
  const root: Record<string, unknown> =
    "root" in parsed ? parsed.root : { $schema: "https://opencode.ai/config.json" };

  const existing = Array.isArray(root.instructions) ? (root.instructions as unknown[]) : [];
  const kept = existing.filter((e) => !(typeof e === "string" && e.includes(".harness/generated/")));
  root.instructions = [...kept, instructionPath];

  const content = `${JSON.stringify(root, null, 2)}\n`;
  return { content, changed: content !== existingJson };
}
