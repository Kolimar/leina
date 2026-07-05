// community.test.ts — unit + smoke tests for detectCommunities (Louvain).
// Run: node --no-warnings --experimental-strip-types --test test/community.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectCommunities,
  buildWeightedAdjacency,
  modularityGain,
  normalizeLabels,
} from "../src/application/graph/community.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function n(id: string): GraphNode {
  return { id, label: id, fileType: "code", sourceFile: "x.ts" };
}

function e(source: string, target: string, weight = 1.0): GraphEdge {
  return { source, target, relation: "calls", confidence: "EXTRACTED", sourceFile: "x.ts", weight };
}

// ---------------------------------------------------------------------------
// Determinism — same input → identical Map across repeated calls
// ---------------------------------------------------------------------------

test("determinism: same input yields identical Map on repeated calls", () => {
  const nodes = [n("a"), n("b"), n("c"), n("d")];
  const edges = [e("a", "b", 2), e("b", "c", 2), e("c", "d", 2), e("d", "a", 2)];
  const r1 = detectCommunities(nodes, edges);
  const r2 = detectCommunities(nodes, edges);
  assert.deepEqual([...r1.entries()].sort(), [...r2.entries()].sort());
});

// ---------------------------------------------------------------------------
// Empty graph
// ---------------------------------------------------------------------------

test("empty graph returns empty Map", () => {
  const result = detectCommunities([], []);
  assert.equal(result.size, 0);
});

// ---------------------------------------------------------------------------
// Single isolated node
// ---------------------------------------------------------------------------

test("single isolated node gets community 0", () => {
  const result = detectCommunities([n("solo")], []);
  assert.equal(result.size, 1);
  assert.equal(result.get("solo"), 0);
});

// ---------------------------------------------------------------------------
// Two isolated nodes (no edges)
// ---------------------------------------------------------------------------

test("two isolated nodes both get distinct communities 0 and 1", () => {
  const result = detectCommunities([n("x"), n("y")], []);
  assert.equal(result.size, 2);
  const vals = new Set(result.values());
  // No edges → no modularity gain → stay in own communities → 2 distinct ids
  assert.equal(vals.size, 2);
  // Labels must be 0..K-1 contiguous (normalizeLabels)
  assert.ok(vals.has(0));
  assert.ok(vals.has(1));
});

// ---------------------------------------------------------------------------
// Normalisation — ids must be 0..K-1 contiguous
// ---------------------------------------------------------------------------

test("community ids are 0..K-1 contiguous (no gaps)", () => {
  // Three clear clusters: a-b, c-d, e-f with strong intra but no inter edges.
  const nodes = [n("a"), n("b"), n("c"), n("d"), n("e"), n("f")];
  const edges = [
    e("a", "b", 10), e("b", "a", 10),
    e("c", "d", 10), e("d", "c", 10),
    e("e", "f", 10), e("f", "e", 10),
  ];
  const result = detectCommunities(nodes, edges);
  const vals = new Set(result.values());
  const k = vals.size;
  for (let i = 0; i < k; i++) assert.ok(vals.has(i), `Community ${i} missing`);
});

// ---------------------------------------------------------------------------
// Two clear clusters separate correctly
// ---------------------------------------------------------------------------

test("two dense clusters end up in different communities", () => {
  // Cluster 1: a-b-c fully connected with weight 10
  // Cluster 2: x-y-z fully connected with weight 10
  // Thin bridge a-x weight 0.1 (should not merge clusters)
  const nodes = [n("a"), n("b"), n("c"), n("x"), n("y"), n("z")];
  const edges = [
    e("a", "b", 10), e("b", "c", 10), e("a", "c", 10),
    e("x", "y", 10), e("y", "z", 10), e("x", "z", 10),
    e("a", "x", 0.1),
  ];
  const result = detectCommunities(nodes, edges);
  const comA = result.get("a")!;
  const comB = result.get("b")!;
  const comC = result.get("c")!;
  const comX = result.get("x")!;
  const comY = result.get("y")!;
  const comZ = result.get("z")!;
  // All within cluster-1 share same community
  assert.equal(comA, comB);
  assert.equal(comB, comC);
  // All within cluster-2 share same community
  assert.equal(comX, comY);
  assert.equal(comY, comZ);
  // The two clusters should have different community ids
  assert.notEqual(comA, comX);
});

// ---------------------------------------------------------------------------
// contains edges are included (cohesion requirement from spec)
// ---------------------------------------------------------------------------

test("contains edges contribute to adjacency weight", () => {
  const containsEdge: GraphEdge = {
    source: "mod", target: "fn",
    relation: "contains",
    confidence: "EXTRACTED",
    sourceFile: "x.ts",
    weight: 5,
  };
  const adj = buildWeightedAdjacency(["mod", "fn"], [containsEdge]);
  // Both directions should have weight 5
  assert.equal(adj.get("mod")?.get("fn"), 5);
  assert.equal(adj.get("fn")?.get("mod"), 5);
});

// ---------------------------------------------------------------------------
// modularityGain — unit for the formula
// ---------------------------------------------------------------------------

test("modularityGain: positive when moving toward dense community", () => {
  // Moving to a community where kj is large should beat staying put
  const gain = modularityGain(10, 0, 2, 5, 3, 20);
  assert.ok(gain > 0, `Expected positive gain, got ${gain}`);
});

test("modularityGain: zero when m2=0 (defensive)", () => {
  assert.equal(modularityGain(5, 5, 2, 4, 2, 0), 0);
});

// ---------------------------------------------------------------------------
// normalizeLabels — standalone unit
// ---------------------------------------------------------------------------

test("normalizeLabels remaps community ids to 0..K-1 by first sorted-id appearance", () => {
  const raw = new Map([["b", 7], ["a", 3], ["c", 7]]);
  const result = normalizeLabels(raw, ["a", "b", "c"]);
  // "a" appears first in sorted order → its raw id (3) maps to 0
  assert.equal(result.get("a"), 0);
  // "b" appears second; its raw id (7) → 1
  assert.equal(result.get("b"), 1);
  // "c" shares raw 7 with "b" → same mapped id (1)
  assert.equal(result.get("c"), 1);
});

// ---------------------------------------------------------------------------
// Smoke test — large synthetic graph must not crash
// ---------------------------------------------------------------------------

test("smoke: synthetic >10k-node graph completes without crash", () => {
  const SIZE = 10_500;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < SIZE; i++) nodes.push(n(`node-${i}`));
  // Create a chain so nodes are connected (prevents trivial early-exit)
  for (let i = 0; i < SIZE - 1; i++) edges.push(e(`node-${i}`, `node-${i + 1}`, 1));
  // Add a few cross-edges to create cluster structure
  for (let i = 0; i < SIZE - 100; i += 100) {
    edges.push(e(`node-${i}`, `node-${i + 50}`, 2));
  }
  let result: Map<string, number> | undefined;
  assert.doesNotThrow(() => {
    result = detectCommunities(nodes, edges);
  });
  assert.ok(result !== undefined);
  assert.equal(result.size, SIZE);
  // All values must be non-negative integers
  for (const v of result.values()) {
    assert.ok(v >= 0 && Number.isInteger(v));
  }
});
