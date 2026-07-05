// batch.test.ts — unit tests for src/core/batch.ts (pure helpers, no I/O)
// Run: node --no-warnings --experimental-strip-types --test test/batch.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type BatchResult,
  formatBatchResults,
  parseScalarOrBatch,
} from "../src/domain/shared/batch.ts";

// ---------------------------------------------------------------------------
// parseScalarOrBatch
// ---------------------------------------------------------------------------

test("parseScalarOrBatch: no batch key → scalar mode with whole input as payload", () => {
  const input = { title: "t", content: "c" };
  const r = parseScalarOrBatch<typeof input, unknown>(input, ["title", "content"], "items");
  assert.equal(r.mode, "scalar");
  assert.deepEqual(r.payload, input);
});

test("parseScalarOrBatch: array under batch key → batch mode with the array", () => {
  const items = [{ title: "a" }, { title: "b" }];
  const r = parseScalarOrBatch<unknown, { title: string }>({ items }, [], "items");
  assert.equal(r.mode, "batch");
  assert.deepEqual(r.payload, items);
});

test("parseScalarOrBatch: batch key present but not an array → scalar mode", () => {
  const input = { items: "not-an-array", title: "t" };
  const r = parseScalarOrBatch<typeof input, unknown>(input, ["title"], "items");
  assert.equal(r.mode, "scalar");
  assert.deepEqual(r.payload, input);
});

test("parseScalarOrBatch: empty array under batch key → batch mode with []", () => {
  const r = parseScalarOrBatch<unknown, unknown>({ items: [] }, [], "items");
  assert.equal(r.mode, "batch");
  assert.deepEqual(r.payload, []);
});

test("parseScalarOrBatch: custom batch key is honored", () => {
  const rows = [{ id: 1 }];
  const r = parseScalarOrBatch<unknown, { id: number }>({ rows }, [], "rows");
  assert.equal(r.mode, "batch");
  assert.deepEqual(r.payload, rows);
});

// ---------------------------------------------------------------------------
// formatBatchResults
// ---------------------------------------------------------------------------

test("formatBatchResults: mixed ok/error rows are indexed and rendered", () => {
  const results: BatchResult<{ id: number }>[] = [
    { ok: true, data: { id: 10 } },
    { ok: false, error: "bad input" },
    { ok: true, data: { id: 12 } },
  ];
  const out = formatBatchResults(results, (d) => `id=${d.id}`);
  assert.equal(out, "[0] ok: id=10\n[1] error: bad input\n[2] ok: id=12");
});

test("formatBatchResults: empty list → empty string", () => {
  assert.equal(formatBatchResults<unknown>([], () => "x"), "");
});

test("formatBatchResults: render callback receives the data payload", () => {
  const results: BatchResult<string>[] = [{ ok: true, data: "hello" }];
  const out = formatBatchResults(results, (d) => d.toUpperCase());
  assert.equal(out, "[0] ok: HELLO");
});
