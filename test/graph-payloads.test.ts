// graph-payloads.test.ts — compact JSON shapes of the graph reads (application/graph/payloads.ts):
// MCP graph_query / graph_affected / graph_path / impact_analyze and `query --json`.
// Run: node --no-warnings --experimental-strip-types --test test/graph-payloads.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";
import { affected, queryGraph, shortestPath } from "../src/application/graph/query.ts";
import { compactDependents, compactEdge, compactNode, compactPath, compactQuery } from "../src/application/graph/payloads.ts";

const SIGNATURE = { parameters: [{ name: "x", type: "string", nullable: false, optional: false }], isAsync: false, isGenerator: false };

function node(id: string, label: string, sourceFile: string, line: number, kind = "function"): GraphNode {
  return { id, label, fileType: "code", sourceFile, sourceLocation: `L${line}`, kind, community: 7, signature: SIGNATURE } as GraphNode;
}
function edge(source: string, target: string, relation: string, sourceFile: string, line: number, extra: Partial<GraphEdge> = {}): GraphEdge {
  return { source, target, relation, confidence: "EXTRACTED", sourceFile, sourceLocation: `L${line}`, weight: 1, ...extra };
}

// Port.find() ← Impl.find() (implements); caller() calls Impl.find() and Port.find().
const NODES: GraphNode[] = [
  node("port", "Port", "src/port.ts", 1, "interface"),
  node("port.find", "find()", "src/port.ts", 2, "method"),
  node("impl", "Impl", "src/impl.ts", 3, "class"),
  node("impl.find", "find()", "src/impl.ts", 4, "method"),
  node("caller", "callerOfPort()", "src/use.ts", 10),
  node("other", "otherCaller()", "src/other.ts", 20),
];
const EDGES: GraphEdge[] = [
  edge("port", "port.find", "method", "src/port.ts", 2),
  edge("impl", "impl.find", "method", "src/impl.ts", 4),
  edge("impl.find", "port.find", "implements", "src/impl.ts", 4),
  edge("caller", "port.find", "calls", "src/use.ts", 12),
  edge("other", "caller", "calls", "src/other.ts", 22, { confidence: "INFERRED" }),
  edge("caller", "impl", "references", "src/use.ts", 11, { context: "parameter_type" }),
];

function withStore(fn: (store: GraphStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "graph-payloads-"));
  const store = new GraphStore(join(dir, "graph.db"));
  try {
    store.addNodes(NODES);
    store.addEdges(EDGES);
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(pay-1) a compact node is {id, label, kind, at}: owner-qualified label, file:line, no signature/community", () => {
  withStore((store) => {
    const n = compactNode(store, store.getNode("impl.find")!);
    assert.deepEqual(n, { id: "impl.find", label: "Impl.find()", kind: "method", at: "src/impl.ts:4" });
    const ws = compactNode(store, { ...NODES[4]!, repo: "svc-a" });
    assert.equal(ws.repo, "svc-a", "workspace mode keeps the repo");
  });
});

test("(pay-2) a compact edge keeps its direction and site; confidence only when not EXTRACTED, context only when set", () => {
  assert.deepEqual(compactEdge(EDGES[3]!), { source: "caller", target: "port.find", relation: "calls", at: "src/use.ts:12" });
  assert.equal(compactEdge(EDGES[4]!).confidence, "INFERRED");
  assert.equal(compactEdge(EDGES[5]!).context, "parameter_type");
  const noLine = { ...EDGES[3]!, sourceLocation: undefined };
  assert.equal(compactEdge(noLine, NODES[4]).at, "src/use.ts:10", "falls back to the source node's definition");
});

test("(pay-3) compactQuery: seeds are ids leading `nodes`; structural edges never appear", () => {
  withStore((store) => {
    const res = compactQuery(store, queryGraph(store, "callerOfPort"));
    assert.equal(res.seeds[0], "caller");
    assert.equal(res.nodes[0]?.id, "caller");
    assert.ok(res.nodes.every((n) => Object.keys(n).every((k) => ["id", "label", "kind", "at"].includes(k))));
    assert.ok(res.edges.every((e) => e.relation !== "method" && e.relation !== "contains"));
    assert.ok(res.edges.some((e) => e.source === "other" && e.target === "caller" && e.at === "src/other.ts:22"));
    assert.equal(typeof res.testsExcluded, "boolean");
  });
});

test("(pay-4) compactDependents: `at` is the call site, `target` the node depended on, `via` the contract", () => {
  withStore((store) => {
    const deps = compactDependents(store, affected(store, "impl.find", 3));
    const direct = deps.find((d) => d.id === "caller");
    assert.deepEqual(direct, {
      id: "caller", label: "callerOfPort()", kind: "function", at: "src/use.ts:12", depth: 1, relation: "calls",
      target: "port.find", via: { id: "port.find", label: "Port.find()", kind: "method", at: "src/port.ts:2" },
    });
    const second = deps.find((d) => d.id === "other");
    assert.equal(second?.depth, 2);
    assert.equal(second?.target, "caller");
    assert.equal(second?.at, "src/other.ts:22");
  });
});

test("(pay-5) compactPath: nodes in order, each edge joins consecutive nodes in its real direction", () => {
  withStore((store) => {
    // other → caller → port.find ← impl.find: the last hop runs against the edge.
    const steps = shortestPath(store, "other", "impl.find");
    assert.ok(steps);
    const p = compactPath(store, store.getNode("other")!, steps);
    assert.deepEqual(p.nodes.map((n) => n.label), ["otherCaller()", "callerOfPort()", "Port.find()", "Impl.find()"]);
    assert.equal(p.edges.length, p.nodes.length - 1);
    p.edges.forEach((e, i) => {
      assert.deepEqual(new Set([e.source, e.target]), new Set([p.nodes[i]!.id, p.nodes[i + 1]!.id]), `edge ${i} joins its nodes`);
    });
    assert.deepEqual(p.edges[2], { source: "impl.find", target: "port.find", relation: "implements", at: "src/impl.ts:4" });
    assert.equal(p.edges[0]?.confidence, "INFERRED");
    const same = compactPath(store, store.getNode("other")!, []);
    assert.deepEqual(same, { nodes: [compactNode(store, store.getNode("other")!)], edges: [] });
  });
});
