// query.test.ts — unit tests for src/graph/query.ts (graph algorithms)
// Run: node --no-warnings --experimental-strip-types --test test/query.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";
import { affected, queryGraph, resolveSeed, shortestPath } from "../src/application/graph/query.ts";

function node(id: string, label: string, over: Partial<GraphNode> = {}): GraphNode {
  return { id, label, fileType: "code", sourceFile: `${id}.ts`, kind: "function", ...over };
}
function edge(source: string, target: string, over: Partial<GraphEdge> = {}): GraphEdge {
  return { source, target, relation: "calls", confidence: "EXTRACTED", sourceFile: "x.ts", weight: 1, ...over };
}

// Builds a store from nodes+edges, runs `fn`, always closes + cleans up.
function withGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  fn: (store: GraphStore) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "graph-query-"));
  const store = new GraphStore(join(dir, "graph.db"));
  try {
    store.addNodes(nodes);
    store.addEdges(edges);
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// affected — blast radius (BFS backward over incoming edges)
// ---------------------------------------------------------------------------

test("affected: callers are reached backward up to depth", () => {
  // c -> b -> a   (a is called by b, b is called by c)
  const nodes = [node("a", "a"), node("b", "b"), node("c", "c")];
  const edges = [edge("b", "a"), edge("c", "b")];
  withGraph(nodes, edges, (store) => {
    const hits = affected(store, "a", 3);
    const ids = hits.map((h) => h.node.id).sort();
    assert.deepEqual(ids, ["b", "c"]);
    const b = hits.find((h) => h.node.id === "b")!;
    assert.equal(b.depth, 1);
    assert.equal(hits.find((h) => h.node.id === "c")!.depth, 2);
  });
});

test("affected: depth limit truncates the walk", () => {
  const nodes = [node("a", "a"), node("b", "b"), node("c", "c")];
  const edges = [edge("b", "a"), edge("c", "b")];
  withGraph(nodes, edges, (store) => {
    const hits = affected(store, "a", 1);
    assert.deepEqual(hits.map((h) => h.node.id), ["b"]);
  });
});

test("affected: AMBIGUOUS edges do not propagate impact", () => {
  const nodes = [node("a", "a"), node("b", "b")];
  const edges = [edge("b", "a", { confidence: "AMBIGUOUS" })];
  withGraph(nodes, edges, (store) => {
    assert.equal(affected(store, "a").length, 0);
  });
});

test("affected: non-propagating relation (contains) is ignored", () => {
  const nodes = [node("a", "a"), node("b", "b")];
  const edges = [edge("b", "a", { relation: "contains" })];
  withGraph(nodes, edges, (store) => {
    assert.equal(affected(store, "a").length, 0);
  });
});

test("affected: cycle does not loop forever", () => {
  const nodes = [node("a", "a"), node("b", "b")];
  const edges = [edge("b", "a"), edge("a", "b")];
  withGraph(nodes, edges, (store) => {
    const hits = affected(store, "a", 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.node.id, "b");
  });
});

// ---------------------------------------------------------------------------
// resolveSeed
// ---------------------------------------------------------------------------

test("resolveSeed: exact id wins", () => {
  withGraph([node("a", "Alpha")], [], (store) => {
    assert.equal(resolveSeed(store, "a")?.id, "a");
  });
});

test("resolveSeed: falls back to label lookup", () => {
  withGraph([node("a", "Alpha")], [], (store) => {
    assert.equal(resolveSeed(store, "Alpha")?.id, "a");
  });
});

test("resolveSeed: returns null when nothing matches", () => {
  withGraph([node("a", "Alpha")], [], (store) => {
    assert.equal(resolveSeed(store, "zzz-nope"), null);
  });
});

// ---------------------------------------------------------------------------
// shortestPath — BFS on the undirected view
// ---------------------------------------------------------------------------

test("shortestPath: same source/target → empty path", () => {
  withGraph([node("a", "a")], [], (store) => {
    assert.deepEqual(shortestPath(store, "a", "a"), []);
  });
});

test("shortestPath: finds a directed chain a→b→c", () => {
  const nodes = [node("a", "a"), node("b", "b"), node("c", "c")];
  const edges = [edge("a", "b"), edge("b", "c")];
  withGraph(nodes, edges, (store) => {
    const path = shortestPath(store, "a", "c");
    assert.ok(path);
    assert.equal(path.length, 2);
    assert.equal(path[0]!.from.id, "a");
    assert.equal(path[1]!.to.id, "c");
  });
});

test("shortestPath: traverses edges undirected (target→source)", () => {
  const nodes = [node("a", "a"), node("b", "b")];
  const edges = [edge("b", "a")]; // edge points b→a; path a→b still found
  withGraph(nodes, edges, (store) => {
    const path = shortestPath(store, "a", "b");
    assert.ok(path);
    assert.equal(path.length, 1);
  });
});

test("shortestPath: returns null for disconnected nodes", () => {
  const nodes = [node("a", "a"), node("b", "b")];
  withGraph(nodes, [], (store) => {
    assert.equal(shortestPath(store, "a", "b"), null);
  });
});

test("shortestPath: maxHops bound returns null when target is too far", () => {
  const nodes = [node("a", "a"), node("b", "b"), node("c", "c")];
  const edges = [edge("a", "b"), edge("b", "c")];
  withGraph(nodes, edges, (store) => {
    assert.equal(shortestPath(store, "a", "c", 1), null);
  });
});

// ---------------------------------------------------------------------------
// queryGraph — term-scored subgraph
// ---------------------------------------------------------------------------

test("queryGraph: scores matching nodes as seeds and expands neighborhood", () => {
  const nodes = [
    node("auth", "authenticate"),
    node("tok", "token"),
    node("unrel", "somethingElse"),
  ];
  const edges = [edge("auth", "tok")];
  withGraph(nodes, edges, (store) => {
    const r = queryGraph(store, "authenticate", 2, 40);
    assert.ok(r.seeds.some((s) => s.id === "auth"));
    // neighborhood expansion pulls in the connected token node
    assert.ok(r.nodes.some((n) => n.id === "tok"));
    // edges are restricted to included nodes
    assert.ok(r.edges.every((e) => r.nodes.some((n) => n.id === e.source)));
  });
});

test("queryGraph: question with no matching terms → no seeds", () => {
  const nodes = [node("a", "alpha"), node("b", "beta")];
  withGraph(nodes, [], (store) => {
    const r = queryGraph(store, "zzz qqq", 2, 40);
    assert.equal(r.seeds.length, 0);
    assert.equal(r.nodes.length, 0);
  });
});

test("queryGraph: maxNodes caps the returned neighborhood", () => {
  const nodes = [node("hub", "hub")];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 20; i++) {
    nodes.push(node(`n${i}`, `hub${i}`));
    edges.push(edge("hub", `n${i}`));
  }
  withGraph(nodes, edges, (store) => {
    const r = queryGraph(store, "hub", 2, 5);
    assert.ok(r.nodes.length <= 5);
  });
});

