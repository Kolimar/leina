// schema-validation.test.ts — covers REQ-OS-1/2
//
// Tests the validateAgainstSchema helper against the 6 output schemas.
// No external test framework; no Zod/AJV. Pure unit tests.
//
// Run: node --no-warnings --experimental-strip-types --test test/schema-validation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAgainstSchema,
  graphQueryOutputSchema,
  graphStatusOutputSchema,
  memoryAddOutputSchema,
  memorySearchOutputSchema,
  contextBuildOutputSchema,
  auditRunOutputSchema,
} from "../src/domain/contracts/schemas.ts";

// ---------------------------------------------------------------------------
// validateAgainstSchema — basic contract
// ---------------------------------------------------------------------------

test("(sv-1) valid object with required fields → valid:true, errors:[]", () => {
  const result = validateAgainstSchema(
    { seeds: [], nodes: [], edges: [] },
    graphQueryOutputSchema,
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("(sv-2) object missing required fields → valid:false, errors name missing keys", () => {
  const result = validateAgainstSchema({ seeds: [] }, graphQueryOutputSchema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("nodes"), `errors must include 'nodes'; got ${JSON.stringify(result.errors)}`);
  assert.ok(result.errors.includes("edges"), `errors must include 'edges'; got ${JSON.stringify(result.errors)}`);
});

test("(sv-3) array schema with empty array → valid:true", () => {
  const result = validateAgainstSchema([], memorySearchOutputSchema);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("(sv-4) array schema with non-array → valid:false", () => {
  const result = validateAgainstSchema({ notAnArray: true }, memorySearchOutputSchema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("(sv-5) null fails object schema", () => {
  const result = validateAgainstSchema(null, graphQueryOutputSchema);
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// graph.query output schema (REQ-OS-1: seeds, nodes, edges)
// ---------------------------------------------------------------------------

test("(sv-graph-query-1) happy path: { seeds:[], nodes:[], edges:[] } validates", () => {
  const { valid, errors } = validateAgainstSchema(
    { seeds: [], nodes: [], edges: [] },
    graphQueryOutputSchema,
  );
  assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("(sv-graph-query-2) missing edges → errors includes 'edges'", () => {
  const { valid, errors } = validateAgainstSchema(
    { seeds: [], nodes: [] },
    graphQueryOutputSchema,
  );
  assert.equal(valid, false);
  assert.ok(errors.includes("edges"));
});

// ---------------------------------------------------------------------------
// graph.status output schema (stale, reason)
// ---------------------------------------------------------------------------

test("(sv-graph-status-1) happy path: { stale:false, reason:'fresh' } validates", () => {
  const { valid, errors } = validateAgainstSchema(
    { stale: false, reason: "fresh" },
    graphStatusOutputSchema,
  );
  assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("(sv-graph-status-2) missing reason → errors includes 'reason'", () => {
  const { valid, errors } = validateAgainstSchema(
    { stale: false },
    graphStatusOutputSchema,
  );
  assert.equal(valid, false);
  assert.ok(errors.includes("reason"));
});

// ---------------------------------------------------------------------------
// memory.add output schema (observation, evolved)
// ---------------------------------------------------------------------------

test("(sv-memory-add-1) happy path: { observation:{}, evolved:false } validates", () => {
  const { valid, errors } = validateAgainstSchema(
    { observation: {}, evolved: false },
    memoryAddOutputSchema,
  );
  assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("(sv-memory-add-2) missing observation → errors includes 'observation'", () => {
  const { valid, errors } = validateAgainstSchema(
    { evolved: false },
    memoryAddOutputSchema,
  );
  assert.equal(valid, false);
  assert.ok(errors.includes("observation"));
});

// ---------------------------------------------------------------------------
// memory.search output schema (array)
// ---------------------------------------------------------------------------

test("(sv-memory-search-1) empty array is valid", () => {
  const { valid } = validateAgainstSchema([], memorySearchOutputSchema);
  assert.equal(valid, true);
});

test("(sv-memory-search-2) array with items is valid", () => {
  const { valid } = validateAgainstSchema(
    [{ id: "1", title: "t", score: 0.9 }],
    memorySearchOutputSchema,
  );
  assert.equal(valid, true);
});

// ---------------------------------------------------------------------------
// context.build output schema (text, delivered)
// ---------------------------------------------------------------------------

test("(sv-context-build-1) happy path: { text:'...', delivered:true } validates", () => {
  const { valid, errors } = validateAgainstSchema(
    { text: "some context", delivered: true },
    contextBuildOutputSchema,
  );
  assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("(sv-context-build-2) missing delivered → errors includes 'delivered'", () => {
  const { valid, errors } = validateAgainstSchema(
    { text: "some context" },
    contextBuildOutputSchema,
  );
  assert.equal(valid, false);
  assert.ok(errors.includes("delivered"));
});

// ---------------------------------------------------------------------------
// audit.run output schema (schemaVersion, paths, nodes, edges, prunedPaths)
// ---------------------------------------------------------------------------

test("(sv-audit-run-1) happy path: full AuditPack v3 shape validates", () => {
  const { valid, errors } = validateAgainstSchema(
    {
      schemaVersion: 3,
      disclaimer: "NOTICE: ...",
      builtAt: Date.now(),
      reposInvolved: [],
      paths: [],
      nodes: [],
      edges: [],
      prunedPaths: 0,
      findings: [],
    },
    auditRunOutputSchema,
  );
  assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("(sv-audit-run-2) missing prunedPaths → errors includes 'prunedPaths'", () => {
  const { valid, errors } = validateAgainstSchema(
    { schemaVersion: 3, paths: [], nodes: [], edges: [], findings: [] },
    auditRunOutputSchema,
  );
  assert.equal(valid, false);
  assert.ok(errors.includes("prunedPaths"));
});

test("(sv-audit-run-3) missing findings → errors includes 'findings'", () => {
  const { valid, errors } = validateAgainstSchema(
    { schemaVersion: 3, paths: [], nodes: [], edges: [], prunedPaths: 0 },
    auditRunOutputSchema,
  );
  assert.equal(valid, false);
  assert.ok(errors.includes("findings"), `errors must include 'findings'; got ${JSON.stringify(errors)}`);
});
