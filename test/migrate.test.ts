// Unit tests for the MCP→CLI migration helpers (src/install/migrate.ts). These strip dead MCP
// traces from on-disk Devin config so a re-`init` leaves a clean CLI-only footprint. All helpers
// are pure (string in, string|null out) and must be idempotent + merge-safe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMcpServer, stripDeadHooksFromFile, stripMcpPermissions } from "../src/application/install/migrate.ts";

// ---- stripMcpServer --------------------------------------------------------

test("(mig-server-a) removes the leina mcpServers entry, preserves others", () => {
  const input = JSON.stringify({
    mcpServers: { "leina": { command: "old", args: ["serve"] }, other: { command: "keep" } },
    extra: true,
  });
  const out = stripMcpServer(input);
  assert.ok(out !== null, "should report a change");
  const parsed = JSON.parse(out);
  assert.equal("leina" in parsed.mcpServers, false);
  assert.deepEqual(parsed.mcpServers.other, { command: "keep" });
  assert.equal(parsed.extra, true);
});

test("(mig-server-b) drops the mcpServers key entirely when it becomes empty", () => {
  const input = JSON.stringify({ mcpServers: { "leina": { command: "x", args: [] } }, version: 1 });
  const parsed = JSON.parse(stripMcpServer(input)!);
  assert.equal("mcpServers" in parsed, false);
  assert.equal(parsed.version, 1);
});

test("(mig-server-c) null when nothing to strip / absent / malformed", () => {
  assert.equal(stripMcpServer(null), null);
  assert.equal(stripMcpServer('{"mcpServers":{"other":{}}}'), null);
  assert.equal(stripMcpServer("not json {"), null, "malformed → null (never clobber)");
});

// ---- stripMcpPermissions ---------------------------------------------------

test("(mig-perm-a) removes dead mcp__leina__* allow grants", () => {
  const input = JSON.stringify({ version: 1, permissions: { allow: ["mcp__leina__*"] } });
  const parsed = JSON.parse(stripMcpPermissions(input)!);
  assert.equal("permissions" in parsed, false, "emptied permissions object is removed");
  assert.equal(parsed.version, 1);
});

test("(mig-perm-b) preserves unrelated permission grants across allow/deny/ask", () => {
  const input = JSON.stringify({
    permissions: {
      allow: ["mcp__leina__mem_save", "exec(ls:*)"],
      deny: ["mcp__leina__graph_refresh"],
      ask: ["read"],
    },
  });
  const parsed = JSON.parse(stripMcpPermissions(input)!);
  assert.deepEqual(parsed.permissions.allow, ["exec(ls:*)"]);
  assert.equal("deny" in parsed.permissions, false, "emptied deny array dropped");
  assert.deepEqual(parsed.permissions.ask, ["read"]);
});

test("(mig-perm-c) null when no dead grants / absent / malformed", () => {
  assert.equal(stripMcpPermissions(null), null);
  assert.equal(stripMcpPermissions('{"permissions":{"allow":["read"]}}'), null);
  assert.equal(stripMcpPermissions('{"version":1}'), null);
  assert.equal(stripMcpPermissions("not json {"), null);
});

// ---- stripDeadHooksFromFile ------------------------------------------------

test("(mig-hooks-a) strips legacy mcp__leina__ PostToolUse matcher, keeps the rest", () => {
  const input = JSON.stringify({
    PostToolUse: [
      { matcher: "^(edit|write)$", hooks: [{ type: "command", command: "x" }] },
      { matcher: "^mcp__leina__(mem_context|mem_search|get_verified_context)$", hooks: [] },
    ],
    PreToolUse: [{ matcher: "^(edit|write|exec)$", hooks: [] }],
  });
  const parsed = JSON.parse(stripDeadHooksFromFile(input)!);
  const matchers = parsed.PostToolUse.map((m: { matcher: string }) => m.matcher);
  assert.deepEqual(matchers, ["^(edit|write)$"], "dead mcp matcher removed, edit/write kept");
  assert.equal(parsed.PreToolUse.length, 1, "other events untouched");
});

test("(mig-hooks-b) null when there are no dead matchers / absent / malformed", () => {
  assert.equal(stripDeadHooksFromFile(null), null);
  assert.equal(stripDeadHooksFromFile('{"PostToolUse":[{"matcher":"^exec$","hooks":[]}]}'), null);
  assert.equal(stripDeadHooksFromFile("not json {"), null);
});

// ---- regression: the live server-level grant must survive the strippers ----

test("(mig-perm-d) server-level grant \"mcp__leina\" is NOT a dead grant — strippers leave it intact", () => {
  // stripMcpPermissions removes startsWith("mcp__leina__") entries; the live server-level
  // grant has no trailing "__" and must never be stripped.
  const input = JSON.stringify({ permissions: { allow: ["mcp__leina", "Exec(leina)"] } });
  assert.equal(stripMcpPermissions(input), null, "nothing to strip — grant preserved");

  // Mixed: dead per-tool grants go, the server-level grant stays.
  const mixed = JSON.stringify({ permissions: { allow: ["mcp__leina", "mcp__leina__graph_query"] } });
  const out = stripMcpPermissions(mixed);
  assert.ok(out !== null, "dead per-tool grant stripped");
  assert.deepEqual(JSON.parse(out).permissions.allow, ["mcp__leina"], "server-level grant survives");
});