test("(q-subtok-1) a natural-language term hits camelCase symbols word-wise", () => {
  const nodes = [
    node("ofs", "openFreshStore"),
    node("gs", "GraphStore"),
    node("noise", "restoreBackup"), // contains "store" only as substring, not as a word
  ];
  withGraph(nodes, [], (store) => {
    const r = queryGraph(store, "how is the fresh store opened", 2, 40);
    assert.ok(r.seeds.some((s) => s.id === "ofs"), "openFreshStore seeds via subtokens fresh+store+open");
    // Word match must outrank the substring-only node.
    const ids = r.seeds.map((s) => s.id);
    assert.ok(!ids.includes("noise") || ids.indexOf("ofs") < ids.indexOf("noise"), "word match ranks above substring");
  });
});

test("(q-subtok-2) camelCase in the QUESTION splits too", () => {
  const nodes = [node("gs", "GraphStore"), node("other", "unrelated")];
  withGraph(nodes, [], (store) => {
    const r = queryGraph(store, "where does graphStore live", 2, 40);
    assert.ok(r.seeds.some((s) => s.id === "gs"), "graphStore token matches GraphStore by exact + word split");
  });
});

test("affected: a module/file seed expands to its members' blast radii", () => {
  // file.ts contains fn-a and class-k; class-k has method-m (Java-style `method` edge).
  // ext-caller calls fn-a; ext-user calls method-m. Touching the FILE must report both.
  const nodes = [
    node("file", "src/file.ts", { kind: "module" }),
    node("fn-a", "fnA"),
    node("class-k", "K", { kind: "class" }),
    node("method-m", "m", { kind: "method" }),
    node("ext-caller", "extCaller"),
    node("ext-user", "extUser"),
  ];
  const edges = [
    edge("file", "fn-a", { relation: "contains" }),
    edge("file", "class-k", { relation: "contains" }),
    edge("class-k", "method-m", { relation: "method" }),
    edge("ext-caller", "fn-a"),
    edge("ext-user", "method-m"),
  ];
  withGraph(nodes, edges, (store) => {
    const ids = affected(store, "file", 3).map((h) => h.node.id).sort();
    assert.deepEqual(ids, ["ext-caller", "ext-user"], "union of member blast radii");
  });
});

test("affected: intra-file dependents are not reported for a file seed", () => {
  // fn-b (inside the file) calls fn-a (same file); only the external caller counts —
  // everything inside the touched file is already 'touched'.
  const nodes = [
    node("file", "src/file.ts", { kind: "module" }),
    node("fn-a", "fnA"),
    node("fn-b", "fnB"),
    node("ext", "ext"),
  ];
  const edges = [
    edge("file", "fn-a", { relation: "contains" }),
    edge("file", "fn-b", { relation: "contains" }),
    edge("fn-b", "fn-a"),
    edge("ext", "fn-b"),
  ];
  withGraph(nodes, edges, (store) => {
    const ids = affected(store, "file", 3).map((h) => h.node.id).sort();
    assert.deepEqual(ids, ["ext"], "fn-b is inside the seed file, not a dependent");
  });
});

test("affected: a class seed does NOT expand to its methods (symbol semantics unchanged)", () => {
  const nodes = [
    node("class-k", "K", { kind: "class" }),
    node("method-m", "m", { kind: "method" }),
    node("ext-user", "extUser"),
  ];
  const edges = [
    edge("class-k", "method-m", { relation: "method" }),
    edge("ext-user", "method-m"),
  ];
  withGraph(nodes, edges, (store) => {
    const ids = affected(store, "class-k", 3).map((h) => h.node.id);
    assert.deepEqual(ids, [], "method callers are not the class's dependents");
  });
});
