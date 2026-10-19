// query-relevance.test.ts — `query` relevance (application/graph/relevance.ts + query-graph.ts):
// stopwords, stemming, IDF, test penalty, capped structural expansion, result shape.
// Run: node --no-warnings --experimental-strip-types --test test/query-relevance.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";
import { queryGraph } from "../src/application/graph/query.ts";
import { analyzeQuestion, stem } from "../src/application/graph/relevance.ts";

function fn(id: string, label: string, sourceFile: string, kind = "function"): GraphNode {
  return { id, label, fileType: "code", sourceFile, sourceLocation: "L1", kind };
}
function mod(path: string): GraphNode {
  return { id: path, label: path, fileType: "code", sourceFile: path, kind: "module" };
}
function edge(source: string, target: string, relation = "calls"): GraphEdge {
  return { source, target, relation, confidence: "EXTRACTED", sourceFile: "x.ts", sourceLocation: "L2", weight: 1 };
}

function withGraph(nodes: GraphNode[], edges: GraphEdge[], fn2: (store: GraphStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "query-relevance-"));
  const store = new GraphStore(join(dir, "graph.db"));
  try {
    store.addNodes(nodes);
    store.addEdges(edges);
    fn2(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Filler nodes so IDF has a vocabulary to work against (common words: get, build, graph).
function filler(n: number): GraphNode[] {
  const out: GraphNode[] = [];
  for (let i = 0; i < n; i++) out.push(fn(`f${i}`, `getGraph${i}Builder()`, `src/f${i}.ts`));
  return out;
}

test("(qrel-1) stemming meets inflections on both sides", () => {
  for (const [a, b] of [["verified", "verify"], ["verifies", "verify"], ["anchors", "anchor"], ["confined", "confine"],
    ["confinement", "confine"], ["freshness", "fresh"], ["checked", "check"], ["built", "build"], ["ids", "id"],
    ["queries", "query"], ["detected", "detect"], ["saving", "save"]] as const) {
    assert.equal(stem(a), stem(b), `${a} ~ ${b}`);
  }
  assert.notEqual(stem("status"), stem("state"));
});

test("(qrel-2) EN and ES stopwords and meta words are dropped; identifier tokens are kept as names", () => {
  const q = analyzeQuestion("how does the hook resolve the project root");
  assert.deepEqual(q.terms.sort(), ["hook", "project", "resolv", "root"]);
  assert.equal(q.names.size, 0, "plain English words never get the exact-name bonus");
  const es = analyzeQuestion("¿dónde se lee el consent flag?");
  assert.deepEqual(es.terms.sort(), ["consent", "flag", "lee"]);
  const ident = analyzeQuestion("where is openFreshStore called");
  assert.ok(ident.names.has("openfreshstore"));
  assert.deepEqual(analyzeQuestion("isStale").names, new Set(["isstale"]), "a one-word question is a name");
  assert.deepEqual(analyzeQuestion("x").terms, ["x"], "a one-letter, one-word question still names x()");
  assert.equal(analyzeQuestion("where is x set").terms.includes("x"), false, "one-letter words in a sentence are noise");
  assert.equal(analyzeQuestion("which function handles the code").terms.includes("function"), false);
});

test("(qrel-3) a common verb that equals a whole label no longer beats the symbol covering the question", () => {
  const nodes = [
    fn("resolve", "resolve()", "src/graph/resolve.ts"),
    fn("hook-root", "resolveHookProjectRoot()", "src/cli/agent-gate.ts"),
    mod("test/project-root.test.ts"),
    ...filler(30),
  ];
  withGraph(nodes, [], (store) => {
    const r = queryGraph(store, "how does the hook resolve the project root");
    assert.equal(r.seeds[0]?.id, "hook-root");
    assert.ok(!r.seeds.some((s) => s.id === "test/project-root.test.ts"), "test module matched by path words is not a seed");
  });
});

test("(qrel-4) IDF: a rare term decides over a common one", () => {
  const nodes = [
    fn("common", "buildGraph()", "src/a.ts"),
    fn("rare", "confineRoot()", "src/mcp.ts"),
    ...filler(40),
  ];
  withGraph(nodes, [], (store) => {
    // "graph" appears in 41 labels, "confine" in one: the rare term wins the seed.
    const r = queryGraph(store, "graph confine");
    assert.equal(r.seeds[0]?.id, "rare");
  });
});

test("(qrel-5) test/mock/fixture nodes are penalised and left out — unless asked for", () => {
  const nodes = [
    fn("prod", "verifyAnchor()", "src/memory/anchor-verify.ts"),
    fn("mock", "verifyAnchors()", "test/mocks/memory.ts"),
    fn("caller-prod", "saveObservation()", "src/memory/save.ts"),
    fn("caller-test", "itVerifies()", "test/memory.test.ts"),
    ...filler(10),
  ];
  const edges = [edge("caller-prod", "prod"), edge("caller-test", "prod")];
  withGraph(nodes, edges, (store) => {
    const r = queryGraph(store, "how are anchors verified");
    assert.equal(r.seeds[0]?.id, "prod");
    const ids = r.nodes.map((n) => n.id);
    assert.ok(ids.includes("caller-prod"));
    assert.ok(!ids.includes("caller-test"), "test caller left out of the neighbourhood");
    assert.equal(r.testsExcluded, true);
    const all = queryGraph(store, "how are anchors verified", { includeTests: true });
    assert.ok(all.nodes.some((n) => n.id === "caller-test"));
    assert.equal(all.testsExcluded, false);
    const asked = queryGraph(store, "how are anchors verified in tests");
    assert.equal(asked.testsExcluded, false, "a question about tests lifts the penalty");
  });
});

test("(qrel-6) a seed's file-mates do not fill the budget: semantic neighbours first, structure capped", () => {
  // One module with 40 unrelated functions + the matching one; the match has 2 callers elsewhere.
  const nodes: GraphNode[] = [mod("src/big.ts"), fn("target", "confineRoot()", "src/big.ts")];
  const edges: GraphEdge[] = [edge("src/big.ts", "target", "contains")];
  for (let i = 0; i < 40; i++) {
    nodes.push(fn(`sib${i}`, `sibling${i}()`, "src/big.ts"));
    edges.push(edge("src/big.ts", `sib${i}`, "contains"));
  }
  nodes.push(fn("c1", "callerOne()", "src/c1.ts"), fn("c2", "callerTwo()", "src/c2.ts"));
  edges.push(edge("c1", "target"), edge("c2", "target"));
  withGraph(nodes, edges, (store) => {
    const r = queryGraph(store, "where is the root confined");
    const ids = r.nodes.map((n) => n.id);
    assert.equal(ids[0], "target");
    assert.ok(ids.includes("c1") && ids.includes("c2"), "callers reached");
    assert.equal(ids.filter((id) => id.startsWith("sib")).length, 0, "no irrelevant siblings");
    assert.ok(r.edges.every((e) => e.relation !== "contains" && e.relation !== "method"), "structural edges omitted");
  });
});

test("(qrel-7) an identifier in the question gets the exact-name bonus", () => {
  const nodes = [
    fn("ofs", "openFreshStore()", "src/cli/wiring.ts"),
    fn("ofs2", "openFreshStoreOrThrow()", "src/cli/wiring.ts"),
    fn("other", "openStore()", "src/cli/wiring.ts"),
    ...filler(10),
  ];
  withGraph(nodes, [], (store) => {
    assert.equal(queryGraph(store, "who calls openFreshStore")?.seeds[0]?.id, "ofs");
  });
});

test("(qrel-8) maxNodes bounds the result; nodes come seeds-first; seeds stay under the floor", () => {
  const nodes = [fn("hub", "anchorHub()", "src/hub.ts"), ...filler(5)];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 30; i++) {
    nodes.push(fn(`n${i}`, `leaf${i}()`, `src/n${i}.ts`));
    edges.push(edge(`n${i}`, "hub"));
  }
  withGraph(nodes, edges, (store) => {
    const r = queryGraph(store, "anchor hub", { maxNodes: 6 });
    assert.equal(r.nodes.length, 6);
    assert.equal(r.nodes[0]?.id, "hub");
    assert.deepEqual(r.seeds.map((s) => s.id), ["hub"], "weak lexical matches are not filler seeds");
    // Without a tight budget the per-node cap bounds a hub: 8 semantic neighbours, not 30.
    assert.equal(queryGraph(store, "anchor hub").nodes.length, 9, "hub + 8 capped neighbours");
  });
});
