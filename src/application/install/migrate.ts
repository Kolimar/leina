// migrate.ts — clean up artifacts left by the pre-CLI-only (MCP) installs.
//
// leina used to register an MCP server in the host config and a project in a global
// registry. The package is now CLI-only: there is no server to launch and no registry to read.
// These pure helpers strip the dead MCP/registry traces from on-disk config so a re-`init`
// (or `doctor`) leaves a clean, CLI-only footprint. Every helper is merge-safe and idempotent
// and returns `null` when there is nothing to change, so the caller never rewrites a file
// needlessly (and never clobbers a file it could not parse — malformed JSON is left untouched).

const SERVER_KEY = "leina";

// Parse a JSON object, or return null if absent/blank/malformed/non-object. We refuse to touch
// anything we can't safely round-trip.
function parseObject(existing: string | null | undefined): Record<string, unknown> | null {
  if (!existing?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(existing);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Remove our MCP server entry from a host config's `mcpServers` map (e.g. `.devin/config.json`
 * or `~/.config/devin/config.json`). Drops the `mcpServers` key entirely when it becomes empty.
 * Returns the new file content, or null when there was nothing to strip (so the caller skips
 * the write).
 */
export function stripMcpServer(existing: string | null): string | null {
  const root = parseObject(existing);
  if (root === null) return null;
  const servers = root.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return null;
  const map = servers as Record<string, unknown>;
  if (!(SERVER_KEY in map)) return null;
  delete map[SERVER_KEY];
  if (Object.keys(map).length === 0) {
    delete root.mcpServers;
  } else {
    root.mcpServers = map;
  }
  return `${JSON.stringify(root, null, 2)  }\n`;
}

// Matchers from the MCP era that no longer correspond to any tool the CLI-only build emits.
// The PostToolUse marker used to fire on `mcp__leina__(mem_context|...)`; with no MCP
// tools, that matcher is dead and must be stripped from existing hook files.
const DEAD_MATCHER_RE = /^\^?mcp__leina__/;

function isDeadMatcher(m: unknown): boolean {
  return (
    typeof m === "object" &&
    m !== null &&
    typeof (m as { matcher?: unknown }).matcher === "string" &&
    DEAD_MATCHER_RE.test((m as { matcher: string }).matcher)
  );
}

/**
 * Strip dead MCP-era hook matchers from a Devin hooks structure (either a `.devin/hooks.v1.json`
 * root, or the `hooks` sub-object of `~/.config/devin/config.json`). Walks every event array and
 * drops entries whose matcher targets an `mcp__leina__*` tool. Returns the mutated object
 * (same reference) — callers decide whether anything changed by comparing serialized output.
 */
export function stripDeadHookMatchers(hooks: Record<string, unknown>): { hooks: Record<string, unknown>; changed: boolean } {
  let changed = false;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const kept = value.filter((entry) => {
      if (isDeadMatcher(entry)) {
        changed = true;
        return false;
      }
      return true;
    });
    if (kept.length !== value.length) hooks[event] = kept;
  }
  return { hooks, changed };
}

/**
 * Apply dead-matcher stripping to a `.devin/hooks.v1.json` file's raw contents. Returns the new
 * content, or null when there is nothing to strip / the file is absent or malformed.
 */
export function stripDeadHooksFromFile(existing: string | null): string | null {
  const root = parseObject(existing);
  if (root === null) return null;
  const { changed } = stripDeadHookMatchers(root);
  return changed ? `${JSON.stringify(root, null, 2)  }\n` : null;
}

// Permission grants from the MCP era — pre-authorized tool patterns like `mcp__leina__*`
// or `mcp__leina__mem_save`. With no MCP tools these are dead and should be pruned from a
// Devin config's `permissions.{allow,deny,ask}` arrays.

/**
 * Strip dead `mcp__leina__*` permission grants from a Devin config's `permissions` block
 * (the `allow` / `deny` / `ask` arrays). Empty arrays are dropped, and an emptied `permissions`
 * object is removed entirely. Returns the new file content, or null when there is nothing to
 * strip (so the caller skips the write) / the file is absent or malformed.
 */
export function stripMcpPermissions(existing: string | null): string | null {
  const root = parseObject(existing);
  if (root === null) return null;
  const perms = root.permissions;
  if (typeof perms !== "object" || perms === null || Array.isArray(perms)) return null;
  const permsObj = perms as Record<string, unknown>;
  let changed = false;
  for (const bucket of ["allow", "deny", "ask"]) {
    const arr = permsObj[bucket];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((e) => !(typeof e === "string" && e.startsWith("mcp__leina__")));
    if (kept.length !== arr.length) {
      changed = true;
      if (kept.length === 0) delete permsObj[bucket];
      else permsObj[bucket] = kept;
    }
  }
  if (!changed) return null;
  if (Object.keys(permsObj).length === 0) delete root.permissions;
  else root.permissions = permsObj;
  return `${JSON.stringify(root, null, 2)  }\n`;
}
