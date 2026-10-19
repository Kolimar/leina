// graph-findbylabel-index.test.ts — the NOCASE label index behind findByLabel's exact
// branch: created on fresh dbs, retrofitted into existing v4 dbs, actually used by the
// query planner, and zero observable change to findByLabel's results.
// Run: node --no-warnings --experimental-strip-types --test test/graph-findbylabel-index.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import type { GraphNode } from "../src/domain/graph/model.ts";

const INDEX_NAME = "idx_nodes_label_nocase";

function tmpDb(suffix: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `leina-fbl-${suffix}-`));
  return { path: join(dir, "graph.db"), dir };
}

function node(id: string, label: string): GraphNode {
  return { id, label, fileType: "ts", sourceFile: `src/${id}.ts` };
}

function hasIndex(path: string): boolean {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
        .get(INDEX_NAME) !== undefined
    );
  } finally {
    db.close();
  }
}

test("(fbl-1) fresh db gets the NOCASE label index and the planner uses it for the exact probe", () => {
  const { path, dir } = tmpDb("fresh");
  try {
    const store = new GraphStore(path);
    store.addNodes([node("a", "OpenFreshStore"), node("b", "helper")]);
    store.close();
    assert.ok(hasIndex(path), "index created by SCHEMA on a fresh db");

    // The exact branch's predicate collation matches the index collation → index seek.
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const plan = (
        db
          .prepare("EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE label = ? COLLATE NOCASE")
          .all("x") as unknown as { detail: string }[]
      ).map((r) => r.detail).join(" | ");
      assert.match(plan, new RegExp(INDEX_NAME), `exact probe uses the index (plan: ${plan})`);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(fbl-2) existing v4 db without the index is retrofitted on the next R/W open", () => {
  const { path, dir } = tmpDb("retrofit");
  try {
    new GraphStore(path).close(); // fresh v4 db (index present)
    // Simulate a db stamped v4 BEFORE the index existed.
    const raw = new DatabaseSync(path);
    raw.exec(`DROP INDEX ${INDEX_NAME}`);
    raw.close();
    assert.equal(hasIndex(path), false, "precondition: index dropped");

    new GraphStore(path).close(); // fast path (v === 4) must retrofit
    assert.ok(hasIndex(path), "index recreated by the version fast path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(fbl-3) findByLabel results are unchanged: exact > functional-exact > substring", () => {
  const { path, dir } = tmpDb("results");
  try {
    const store = new GraphStore(path);
    store.addNodes([
      node("n1", "openFreshStore"),
      node("n2", "OPENFRESHSTORE"), // case-variant of the same label
      node("n3", "fresh-store"), // functional-exact for "fresh_store" (normalizes equal)
      node("n4", "fresh_store_helper"), // substring-only match for "fresh_store"
    ]);

    // 1. exact (case-insensitive): both case-variants, nothing else.
    const exact = store.findByLabel("openfreshstore");
    assert.deepEqual(new Set(exact.map((n) => n.id)), new Set(["n1", "n2"]));

    // 2. functional-exact: LIKE finds n3 (the "_" wildcard crosses the "-") and n4,
    //    but only n3's normalized label equals the normalized query → n4 filtered out.
    const functional = store.findByLabel("fresh_store");
    assert.deepEqual(functional.map((n) => n.id), ["n3"]);

    // 3. substring, shortest label first (no exact hit, no functional-exact).
    const sub = store.findByLabel("resh");
    assert.equal(sub[0]!.id, "n3", "shortest matching label ranks first");
    assert.deepEqual(
      new Set(sub.map((n) => n.id)),
      new Set(["n1", "n2", "n3", "n4"]),
      "all substring matches included",
    );

    // 4. no match → empty.
    assert.deepEqual(store.findByLabel("zzz-nothing"), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(fbl-4) read-only open never attempts index DDL and findByLabel still answers", () => {
  const { path, dir } = tmpDb("readonly");
  try {
    const w = new GraphStore(path);
    w.addNodes([node("a", "Anchor")]);
    w.close();
    // Strip the index — a query_only connection must neither recreate it nor fail.
    const raw = new DatabaseSync(path);
    raw.exec(`DROP INDEX ${INDEX_NAME}`);
    raw.close();

    const ro = new GraphStore(path, { readOnly: true });
    const hit = ro.findByLabel("anchor");
    ro.close();
    assert.equal(hit.length, 1, "exact match works without the index (unaccelerated)");
    assert.equal(hit[0]!.id, "a");
    assert.equal(hasIndex(path), false, "read-only open did not create the index");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
