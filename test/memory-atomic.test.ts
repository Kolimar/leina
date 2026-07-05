// memory-atomic.test.ts — saveBatch atomic transaction contract test.
// ⚑ HARD PREREQUISITE FOR PR-4: must be green BEFORE splitting memory/store.ts.
// Run: node --no-warnings --experimental-strip-types --test test/memory-atomic.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteMemoryRepository as MemoryStore } from "../src/infrastructure/sqlite/memory-repository.ts";
import type { ObservationInput } from "../src/domain/memory/model.ts";

// ---- helpers ----------------------------------------------------------------

function tmpStore(): { store: MemoryStore; dir: string } {
  const dir = join(tmpdir(), `cg-atomic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "memory.db");
  const store = new MemoryStore(dbPath, "atomic_test_project");
  return { store, dir };
}

function cleanup(store: MemoryStore, dir: string): void {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

const validItem: ObservationInput = {
  title: "Valid observation",
  content: "This is a perfectly valid observation for atomic testing.",
  type: "manual",
};

// Item that will cause a NOT NULL constraint violation in SQLite (content is null).
// Cast bypasses TypeScript's type system to simulate bad runtime data.
const invalidItem = {
  title: "Invalid observation",
  content: null,
  type: "manual",
} as unknown as ObservationInput;

// ---- (atomic-a) saveBatch atomic: zero rows committed on rollback -----------

test("(atomic-a) saveBatch({atomic:true}): first item valid + second item invalid → zero rows committed (full rollback)", () => {
  const { store, dir } = tmpStore();
  try {
    const results = store.saveBatch([validItem, invalidItem], { atomic: true });

    assert.equal(results.length, 2, "must return one result per input item");

    // Both items must be errors — the entire batch was rolled back.
    assert.ok(!results[0]!.ok, "[0] must be error (rolled-back)");
    assert.ok(!results[1]!.ok, "[1] must be error (the trigger)");

    // The first item's error message must be exactly "rolled-back" (spec-locked wording).
    if (!results[0]!.ok) {
      assert.equal(
        (results[0]!).error,
        "rolled-back",
        "[0] error must be 'rolled-back'",
      );
    }

    // The second item's error must NOT be "rolled-back" — it is the causal error.
    if (!results[1]!.ok) {
      const err = (results[1]!).error;
      assert.notEqual(err, "rolled-back", "[1] error must be the causal error, not 'rolled-back'");
    }

    // Verify zero rows persisted: search should find nothing.
    const hits = store.search("Valid observation");
    assert.equal(hits.length, 0, "Atomic rollback must leave zero rows for the valid item");
  } finally {
    cleanup(store, dir);
  }
});

// ---- (atomic-b) saveBatch non-atomic: item1 persisted, item2 error ----------

test("(atomic-b) saveBatch({atomic:false}): first item persisted, second item error (partial success)", () => {
  const { store, dir } = tmpStore();
  try {
    const results = store.saveBatch([validItem, invalidItem], { atomic: false });

    assert.equal(results.length, 2, "must return one result per input item");

    // First item must succeed.
    assert.ok(results[0]!.ok, `[0] must be ok: ${JSON.stringify(results[0])}`);
    if (results[0]!.ok) {
      assert.ok(results[0]!.data.observation.id, "[0] must have an observation id");
      assert.equal(results[0]!.data.observation.title, "Valid observation");
    }

    // Second item must fail.
    assert.ok(!results[1]!.ok, `[1] must be error: ${JSON.stringify(results[1])}`);

    // Verify the valid item IS persisted: search should find it.
    const hits = store.search("Valid observation");
    assert.equal(hits.length, 1, "Non-atomic: valid item must be persisted despite sibling failure");
    assert.equal(hits[0]!.title, "Valid observation");
  } finally {
    cleanup(store, dir);
  }
});
