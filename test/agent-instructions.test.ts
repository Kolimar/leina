// test/agent-instructions.test.ts — Unit tests for AgentInstructionGenerator.
//
// Covers R-2 (profiles), R-3 (Devin golden + Windsurf golden), R-4 (capability format),
// R-6 (idempotence / double-generate), R-8 (no node:fs in agent-instructions.ts source).
//
// Run: node --no-warnings --experimental-strip-types --test test/agent-instructions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEVIN_PROFILE,
  WINDSURF_PROFILE,
  CAP_START,
  CAP_END,
  formatCapabilityLine,
  mergeCapabilitiesSection,
  agentInstructionGenerator,
} from "../src/application/install/agent-instructions.ts";
import { capabilities } from "../src/application/capabilities/registry.ts";
import { assertGolden } from "./helpers/golden.ts";
import type { CommandContract } from "../src/domain/capabilities/model.ts";

// ---------------------------------------------------------------------------
// R-2 — Profile shapes
// ---------------------------------------------------------------------------

test("(ai-R2-1) DEVIN_PROFILE has correct shape", () => {
  assert.equal(DEVIN_PROFILE.id, "devin");
  assert.equal(DEVIN_PROFILE.preferredTransport, "cli");
  assert.equal(DEVIN_PROFILE.fallbackTransport, undefined);
  assert.deepEqual(DEVIN_PROFILE.instructionTargets, ["AGENTS.md"]);
});

test("(ai-R2-2) WINDSURF_PROFILE has correct shape", () => {
  assert.equal(WINDSURF_PROFILE.id, "windsurf");
  assert.equal(WINDSURF_PROFILE.preferredTransport, "cli");
  assert.equal(WINDSURF_PROFILE.fallbackTransport, undefined);
  assert.deepEqual(WINDSURF_PROFILE.instructionTargets, ["AGENTS.md"]);
});

// ---------------------------------------------------------------------------
// R-3 — Devin golden (byte-identical)
// ---------------------------------------------------------------------------

test("(ai-R3-devin) generate(DEVIN_PROFILE, caps) is byte-identical to the golden", () => {
  const result = agentInstructionGenerator.generate(DEVIN_PROFILE, capabilities);
  assert.equal(result.length, 1, "one artifact per target");
  assert.equal(result[0]!.path, "AGENTS.md");
  // assertGolden compares against golden; UPDATE_GOLDENS=1 regenerates it.
  // The Devin golden must NEVER be regenerated after the initial capture (R-9).
  assertGolden("agents-md-devin.txt", result[0]!.content);
});

// ---------------------------------------------------------------------------
// R-3 — Windsurf golden
// ---------------------------------------------------------------------------

test("(ai-R3-windsurf) generate(WINDSURF_PROFILE, caps) matches the Windsurf golden", () => {
  const result = agentInstructionGenerator.generate(WINDSURF_PROFILE, capabilities);
  assert.equal(result.length, 1, "one artifact per target");
  assert.equal(result[0]!.path, "AGENTS.md");
  // UPDATE_GOLDENS=1 creates/updates the Windsurf golden on first run.
  assertGolden("agents-md-windsurf.txt", result[0]!.content);
});

test("(ai-R3-windsurf-caps-present) Windsurf output contains ## Capabilities (leina) section", () => {
  const result = agentInstructionGenerator.generate(WINDSURF_PROFILE, capabilities);
  const content = result[0]!.content;
  assert.ok(content.includes("## Capabilities (leina)"), "capabilities heading present");
  // Expect exactly capabilities.length item lines
  const lines = content.split("\n").filter((l) => l.startsWith("- `"));
  assert.equal(lines.length, capabilities.length, `${capabilities.length} capability lines`);
});

// ---------------------------------------------------------------------------
// R-4 — Capability line format
// ---------------------------------------------------------------------------

test("(ai-R4-format) formatCapabilityLine produces correct format with flags", () => {
  const contract: CommandContract = {
    capability: {
      id: "graph.query",
      description: "Query the graph.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      transports: ["cli"],
      schemaVersion: 1,
      fn: () => undefined,
    },
    cli: {
      command: "query",
      flags: ["--json"],
    },
  };
  const line = formatCapabilityLine(contract);
  assert.equal(
    line,
    "- `graph.query` — leina query [--json]: Query the graph.",
  );
});

test("(ai-R4-no-flags) formatCapabilityLine omits brackets when cli.flags absent", () => {
  const contract: CommandContract = {
    capability: {
      id: "graph.status",
      description: "Graph status.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      transports: ["cli"],
      schemaVersion: 1,
      fn: () => undefined,
    },
    cli: {
      command: "status",
      // flags deliberately absent
    },
  };
  const line = formatCapabilityLine(contract);
  assert.ok(!line.includes("["), "no opening bracket when flags absent");
  assert.ok(!line.includes("]"), "no closing bracket when flags absent");
  assert.equal(line, "- `graph.status` — leina status: Graph status.");
});

