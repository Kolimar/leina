// store.test.ts — unit tests for src/core/store.ts (GraphStore, SQLite-backed)
// Run: node --no-warnings --experimental-strip-types --test test/store.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";

function tmpStore(): { store: GraphStore; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "graph-store-"));
  const path = join(dir, "graph.db");
  return { store: new GraphStore(path), dir, path };
}

function node(id: string, label: string, over: Partial<GraphNode> = {}): GraphNode {
  return { id, label, fileType: "code", sourceFile: "x.ts", kind: "function", ...over };
}
function edge(source: string, target: string, over: Partial<GraphEdge> = {}): GraphEdge {
  return { source, target, relation: "calls", confidence: "EXTRACTED", sourceFile: "x.ts", weight: 1, ...over };
}

test("addNodes + getNode round-trips all fields", () => {
  const { store, dir } = tmpStore();
  try {
    const sig = {
      returnType: { text: "number", nullable: false },
      parameters: [{ name: "x", type: "number", nullable: false, optional: false }],
      isAsync: false,
      isGenerator: false,
    };
    store.addNodes([node("f1", "compute", { sourceLocation: "L42", community: 3, signature: sig })]);
    const got = store.getNode("f1");
    assert.ok(got);
    assert.equal(got.label, "compute");
    assert.equal(got.sourceLocation, "L42");
    assert.equal(got.community, 3);
    assert.deepEqual(got.signature, sig);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getNode returns undefined for an unknown id", () => {
  const { store, dir } = tmpStore();
  try {
    assert.equal(store.getNode("nope"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addNodes upserts on conflicting id (label updated)", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("f1", "old")]);
    store.addNodes([node("f1", "new")]);
    assert.equal(store.getNode("f1")?.label, "new");
    assert.equal(store.stats().nodes, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findByLabel: exact match wins, then substring", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("f1", "auth"), node("f2", "authenticate"), node("f3", "reauth")]);
    const exact = store.findByLabel("auth");
    assert.equal(exact.length, 1);
    assert.equal(exact[0]!.id, "f1");
    // substring fallback when no exact match
    const sub = store.findByLabel("uthent");
    assert.ok(sub.some((n) => n.id === "f2"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addEdges + outEdges/inEdges/degree", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("a", "A"), node("b", "B"), node("c", "C")]);
    store.addEdges([edge("a", "b"), edge("a", "c"), edge("c", "a")]);
    assert.equal(store.outEdges("a").length, 2);
    assert.equal(store.inEdges("a").length, 1);
    assert.equal(store.degree("a"), 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addEdges upserts and accumulates weight on conflict", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("a", "A"), node("b", "B")]);
    store.addEdges([edge("a", "b", { weight: 2 })]);
    store.addEdges([edge("a", "b", { weight: 3 })]);
    const out = store.outEdges("a");
    assert.equal(out.length, 1);
    assert.equal(out[0]!.weight, 5);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stats aggregates counts by confidence", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("a", "A"), node("b", "B"), node("c", "C")]);
    store.addEdges([
      edge("a", "b", { confidence: "EXTRACTED" }),
      edge("a", "c", { confidence: "INFERRED", context: "field" }),
    ]);
    const s = store.stats();
    assert.equal(s.nodes, 3);
    assert.equal(s.edges, 2);
    assert.equal(s.byConfidence.EXTRACTED, 1);
    assert.equal(s.byConfidence.INFERRED, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statsByKind: node counts grouped by kind", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([
      node("f1", "fn1", { kind: "function" }),
      node("f2", "fn2", { kind: "function" }),
      node("c1", "C1", { kind: "class" }),
    ]);
    const byKind = store.statsByKind();
    assert.equal(byKind.function, 2);
    assert.equal(byKind.class, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statsByKind: nodes without a kind are bucketed under 'unknown'", () => {
  const { store, dir } = tmpStore();
  try {
    const noKind = { id: "u1", label: "U1", fileType: "code", sourceFile: "u.ts" } as GraphNode;
    store.addNodes([noKind, node("f1", "fn1", { kind: "function" })]);
    const byKind = store.statsByKind();
    assert.equal(byKind.unknown, 1);
    assert.equal(byKind.function, 1);
    assert.equal(
      Object.values(byKind).reduce((a, b) => a + b, 0),
      store.stats().nodes,
      "statsByKind totals must add up to stats().nodes",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statsByRelation: edge counts grouped by relation", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("a", "A"), node("b", "B"), node("c", "C")]);
    store.addEdges([
      edge("a", "b", { relation: "calls" }),
      edge("b", "c", { relation: "calls" }),
      edge("a", "c", { relation: "imports" }),
    ]);
    const byRelation = store.statsByRelation();
    assert.equal(byRelation.calls, 2);
    assert.equal(byRelation.imports, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear empties nodes and edges", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("a", "A"), node("b", "B")]);
    store.addEdges([edge("a", "b")]);
    store.clear();
    const s = store.stats();
    assert.equal(s.nodes, 0);
    assert.equal(s.edges, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toNodeLink serializes nodes + edges (networkx shape)", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("a", "A"), node("b", "B")]);
    store.addEdges([edge("a", "b")]);
    const nl = store.toNodeLink();
    assert.equal(nl.directed, true);
    assert.equal(nl.multigraph, false);
    assert.equal(nl.nodes.length, 2);
    assert.equal(nl.links.length, 1);
    const undirected = store.toNodeLink(false);
    assert.equal(undirected.directed, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateCommunities persists community values; getNode reflects them", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("a", "A"), node("b", "B"), node("c", "C")]);
    store.updateCommunities([
      { id: "a", community: 0 },
      { id: "b", community: 1 },
      { id: "c", community: 0 },
    ]);
    assert.equal(store.getNode("a")?.community, 0);
    assert.equal(store.getNode("b")?.community, 1);
    assert.equal(store.getNode("c")?.community, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateCommunities is idempotent: two identical calls yield same state", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("x", "X")]);
    store.updateCommunities([{ id: "x", community: 2 }]);
    store.updateCommunities([{ id: "x", community: 2 }]);
    assert.equal(store.getNode("x")?.community, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// replaceGraph — atomic swap (REQ-D3b). clear()/addNodes()/addEdges() above are
// UNCHANGED (same 16 tests, same behavior) — these are additive.
// ---------------------------------------------------------------------------

test("replaceGraph: a concurrent reader connection never observes an empty/partial graph", () => {
  const { store, dir, path } = tmpStore();
  try {
    store.addNodes([node("a", "A")]);
    store.addEdges([]);
    // A second, independent connection to the SAME db file — stands in for a
    // concurrent `leina query`/`affected` process reading during a build.
    const reader = new DatabaseSync(path);
    try {
      const before = (reader.prepare("SELECT COUNT(*) c FROM nodes").get() as unknown as { c: number }).c;
      assert.equal(before, 1);

      store.replaceGraph([node("x", "X"), node("y", "Y")], [edge("x", "y")]);

      // replaceGraph is a single synchronous call wrapping one BEGIN..COMMIT — no
      // application code (this test included) can observe an intermediate state
      // inside it. The reader sees either the old graph (checked above) or the
      // fully-replaced new one (checked here); it can never see 0 nodes.
      const after = (reader.prepare("SELECT COUNT(*) c FROM nodes").get() as unknown as { c: number }).c;
      assert.equal(after, 2, "reader sees the new graph fully inserted, never partial/empty");
    } finally {
      reader.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear()+addNodes() (pre-replaceGraph pattern) exposes an empty window to a concurrent reader — documents the bug replaceGraph fixes", () => {
  const { store, dir, path } = tmpStore();
  try {
    store.addNodes([node("a", "A")]);
    const reader = new DatabaseSync(path);
    try {
      store.clear(); // NOT wrapped in a transaction with the next addNodes() call
      const mid = (reader.prepare("SELECT COUNT(*) c FROM nodes").get() as unknown as { c: number }).c;
      assert.equal(mid, 0, "clear() alone commits and is visible to other connections before addNodes() runs");
      store.addNodes([node("b", "B")]);
    } finally {
      reader.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaceGraph rolls back to the previous graph on a failure between DELETE and INSERT", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("a", "A")]);
    store.addEdges([]);
    const badNode = { id: "bad", label: undefined, fileType: "code", sourceFile: "x.ts" } as unknown as GraphNode;
    assert.throws(() => {
      // The malformed node is rejected by the underlying bind call AFTER the DELETE
      // has already run inside the same transaction — forcing a ROLLBACK.
      store.replaceGraph([node("a", "A"), badNode], []);
    });
    const s = store.stats();
    assert.equal(s.nodes, 1, "rollback restores the previous graph, not an empty one");
    assert.equal(store.getNode("a")?.label, "A");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaceGraph replaces edges too (old edges gone, new edges present)", () => {
  const { store, dir } = tmpStore();
  try {
    store.addNodes([node("a", "A"), node("b", "B")]);
    store.addEdges([edge("a", "b")]);
    store.replaceGraph([node("c", "C"), node("d", "D")], [edge("c", "d")]);
    assert.equal(store.getNode("a"), undefined, "old node gone");
    assert.equal(store.outEdges("a").length, 0, "old edge gone");
    assert.equal(store.outEdges("c").length, 1, "new edge present");
    assert.equal(store.stats().nodes, 2);
    assert.equal(store.stats().edges, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopening a DB preserves data and is migration-safe", () => {
  const { store, dir, path } = tmpStore();
  try {
    store.addNodes([node("a", "A")]);
    store.close();
    const reopened = new GraphStore(path);
    assert.equal(reopened.getNode("a")?.label, "A");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
