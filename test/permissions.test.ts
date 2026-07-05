// Unit tests for the CLI pre-authorization writer (src/install/permissions.ts). It adds the
// `Exec(leina)` grant to a Devin project config's `permissions.allow` so the agent never
// gets a permission prompt for `leina ...`. Pure (string in, string|null out), merge-safe
// and idempotent — the inverse of migrate.ts#stripMcpPermissions.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  grantCliExecPermission,
  revokeCliExecPermission,
  grantMcpPermission,
  revokeMcpPermission,
  CLI_EXEC_GRANT,
  MCP_SERVER_GRANT,
} from "../src/application/install/permissions.ts";

test("(perm-grant-a) absent/blank input creates a minimal config carrying just the grant", () => {
  for (const empty of [null, "", "   "]) {
    const out = grantCliExecPermission(empty);
    assert.ok(out !== null, "should create a file");
    assert.deepEqual(JSON.parse(out), { permissions: { allow: [CLI_EXEC_GRANT] } });
  }
});

test("(perm-grant-b) appends to an existing allow array, preserving every other key/grant", () => {
  const input = JSON.stringify({
    version: 1,
    permissions: { allow: ["Exec(git)"], deny: ["Exec(rm)"] },
    mcpServers: { other: { command: "x" } },
  });
  const parsed = JSON.parse(grantCliExecPermission(input)!);
  assert.deepEqual(parsed.permissions.allow, ["Exec(git)", CLI_EXEC_GRANT], "grant appended, order preserved");
  assert.deepEqual(parsed.permissions.deny, ["Exec(rm)"], "unrelated buckets preserved");
  assert.equal(parsed.version, 1, "unrelated top-level keys preserved");
  assert.deepEqual(parsed.mcpServers.other, { command: "x" });
});

test("(perm-grant-c) creates the permissions/allow buckets when missing", () => {
  const fromBare = JSON.parse(grantCliExecPermission(JSON.stringify({ version: 2 }))!);
  assert.deepEqual(fromBare.permissions.allow, [CLI_EXEC_GRANT]);
  assert.equal(fromBare.version, 2);

  const fromEmptyPerms = JSON.parse(grantCliExecPermission(JSON.stringify({ permissions: {} }))!);
  assert.deepEqual(fromEmptyPerms.permissions.allow, [CLI_EXEC_GRANT]);
});

test("(perm-grant-d) idempotent — null when the grant is already present", () => {
  const input = JSON.stringify({ permissions: { allow: [CLI_EXEC_GRANT, "Exec(git)"] } });
  assert.equal(grantCliExecPermission(input), null);
});

test("(perm-grant-e) never clobbers malformed JSON or wrong-shaped permissions/allow", () => {
  assert.equal(grantCliExecPermission("not json {"), null, "malformed → null");
  assert.equal(grantCliExecPermission("[1,2,3]"), null, "non-object root → null");
  assert.equal(grantCliExecPermission('{"permissions":"nope"}'), null, "non-object permissions → null");
  assert.equal(grantCliExecPermission('{"permissions":{"allow":"nope"}}'), null, "non-array allow → null");
});

// ---------- revokeCliExecPermission (inverse) ----------

test("(perm-revoke-a) absent/blank/null input → null (nothing to revoke)", () => {
  for (const empty of [null, "", "   "]) {
    assert.equal(revokeCliExecPermission(empty), null);
  }
});

test("(perm-revoke-b) removes the grant when present, preserving other grants and keys", () => {
  const input = JSON.stringify({
    version: 1,
    permissions: { allow: ["Exec(git)", CLI_EXEC_GRANT, "Exec(npm)"], deny: ["Exec(rm)"] },
    mcpServers: { other: { command: "x" } },
  });
  const out = revokeCliExecPermission(input)!;
  assert.ok(out !== null, "returns non-null when grant was present");
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.permissions.allow, ["Exec(git)", "Exec(npm)"], "CLI grant removed, others kept");
  assert.deepEqual(parsed.permissions.deny, ["Exec(rm)"], "deny bucket untouched");
  assert.equal(parsed.version, 1, "unrelated top-level keys preserved");
});

