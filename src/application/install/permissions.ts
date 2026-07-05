// permissions.ts — pure writer that pre-authorizes the leina CLI in a Devin config's
// `permissions.allow` block, so the agent never gets a permission prompt for `leina ...`.
//
// This is the inverse of migrate.ts's stripMcpPermissions (which removes dead MCP grants): here
// we ADD one live grant. Like the migration helpers it is pure (string in, string|null out),
// merge-safe and idempotent: it returns the new file content, or null when there is nothing to
// change (grant already present) or when the existing file is non-null but malformed / shaped in
// a way we refuse to round-trip (never clobbered).

// Devin `Exec(prefix)` scope — matches the leina binary as a whole-word prefix, so it
// covers `leina`, `leina query ...`, `leina memory context ...`, etc. but
// NOT an unrelated binary like `leina-foo`. See Devin permissions reference (Exec scope).
export const CLI_EXEC_GRANT = "Exec(leina)";

// Claude Code SERVER-level MCP grant — "mcp__leina" (no trailing "__") authorizes every
// tool of the leina server in one entry. Deliberately NOT per-tool ("mcp__leina__<tool>"):
// per-tool grants churn on every parity addition AND would match migrate.ts's dead-grant
// strippers (startsWith("mcp__leina__")); the server-level form matches neither stripper.
export const MCP_SERVER_GRANT = "mcp__leina";

// Parse a JSON object, or return null if blank/malformed/non-object. We refuse to touch anything
// we can't safely round-trip. (Mirrors migrate.ts#parseObject — kept local to avoid coupling.)
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
 * Ensure a Devin config's `permissions.allow` array contains the leina CLI grant.
 * Returns the new file content, or null when there is nothing to change.
 *
 *  - absent / blank input → creates a minimal config carrying just the grant
 *  - existing object → appends the grant to `permissions.allow`, creating the bucket as needed,
 *    preserving every other key and grant verbatim
 *  - grant already present → null (idempotent)
 *  - malformed JSON, or a non-object `permissions` / non-array `allow` → null (never clobbered)
 */
export function grantCliExecPermission(existing: string | null): string | null {
  return grantPermission(existing, CLI_EXEC_GRANT);
}

/**
 * Ensure a Claude settings file's `permissions.allow` array contains the server-level
 * MCP grant ("mcp__leina"). Same merge-safe/idempotent/no-clobber contract as
 * `grantCliExecPermission` (both Devin config.json and Claude settings.json share the
 * `permissions.allow` shape).
 */
export function grantMcpPermission(existing: string | null): string | null {
  return grantPermission(existing, MCP_SERVER_GRANT);
}

function grantPermission(existing: string | null, grant: string): string | null {
  // Absent/blank → create a minimal config carrying just the grant.
  if (!existing?.trim()) {
    return `${JSON.stringify({ permissions: { allow: [grant] } }, null, 2)  }\n`;
  }

  const root = parseObject(existing);
  if (root === null) return null; // malformed / non-object → never clobber

  // `permissions` must be a plain object. Missing → create it; present-but-wrong-shaped → bail.
  let perms = root.permissions;
  if (perms === undefined) {
    perms = {};
  } else if (typeof perms !== "object" || perms === null || Array.isArray(perms)) {
    return null;
  }
  const permsObj = perms as Record<string, unknown>;

  // `allow` must be an array. Missing → create it; present-but-not-array → bail.
  let allow = permsObj.allow;
  if (allow === undefined) {
    allow = [];
  } else if (!Array.isArray(allow)) {
    return null;
  }
  const allowArr = allow as unknown[];

  if (allowArr.includes(grant)) return null; // already granted → idempotent no-op

  permsObj.allow = [...allowArr, grant];
  root.permissions = permsObj;
  return `${JSON.stringify(root, null, 2)  }\n`;
}

/**
 * Remove the leina CLI grant from a Devin config's `permissions.allow` array.
 * Inverse of `grantCliExecPermission`. Pure (string|null → string|null), idempotent, no-clobber.
 *
 *  - absent / blank input                → null (nothing to remove)
 *  - grant not present                   → null (idempotent no-op)
 *  - grant present                        → new content with the grant removed; the `allow`
 *                                           array or `permissions` object are pruned only when
 *                                           they would become empty, but other grants are kept
 *  - malformed JSON, or wrong-shaped     → null (never clobbers)
 */
export function revokeCliExecPermission(existing: string | null): string | null {
  return revokePermission(existing, CLI_EXEC_GRANT);
}

/** Remove the server-level MCP grant. Inverse of `grantMcpPermission`. */
export function revokeMcpPermission(existing: string | null): string | null {
  return revokePermission(existing, MCP_SERVER_GRANT);
}

function revokePermission(existing: string | null, grant: string): string | null {
  if (!existing?.trim()) return null; // nothing to revoke from an absent/blank file

  const root = parseObject(existing);
  if (root === null) return null; // malformed / non-object → no-clobber

  const perms = root.permissions;
  if (perms === undefined || typeof perms !== "object" || perms === null || Array.isArray(perms)) {
    return null; // no permissions bucket → nothing to remove (or wrong-shaped → no-clobber)
  }
  const permsObj = perms as Record<string, unknown>;

  const allow = permsObj.allow;
  if (allow === undefined || !Array.isArray(allow)) {
    return null; // no allow array → nothing to remove (or wrong-shaped → no-clobber)
  }
  const allowArr = allow as unknown[];

  if (!allowArr.includes(grant)) return null; // not present → idempotent no-op

  const filtered = allowArr.filter((e) => e !== grant);
  permsObj.allow = filtered;
  root.permissions = permsObj;
  return `${JSON.stringify(root, null, 2)  }\n`;
}
