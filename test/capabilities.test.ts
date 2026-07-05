// capabilities.test.ts — covers REQ-CR-1/2/4/5, REQ-OS-3, REQ-NF-5
//
// Split into two parts:
//   1. Unit tests against the registry module (in-process).
//   2. CLI integration tests via spawnSync.
//
// Run: node --no-warnings --experimental-strip-types --test test/capabilities.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { capabilities } from "../src/application/capabilities/registry.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8" },
  );
}

// ---------------------------------------------------------------------------
// Unit — registry module (REQ-CR-1/2/4, REQ-OS-3, REQ-NF-5)
// ---------------------------------------------------------------------------

test("(cap-1) registry has exactly 17 capabilities with unique IDs", () => {
  assert.equal(capabilities.length, 17, "must have exactly 17 entries");
  const ids = capabilities.map((cc) => cc.capability.id);
  const unique = new Set(ids);
  assert.equal(unique.size, 17, "all IDs must be distinct");
});

test("(cap-2) canonical IDs are present", () => {
  const ids = new Set(capabilities.map((cc) => cc.capability.id));
  const expected = [
    "graph.query",
    "graph.status",
    "memory.add",
    "memory.search",
    "memory.update",
    "memory.suggestTopic",
    "memory.session",
    "context.build",
    "audit.run",
  ];
  for (const id of expected) {
    assert.ok(ids.has(id), `capability '${id}' must be in registry`);
  }
});

// memory.add / memory.get moved to v2 when they grew the batch form (items[] / ids[]).
const SCHEMA_V2 = new Set(["memory.add", "memory.get"]);

test("(cap-3) each capability has the expected schemaVersion", () => {
  for (const cc of capabilities) {
    const expected = SCHEMA_V2.has(cc.capability.id) ? 2 : 1;
    assert.equal(
      cc.capability.schemaVersion,
      expected,
      `${cc.capability.id} must have schemaVersion ${expected}`,
    );
  }
});

test("(cap-4) each capability has non-empty transports", () => {
  for (const cc of capabilities) {
    assert.ok(
      Array.isArray(cc.capability.transports) && cc.capability.transports.length > 0,
      `${cc.capability.id} must have at least one transport`,
    );
  }
});

test("(cap-5) each capability has a non-null fn reference", () => {
  for (const cc of capabilities) {
    assert.ok(
      typeof cc.capability.fn === "function",
      `${cc.capability.id} must have a function fn`,
    );
  }
});

test("(cap-6) all capabilities have inputSchema and outputSchema", () => {
  for (const cc of capabilities) {
    assert.ok(cc.capability.inputSchema, `${cc.capability.id} must have inputSchema`);
    assert.ok(cc.capability.outputSchema, `${cc.capability.id} must have outputSchema`);
  }
});

test("(cap-7) registry import is idempotent (same reference each import)", async () => {
  // Re-import the module and compare references (ESM caches modules)
  const { capabilities: caps2 } = await import("../src/application/capabilities/registry.ts");
  assert.strictEqual(
    capabilities,
    caps2,
    "registry must return the same array reference on repeated import",
  );
});

// ---------------------------------------------------------------------------
// CLI integration — `capabilities list --json` (REQ-CR-5)
// ---------------------------------------------------------------------------

test("(cap-cli-1) capabilities list --json: 17 objects, no fn, exit 0", () => {
  const res = runCli("capabilities", "list", "--json");
  assert.equal(res.status, 0, `expected exit 0; got ${res.status}\nstderr: ${res.stderr}`);

  let parsed: unknown;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(res.stdout);
  }, "stdout must be valid JSON");

  assert.ok(Array.isArray(parsed), "stdout must be a JSON array");
  const arr = parsed as Record<string, unknown>[];
  assert.equal(arr.length, 17, "array must have 17 elements");

  for (const item of arr) {
    assert.ok("id" in item, "each item must have id");
    assert.ok("description" in item, "each item must have description");
    assert.ok("inputSchema" in item, "each item must have inputSchema");
    assert.ok("outputSchema" in item, "each item must have outputSchema");
    assert.ok("transports" in item, "each item must have transports");
    assert.ok("schemaVersion" in item, "each item must have schemaVersion");
    assert.ok(!("fn" in item), `item '${item.id}' must NOT have fn field`);
  }
});

test("(cap-cli-2) capabilities list (human): contains IDs, does not start with [, exit 0", () => {
  const res = runCli("capabilities", "list");
  assert.equal(res.status, 0, `expected exit 0; stderr: ${res.stderr}`);
  assert.ok(!res.stdout.startsWith("["), "human output must not start with [");

  const ids = [
    "graph.query",
    "graph.status",
    "memory.add",
    "memory.search",
    "context.build",
    "audit.run",
  ];
  for (const id of ids) {
    assert.ok(res.stdout.includes(id), `human output must contain '${id}'`);
  }
});

test("(cap-cli-3) capabilities list --json: expected schemaVersion on all entries", () => {
  const res = runCli("capabilities", "list", "--json");
  const arr = JSON.parse(res.stdout) as { id: string; schemaVersion: number }[];
  for (const item of arr) {
    const expected = SCHEMA_V2.has(item.id) ? 2 : 1;
    assert.equal(item.schemaVersion, expected, `${item.id}: schemaVersion must be ${expected}, got ${item.schemaVersion}`);
  }
});
