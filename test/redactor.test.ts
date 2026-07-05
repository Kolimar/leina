// test/redactor.test.ts — R9: StubRedactor pass-through.
// node --no-warnings --experimental-strip-types --test test/redactor.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { StubRedactor } from "../src/infrastructure/events/stub-redactor.ts";
import type { LeinaEvent } from "../src/domain/events/model.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<LeinaEvent> = {}): LeinaEvent {
  return {
    schemaVersion: 1,
    id: "test-id-1234",
    type: "graph.built",
    ts: 1700000000000,
    payload: { root: "/tmp/test", nodes: 10, edges: 5, filesScanned: 3, filesExtracted: 3 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// R9 / S9.1 — StubRedactor returns event with all fields identical
// ---------------------------------------------------------------------------

test("(R9-S9.1) StubRedactor.redact returns same object reference", () => {
  const redactor = new StubRedactor();
  const event = makeEvent();
  const result = redactor.redact(event);
  assert.strictEqual(result, event, "should return the same object reference");
});

test("(R9-S9.1) StubRedactor.redact: schemaVersion unchanged", () => {
  const redactor = new StubRedactor();
  const event = makeEvent();
  const result = redactor.redact(event);
  assert.strictEqual(result.schemaVersion, 1);
});

test("(R9-S9.1) StubRedactor.redact: id unchanged", () => {
  const redactor = new StubRedactor();
  const event = makeEvent({ id: "my-deterministic-id" });
  const result = redactor.redact(event);
  assert.strictEqual(result.id, "my-deterministic-id");
});

test("(R9-S9.1) StubRedactor.redact: type unchanged", () => {
  const redactor = new StubRedactor();
  const event = makeEvent({ type: "memory.created" });
  const result = redactor.redact(event);
  assert.strictEqual(result.type, "memory.created");
});

test("(R9-S9.1) StubRedactor.redact: ts unchanged", () => {
  const redactor = new StubRedactor();
  const ts = 1234567890123;
  const event = makeEvent({ ts });
  const result = redactor.redact(event);
  assert.strictEqual(result.ts, ts);
});

test("(R9-S9.1) StubRedactor.redact: payload unchanged (deep equal)", () => {
  const redactor = new StubRedactor();
  const payload = { root: "/project", nodes: 42, edges: 99, filesScanned: 10, filesExtracted: 10 };
  const event = makeEvent({ payload });
  const result = redactor.redact(event);
  assert.deepStrictEqual(result.payload, payload);
});

test("(R9-S9.1) StubRedactor.redact: all 3 event types pass through unchanged", () => {
  const redactor = new StubRedactor();
  const types = ["graph.built", "memory.created", "audit.completed"] as const;
  for (const type of types) {
    const event = makeEvent({ type });
    const result = redactor.redact(event);
    assert.strictEqual(result, event, `type ${type} should return same reference`);
  }
});
