// Cross-file call-resolution tests for the ts-morph semantic extractor.
// Covers 5 import styles (named, aliased, default, re-export chain, namespace)
// and one regression sentinel.
//
// Run standalone: node --no-warnings --experimental-strip-types --test test/tsmorph.test.ts
// Also picked up by: npm test (glob test/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractTsProject } from "../src/infrastructure/extractors/semantic/tsmorph.ts";
import type { GraphEdge } from "../src/domain/graph/model.ts";

// ---------------------------------------------------------------------------
// Shared extraction — run once at module scope, shared across all test cases.
// ---------------------------------------------------------------------------

const fixtureDir = join(import.meta.dirname, "fixtures", "tsmorph-crossfile");

const { edges } = extractTsProject(fixtureDir, [
  join(fixtureDir, "callee.ts"),
  join(fixtureDir, "reexport.ts"),
  join(fixtureDir, "caller.ts"),
  join(fixtureDir, "top-level-caller.ts"),
]);

// ---------------------------------------------------------------------------
// Expected node IDs (makeId normalises path + name → lowercase + underscores)
//   makeId("callee.ts", "target")        → "callee_ts:target"
//   makeId("callee.ts", "defaultTarget") → "callee_ts:defaulttarget"
//   makeId("caller.ts", "caller")        → "caller_ts:caller"
// ---------------------------------------------------------------------------

const CALLER = "caller_ts:caller";
const TARGET = "callee_ts:target";
const DEFAULT_TARGET = "callee_ts:defaulttarget";

/** True when a EXTRACTED calls edge from src→tgt exists at the given source line. */
function hasCallsEdge(src: string, tgt: string, loc: string): boolean {
  return edges.some(
    (e: GraphEdge) =>
      e.relation === "calls" &&
      e.source === src &&
      e.target === tgt &&
      e.sourceLocation === loc &&
      e.confidence === "EXTRACTED",
  );
}

function callsEdgesInfo(): string {
  return JSON.stringify(
    edges.filter((e: GraphEdge) => e.relation === "calls"),
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// xfile-named: import { target } from "./callee"; then target() at L8
test("(xfile-named) named import target() → callee.ts:target EXTRACTED", () => {
  assert.ok(
    hasCallsEdge(CALLER, TARGET, "L8"),
    `Missing calls edge ${CALLER} → ${TARGET} @L8\nAll calls edges:\n${callsEdgesInfo()}`,
  );
});

// xfile-aliased: import { target as aliased }; then aliased() at L9
test("(xfile-aliased) aliased import aliased() → callee.ts:target EXTRACTED", () => {
  assert.ok(
    hasCallsEdge(CALLER, TARGET, "L9"),
    `Missing calls edge ${CALLER} → ${TARGET} @L9\nAll calls edges:\n${callsEdgesInfo()}`,
  );
});

// xfile-default: import defaultTarget from "./callee"; then defaultTarget() at L10
test("(xfile-default) default import defaultTarget() → callee.ts:defaultTarget EXTRACTED", () => {
  assert.ok(
    hasCallsEdge(CALLER, DEFAULT_TARGET, "L10"),
    `Missing calls edge ${CALLER} → ${DEFAULT_TARGET} @L10\nAll calls edges:\n${callsEdgesInfo()}`,
  );
});

// xfile-reexport: import { target as reTarget } from "./reexport"; then reTarget() at L11
// The re-export chain must be followed transitively: reexport.ts → callee.ts
test("(xfile-reexport) re-export chain reTarget() → callee.ts:target EXTRACTED", () => {
  assert.ok(
    hasCallsEdge(CALLER, TARGET, "L11"),
    `Missing calls edge ${CALLER} → ${TARGET} @L11\nAll calls edges:\n${callsEdgesInfo()}`,
  );
});

// xfile-namespace: import * as ns; then ns.target() at L12 — control, passes pre-fix
test("(xfile-namespace) namespace ns.target() → callee.ts:target EXTRACTED [control]", () => {
  assert.ok(
    hasCallsEdge(CALLER, TARGET, "L12"),
    `Missing calls edge ${CALLER} → ${TARGET} @L12\nAll calls edges:\n${callsEdgesInfo()}`,
  );
});

// xfile-toplevel: module-scope callsite (not inside any function declaration).
// Pre-fix: enclosingId can't find a registered ancestor → edge dropped.
// Post-fix: the SourceFile module node is registered → edge attributed to module.
const TOPLEVEL_MODULE = "top_level_caller_ts";
test("(xfile-toplevel) module-scope target() → callee.ts:target EXTRACTED", () => {
  assert.ok(
    hasCallsEdge(TOPLEVEL_MODULE, TARGET, "L9"),
    `Missing module-scope calls edge ${TOPLEVEL_MODULE} → ${TARGET} @L9\nAll calls edges:\n${callsEdgesInfo()}`,
  );
});

// xfile-regression: sentinel — asserts that ≥2 cross-file EXTRACTED calls edges exist.
// Pre-fix: only the namespace case (L12) emits an edge → count = 1 → FAILS.
// Post-fix: named + aliased + default + reexport + namespace all emit → count = 5 → PASSES.
test("(xfile-regression) ≥2 cross-file EXTRACTED calls edges exist", () => {
  const crossFileEdges = edges.filter(
    (e: GraphEdge) =>
      e.relation === "calls" &&
      e.confidence === "EXTRACTED" &&
      e.source.startsWith("caller_ts:") &&
      e.target.startsWith("callee_ts:"),
  );
  assert.ok(
    crossFileEdges.length >= 2,
    `Expected ≥2 cross-file EXTRACTED calls edges from caller_ts → callee_ts; ` +
      `got ${crossFileEdges.length}.\nAll calls edges:\n${callsEdgesInfo()}`,
  );
});