test("(ai-R4-empty-flags) formatCapabilityLine omits brackets when cli.flags is empty array", () => {
  const contract: CommandContract = {
    capability: {
      id: "x.cmd",
      description: "Desc.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      transports: ["cli"],
      schemaVersion: 1,
      fn: () => undefined,
    },
    cli: {
      command: "x",
      flags: [],
    },
  };
  const line = formatCapabilityLine(contract);
  assert.ok(!line.includes("["), "no bracket for empty flags array");
});

test("(ai-R4-multi-flags) formatCapabilityLine joins multiple flags with space", () => {
  const contract: CommandContract = {
    capability: {
      id: "memory.add",
      description: "Save memory.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      transports: ["cli"],
      schemaVersion: 1,
      fn: () => undefined,
    },
    cli: {
      command: "memory save",
      flags: ["--title", "--content", "--type"],
    },
  };
  const line = formatCapabilityLine(contract);
  assert.ok(line.includes("[--title --content --type]"), "flags joined with space");
});

test("(ai-R4-devin-no-caps) Devin generate does NOT include capabilities section", () => {
  const result = agentInstructionGenerator.generate(DEVIN_PROFILE, capabilities);
  const content = result[0]!.content;
  assert.ok(!content.includes("## Capabilities"), "Devin output has no capabilities section");
  assert.ok(!content.includes(CAP_START), "Devin output has no CAP_START marker");
});

// ---------------------------------------------------------------------------
// R-6 — Idempotence: double generate produces byte-identical results
// ---------------------------------------------------------------------------

test("(ai-R6-idem-devin) double generate(DEVIN_PROFILE, caps) is byte-identical", () => {
  const a = agentInstructionGenerator.generate(DEVIN_PROFILE, capabilities);
  const b = agentInstructionGenerator.generate(DEVIN_PROFILE, capabilities);
  assert.equal(a[0]!.content, b[0]!.content, "Devin: two generates produce identical output");
});

test("(ai-R6-idem-windsurf) double generate(WINDSURF_PROFILE, caps) is byte-identical", () => {
  const a = agentInstructionGenerator.generate(WINDSURF_PROFILE, capabilities);
  const b = agentInstructionGenerator.generate(WINDSURF_PROFILE, capabilities);
  assert.equal(a[0]!.content, b[0]!.content, "Windsurf: two generates produce identical output");
});

// ---------------------------------------------------------------------------
// mergeCapabilitiesSection — marker logic (mirrors mergeAgentsMd semantics)
// ---------------------------------------------------------------------------

test("(ai-merge-caps-append) mergeCapabilitiesSection appends when no markers present", () => {
  const base = "# AGENTS.md\n\nSome content.\n";
  const result = mergeCapabilitiesSection(base, capabilities);
  assert.ok(result.includes(CAP_START), "CAP_START present");
  assert.ok(result.includes(CAP_END), "CAP_END present");
  assert.ok(result.startsWith("# AGENTS.md"), "original content preserved");
});

test("(ai-merge-caps-replace) mergeCapabilitiesSection replaces section in-place on second call", () => {
  const base = "# AGENTS.md\n\nContent.\n";
  const first  = mergeCapabilitiesSection(base, capabilities);
  const second = mergeCapabilitiesSection(first, capabilities);
  assert.equal(first, second, "idempotent: second merge is byte-identical to first");
  // Only one pair of markers
  assert.equal(second.split(CAP_START).length - 1, 1, "exactly one CAP_START");
  assert.equal(second.split(CAP_END).length - 1,   1, "exactly one CAP_END");
});

test("(ai-merge-caps-throw) mergeCapabilitiesSection throws on malformed markers", () => {
  const malformed = `# AGENTS.md\n\n${CAP_START}\nmissing end\n`;
  assert.throws(
    () => mergeCapabilitiesSection(malformed, capabilities),
    /malformed|capabilities section/i,
  );
});

// ---------------------------------------------------------------------------
// R-8 — Purity: agent-instructions.ts MUST NOT import node:fs
// ---------------------------------------------------------------------------

test("(ai-R8-no-node-fs) agent-instructions.ts does not import node:fs", () => {
  const src = fileURLToPath(
    new URL("../src/application/install/agent-instructions.ts", import.meta.url),
  );
  const content = readFileSync(src, "utf8");

  // Strip single-line comments first to avoid false positives in comment text.
  const noComments = content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  // Must not have a node:fs import (static or dynamic) in actual code lines.
  assert.ok(
    !/from\s+["']node:fs["']/.test(noComments),
    "no static node:fs import in agent-instructions.ts",
  );
  assert.ok(
    !/import\s*\(["']node:fs["']\)/.test(noComments),
    "no dynamic node:fs import in agent-instructions.ts",
  );
});

test("(ai-R8-pure-double-generate) generate is pure: same args always yield same result", () => {
  const caps1 = capabilities.slice(0, 3);
  const a = agentInstructionGenerator.generate(WINDSURF_PROFILE, caps1);
  const b = agentInstructionGenerator.generate(WINDSURF_PROFILE, caps1);
  assert.equal(a[0]!.content, b[0]!.content, "pure function: same (profile, caps) → same output");
});
