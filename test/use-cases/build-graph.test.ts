// Unit tests for graph build path components using mock adapters — zero real fs/sqlite.
// Tests the MockGraphRepository roundtrip and the dedup application-layer function.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockGraphRepository } from "../mocks/graph.ts";
import { dedup } from "../../src/application/graph/dedup.ts";
import type { GraphNode, GraphEdge } from "../../src/domain/graph/model.ts";

function makeNode(id: string, label: string): GraphNode {
  return { id, label, fileType: "code", sourceFile: "src/test.ts" };
}

function makeEdge(source: string, target: string): GraphEdge {
  return {
    source,
    target,
    relation: "calls",
    confidence: "EXTRACTED",
    sourceFile: "src/test.ts",
    weight: 1,
  };
}

test("MockGraphRepository: addNodes + addEdges + stats roundtrip", () => {
  const repo = new MockGraphRepository();
  const nodes = [makeNode("a", "A"), makeNode("b", "B")];
  const edges = [makeEdge("a", "b")];

  repo.addNodes(nodes);
  repo.addEdges(edges);

  const stats = repo.stats();
  assert.equal(stats.nodes, 2);
  assert.equal(stats.edges, 1);
  assert.deepEqual(stats.byConfidence, { EXTRACTED: 1 });
});

test("MockGraphRepository: addNodes upserts on id collision", () => {
  const repo = new MockGraphRepository();
  repo.addNodes([makeNode("a", "Original")]);
  repo.addNodes([makeNode("a", "Updated")]);

  assert.equal(repo.allNodes().length, 1);
  assert.equal(repo.getNode("a")?.label, "Updated");
});

test("dedup: removes duplicate nodes and edges", () => {
  const nodes: GraphNode[] = [
    makeNode("a", "A"),
    makeNode("a", "A"),
    makeNode("b", "B"),
  ];
  const edges: GraphEdge[] = [
    makeEdge("a", "b"),
    makeEdge("a", "b"),
    makeEdge("a", "c"),
  ];

  const result = dedup(nodes, edges);
  assert.equal(result.nodes.length, 2);
  const abEdges = result.edges.filter((e) => e.source === "a" && e.target === "b");
  assert.equal(abEdges.length, 1);
  assert.equal(result.edges.length, 2);
});

test("MockGraphRepository: close sets closed flag", () => {
  const repo = new MockGraphRepository();
  assert.equal(repo.closed, false);
  repo.close();
  assert.equal(repo.closed, true);
});
