// audit-reachability.test.ts — unit tests for computeReachable/auditReachability
// and OverlayGraphRepository
// Covers: forward/backward BFS, coverage %, overlay read-only enforcement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import {
  computeReachable,
  auditReachability,
  OverlayGraphRepository,
} from "../src/application/audit/reachability.ts";
import type { GraphNode, GraphEdge } from "../src/domain/graph/model.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "audit-reach-"));
}

function node(id: string): GraphNode {
  return { id, label: id, fileType: "code", kind: "function", sourceFile: "src/x.ts" };
}

function edge(source: string, target: string): GraphEdge {
  return { source, target, relation: "calls", confidence: "EXTRACTED", sourceFile: "src/x.ts", weight: 1 };
}

// ---------------------------------------------------------------------------
// computeReachable — forward BFS
// ---------------------------------------------------------------------------

test("(reach-1) single entry point, forward BFS", () => {
  const nodes = [node("a"), node("b"), node("c"), node("d")];
  const edges = [edge("a", "b"), edge("b", "c")]; // d is unreachable from a
  const result = computeReachable(nodes, edges, ["a"]);
  assert.ok(result.reachable.has("a"));
  assert.ok(result.reachable.has("b"));
  assert.ok(result.reachable.has("c"));
  assert.ok(!result.reachable.has("d"), "d should be unreachable");
  assert.ok(result.unreachable.has("d"));
  assert.equal(result.totalNodes, 4);
  assert.equal(result.coveragePct, 75); // 3/4 = 75%
});

test("(reach-2) no edges → only entry point reachable", () => {
  const nodes = [node("a"), node("b")];
  const result = computeReachable(nodes, [], ["a"]);
  assert.equal(result.reachable.size, 1);
  assert.ok(result.reachable.has("a"));
  assert.ok(result.unreachable.has("b"));
});

test("(reach-3) all nodes reachable → 100% coverage", () => {
  const nodes = [node("a"), node("b"), node("c")];
  const edges = [edge("a", "b"), edge("b", "c"), edge("a", "c")];
  const result = computeReachable(nodes, edges, ["a"]);
  assert.equal(result.coveragePct, 100);
  assert.equal(result.unreachable.size, 0);
});

test("(reach-4) backward BFS from leaf finds ancestors", () => {
  const nodes = [node("root"), node("mid"), node("leaf")];
  const edges = [edge("root", "mid"), edge("mid", "leaf")];
  const result = computeReachable(nodes, edges, ["leaf"], "backward");
  assert.ok(result.reachable.has("leaf"));
  assert.ok(result.reachable.has("mid"));
  assert.ok(result.reachable.has("root"));
});

test("(reach-5) empty entry points → reachable={}", () => {
  const nodes = [node("a"), node("b")];
  const result = computeReachable(nodes, [edge("a", "b")], []);
  assert.equal(result.reachable.size, 0);
  assert.equal(result.coveragePct, 0);
});

test("(reach-6) empty graph → 100% coverage (vacuously true)", () => {
  const result = computeReachable([], [], []);
  assert.equal(result.coveragePct, 100);
  assert.equal(result.totalNodes, 0);
});

// ---------------------------------------------------------------------------
// auditReachability — store-backed
// ---------------------------------------------------------------------------

test("(audit-reach) auditReachability works via GraphStore", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([node("a"), node("b"), node("c")]);
      store.addEdges([edge("a", "b")]);
      const result = auditReachability(store, ["a"]);
      assert.ok(result.reachable.has("a"));
      assert.ok(result.reachable.has("b"));
      assert.ok(result.unreachable.has("c"));
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// OverlayGraphRepository
// ---------------------------------------------------------------------------

test("(overlay-1) allNodes restricted to reachable", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([node("a"), node("b"), node("c")]);
      const overlay = new OverlayGraphRepository(store, new Set(["a", "b"]));
      const ids = overlay.allNodes().map((n) => n.id);
      assert.deepEqual(ids.sort(), ["a", "b"]);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(overlay-2) allEdges restricted to reachable source+target", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([node("a"), node("b"), node("c")]);
      store.addEdges([edge("a", "b"), edge("b", "c")]);
      const overlay = new OverlayGraphRepository(store, new Set(["a", "b"]));
      const edges = overlay.allEdges();
      assert.equal(edges.length, 1);
      assert.equal(edges[0]!.source, "a");
      assert.equal(edges[0]!.target, "b");
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(overlay-3) getNode returns undefined for unreachable node", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([node("a"), node("b")]);
      const overlay = new OverlayGraphRepository(store, new Set(["a"]));
      assert.ok(overlay.getNode("a") !== undefined);
      assert.equal(overlay.getNode("b"), undefined);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(overlay-4) clear/addNodes/addEdges throw (read-only)", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      const overlay = new OverlayGraphRepository(store, new Set());
      assert.throws(() => overlay.clear(), /read-only/);
      assert.throws(() => overlay.addNodes([node("x")]), /read-only/);
      assert.throws(() => overlay.addEdges([edge("x", "y")]), /read-only/);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(overlay-5) close() is a no-op (does not close base store)", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([node("a")]);
      const overlay = new OverlayGraphRepository(store, new Set(["a"]));
      overlay.close();
      // store should still be usable
      const ns = store.allNodes();
      assert.equal(ns.length, 1);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
