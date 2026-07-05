// Unit tests for graph query use-cases (affected, shortestPath, resolveSeed)
// using MockGraphRepository — zero real SQLite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockGraphRepository } from "../mocks/graph.ts";
import { affected, resolveSeed, shortestPath } from "../../src/application/graph/query.ts";
import type { GraphNode, GraphEdge } from "../../src/domain/graph/model.ts";

function node(id: string, label: string): GraphNode {
  return { id, label, fileType: "code", sourceFile: `src/${id}.ts` };
}

function edge(source: string, target: string, relation: "calls" | "imports" = "calls"): GraphEdge {
  return {
    source,
    target,
    relation,
    confidence: "EXTRACTED",
    sourceFile: `src/${source}.ts`,
    weight: 1,
  };
}

test("affected: BFS backward collects dependents at correct depth", () => {
  const repo = new MockGraphRepository();
  const a = node("a", "A");
  const b = node("b", "B");
  const c = node("c", "C");
  repo.addNodes([a, b, c]);
  // B calls A, C calls B => affected(A) should find B@1, C@2
  repo.addEdges([edge("b", "a"), edge("c", "b")]);

  const hits = affected(repo, "a", 3);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.node.id, "b");
  assert.equal(hits[0]!.depth, 1);
  assert.equal(hits[1]!.node.id, "c");
  assert.equal(hits[1]!.depth, 2);
});

test("affected: AMBIGUOUS edges are skipped", () => {
  const repo = new MockGraphRepository();
  repo.addNodes([node("a", "A"), node("b", "B")]);
  repo.addEdges([{
    source: "b",
    target: "a",
    relation: "calls",
    confidence: "AMBIGUOUS",
    sourceFile: "src/b.ts",
    weight: 1,
  }]);

  const hits = affected(repo, "a", 3);
  assert.equal(hits.length, 0);
});

test("affected: depth limit is respected", () => {
  const repo = new MockGraphRepository();
  repo.addNodes([node("a", "A"), node("b", "B"), node("c", "C")]);
  repo.addEdges([edge("b", "a"), edge("c", "b")]);

  const hits = affected(repo, "a", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.node.id, "b");
});

test("resolveSeed: exact id match wins over label", () => {
  const repo = new MockGraphRepository();
  repo.addNodes([node("foo", "bar"), node("baz", "foo")]);

  const result = resolveSeed(repo, "foo");
  assert.equal(result?.id, "foo");
});

test("resolveSeed: falls back to label search when id not found", () => {
  const repo = new MockGraphRepository();
  repo.addNodes([node("x1", "MyClass")]);

  const result = resolveSeed(repo, "MyClass");
  assert.equal(result?.id, "x1");
});

test("resolveSeed: returns null for unknown query", () => {
  const repo = new MockGraphRepository();
  const result = resolveSeed(repo, "nonexistent");
  assert.equal(result, null);
});

test("shortestPath: same source and target returns empty array", () => {
  const repo = new MockGraphRepository();
  const path = shortestPath(repo, "a", "a");
  assert.deepEqual(path, []);
});

test("shortestPath: finds direct edge", () => {
  const repo = new MockGraphRepository();
  repo.addNodes([node("a", "A"), node("b", "B")]);
  repo.addEdges([edge("a", "b")]);

  const path = shortestPath(repo, "a", "b");
  assert.ok(path);
  assert.equal(path.length, 1);
  assert.equal(path[0]!.from.id, "a");
  assert.equal(path[0]!.to.id, "b");
});

test("shortestPath: returns null when no connection", () => {
  const repo = new MockGraphRepository();
  repo.addNodes([node("a", "A"), node("b", "B")]);

  const path = shortestPath(repo, "a", "b");
  assert.equal(path, null);
});
