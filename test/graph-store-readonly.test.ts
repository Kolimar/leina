// graph-store-readonly.test.ts — defense-in-depth for `graph serve` (S2 hardening).
// The serve handlers open every store with { readOnly: true }. That flips the SQLite
// connection to PRAGMA query_only, so a logic bug in a GET handler that tried to write
// fails IN-BAND with a readonly error rather than silently mutating the artifact under
// inspection. These tests pin that contract: reads work, writes throw, disk is untouched.
// Run: node --no-warnings --experimental-strip-types --test test/graph-store-readonly.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";

test("(GSRO-1) read-only GraphStore serves reads but rejects writes with a readonly error", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-gsro-"));
  const dbPath = join(dir, "graph.db");
  try {
    // Seed a normal (R/W) store, then reopen the same file read-only.
    const seed = new GraphStore(dbPath);
    seed.addNodes([
      { id: "n:1", label: "one", fileType: "code", sourceFile: "a.ts", kind: "function" },
    ]);
    seed.close();

    const ro = new GraphStore(dbPath, { readOnly: true });
    try {
      // Reads still work through a query_only connection.
      assert.equal(ro.getNode("n:1")?.label, "one", "read-only store can read seeded node");
      assert.equal(ro.stats().nodes, 1, "read-only store can run aggregate reads");

      // A write attempt fails in-band — this is the whole point of the hardening.
      assert.throws(
        () =>
          ro.addNodes([
            { id: "n:2", label: "two", fileType: "code", sourceFile: "b.ts", kind: "function" },
          ]),
        /readonly|read-only|query_only/i,
        "writing through a read-only store must throw SQLITE_READONLY",
      );
    } finally {
      ro.close();
    }

    // The rejected write left the file untouched: still exactly the one seeded node.
    const verify = new GraphStore(dbPath);
    assert.equal(verify.stats().nodes, 1, "rejected write did not persist");
    assert.equal(verify.getNode("n:2"), undefined, "the would-be inserted node is absent");
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GSRO-2) read-only SQLiteMemoryRepository serves reads but rejects saves", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-msro-"));
  const memPath = join(dir, "memory.db");
  try {
    // Seed a normal store with one observation, then reopen read-only.
    const seed = new SQLiteMemoryRepository(memPath, "proj");
    seed.save({ title: "Seeded", content: "hello world", type: "manual" });
    seed.close();

    const ro = new SQLiteMemoryRepository(memPath, "proj", undefined, { readOnly: true });
    try {
      // Reads work: the seeded observation is searchable.
      const hits = ro.search("hello");
      assert.equal(hits.length, 1, "read-only memory store can search");
      assert.equal(hits[0]?.title, "Seeded");

      // A save fails in-band.
      assert.throws(
        () => ro.save({ title: "Nope", content: "should not persist", type: "manual" }),
        /readonly|read-only|query_only/i,
        "saving through a read-only memory store must throw SQLITE_READONLY",
      );
    } finally {
      ro.close();
    }

    // Nothing new landed.
    const verify = new SQLiteMemoryRepository(memPath, "proj");
    assert.equal(verify.search("should not persist").length, 0, "rejected save did not persist");
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