test("(perm-revoke-c) idempotent — null when grant is already absent", () => {
  const input = JSON.stringify({ permissions: { allow: ["Exec(git)"] } });
  assert.equal(revokeCliExecPermission(input), null, "grant absent → null");
});

test("(perm-revoke-d) no-clobber on malformed or wrong-shaped input", () => {
  assert.equal(revokeCliExecPermission("not json {"), null, "malformed → null");
  assert.equal(revokeCliExecPermission("[1,2,3]"), null, "non-object root → null");
  assert.equal(revokeCliExecPermission('{"permissions":"nope"}'), null, "non-object permissions → null");
  assert.equal(revokeCliExecPermission('{"permissions":{"allow":"nope"}}'), null, "non-array allow → null");
});

test("(perm-revoke-e) round-trip: grant then revoke yields no grant remaining", () => {
  const base = JSON.stringify({ permissions: { allow: ["Exec(git)"] } });
  const granted = grantCliExecPermission(base)!;
  assert.ok(granted !== null, "grant succeeded");
  assert.ok(JSON.parse(granted).permissions.allow.includes(CLI_EXEC_GRANT), "grant present after grant()");
  const revoked = revokeCliExecPermission(granted)!;
  assert.ok(revoked !== null, "revoke returned new content");
  const parsed = JSON.parse(revoked);
  assert.ok(!parsed.permissions.allow.includes(CLI_EXEC_GRANT), "grant absent after revoke()");
  assert.deepEqual(parsed.permissions.allow, ["Exec(git)"], "other grants preserved");
});

test("(perm-revoke-f) no permissions bucket → null (nothing to remove)", () => {
  const input = JSON.stringify({ version: 1 });
  assert.equal(revokeCliExecPermission(input), null);
});

test("(perm-revoke-g) no allow array → null (nothing to remove)", () => {
  const input = JSON.stringify({ permissions: { deny: ["Exec(rm)"] } });
  assert.equal(revokeCliExecPermission(input), null);
});


// ---- MCP server-level grant ("mcp__leina") ---------------------------------

test("(perm-mcp-a) grantMcpPermission mirrors the CLI grant contract with the server-level entry", () => {
  const fresh = grantMcpPermission(null)!;
  assert.deepEqual(JSON.parse(fresh), { permissions: { allow: [MCP_SERVER_GRANT] } });

  const appended = grantMcpPermission(JSON.stringify({ permissions: { allow: ["Exec(git)"] }, custom: 1 }))!;
  const parsed = JSON.parse(appended);
  assert.deepEqual(parsed.permissions.allow, ["Exec(git)", MCP_SERVER_GRANT]);
  assert.equal(parsed.custom, 1, "unknown keys preserved");

  assert.equal(grantMcpPermission(appended), null, "idempotent");
  assert.equal(grantMcpPermission("{ not json"), null, "no-clobber");
});

test("(perm-mcp-b) revokeMcpPermission removes only the server-level grant", () => {
  const granted = grantMcpPermission(JSON.stringify({ permissions: { allow: ["Exec(git)"] } }))!;
  const revoked = revokeMcpPermission(granted)!;
  assert.deepEqual(JSON.parse(revoked).permissions.allow, ["Exec(git)"]);
  assert.equal(revokeMcpPermission(revoked), null, "idempotent");
  assert.equal(revokeMcpPermission(null), null);
});

test("(perm-mcp-c) grant is server-level: no trailing __, immune to the dead-grant strippers", () => {
  assert.equal(MCP_SERVER_GRANT, "mcp__leina");
  assert.ok(!MCP_SERVER_GRANT.startsWith("mcp__leina__"), "must NOT match migrate.ts's startsWith(\"mcp__leina__\")");
});
