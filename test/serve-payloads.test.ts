// serve-payloads.test.ts — unit tests for src/application/graph/serve-payloads.ts
// (graph-serve task 3.3): pure JSON payload builders behind the FR-06 API contract,
// exercised without any HTTP server (that's the next wave, 3.4-3.7).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStatsPayload,
  buildTreePayload,
  buildSearchPayload,
  buildGraphPayload,
  buildNodeDetailPayload,
  buildNodeMemoriesPayload,
} from "../src/application/graph/serve-payloads.ts";
import type { NodeVerifier } from "../src/application/memory/query.ts";
import { MockGraphRepository } from "./mocks/graph.ts";
import { MockMemoryRepository } from "./mocks/memory.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";

function node(over: Partial<GraphNode> & { id: string; label: string; sourceFile: string }): GraphNode {
  return { fileType: "code", ...over };
}

function edge(over: Partial<GraphEdge> & { source: string; target: string; relation: string }): GraphEdge {
  return { confidence: "EXTRACTED", sourceFile: "x", weight: 1, ...over };
}

// ---------------------------------------------------------------------------
// buildStatsPayload — FR-14
// ---------------------------------------------------------------------------

test("buildStatsPayload: byKind/byRelation sorted count desc, key asc", () => {
  const store = new MockGraphRepository();
  store.addNodes([
    node({ id: "1", label: "a", sourceFile: "s", kind: "function" }),
    node({ id: "2", label: "b", sourceFile: "s", kind: "function" }),
    node({ id: "3", label: "c", sourceFile: "s", kind: "class" }),
  ]);
  store.addEdges([
    edge({ source: "1", target: "2", relation: "calls" }),
    edge({ source: "2", target: "3", relation: "calls" }),
    edge({ source: "1", target: "3", relation: "imports" }),
  ]);
  const payload = buildStatsPayload(store);
  assert.deepEqual(payload.byKind, [
    { kind: "function", count: 2 },
    { kind: "class", count: 1 },
  ]);
  assert.deepEqual(payload.byRelation, [
    { relation: "calls", count: 2 },
    { relation: "imports", count: 1 },
  ]);
});

test("buildStatsPayload: empty graph → empty arrays, no throw", () => {
  const store = new MockGraphRepository();
  assert.deepEqual(buildStatsPayload(store), { byKind: [], byRelation: [] });
});

// ---------------------------------------------------------------------------
// buildTreePayload — FR-10
// ---------------------------------------------------------------------------

test("buildTreePayload: builds a nested folder tree with sorted children/files", () => {
  const nodes = [
    node({ id: "1", label: "a", sourceFile: "src/domain/a.ts" }),
    node({ id: "2", label: "b", sourceFile: "src/domain/b.ts" }),
    node({ id: "3", label: "c", sourceFile: "src/application/c.ts" }),
    node({ id: "4", label: "root", sourceFile: "readme.md" }),
  ];
  const { tree } = buildTreePayload(nodes);
  assert.equal(tree.path, "");
  assert.deepEqual(tree.files, ["readme.md"]);
  assert.equal(tree.children.length, 1, "only 'src' at the top level");
  const src = tree.children[0]!;
  assert.equal(src.path, "src");
  assert.equal(src.files.length, 0);
  assert.deepEqual(
    src.children.map((c) => c.path),
    ["src/application", "src/domain"],
    "children sorted alphabetically",
  );
  const domain = src.children.find((c) => c.path === "src/domain")!;
  assert.deepEqual(domain.files, ["src/domain/a.ts", "src/domain/b.ts"]);
});

test("buildTreePayload: duplicate sourceFile across nodes is listed once", () => {
  const nodes = [
    node({ id: "1", label: "a", sourceFile: "src/domain/a.ts" }),
    node({ id: "2", label: "a2", sourceFile: "src/domain/a.ts" }),
  ];
  const { tree } = buildTreePayload(nodes);
  const domain = tree.children[0]!.children[0]!;
  assert.deepEqual(domain.files, ["src/domain/a.ts"]);
});

test("buildTreePayload: empty node list → bare root", () => {
  const { tree } = buildTreePayload([]);
  assert.deepEqual(tree, { path: "", children: [], files: [] });
});

// ---------------------------------------------------------------------------
// buildSearchPayload — FR-06
// ---------------------------------------------------------------------------

test("buildSearchPayload: delegates to findByLabel and maps to the API shape", () => {
  const store = new MockGraphRepository();
  store.addNodes([
    node({ id: "fn:openFreshStore", label: "openFreshStore", sourceFile: "src/a.ts", kind: "function" }),
    node({ id: "fn:other", label: "somethingElse", sourceFile: "src/b.ts", kind: "function" }),
  ]);
  const { results } = buildSearchPayload(store, "openfresh");
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    id: "fn:openFreshStore",
    label: "openFreshStore",
    kind: "function",
    file: "src/a.ts",
  });
});

test("buildSearchPayload: blank query → empty results, no throw", () => {
  const store = new MockGraphRepository();
  assert.deepEqual(buildSearchPayload(store, "   "), { results: [] });
});

test("buildSearchPayload: missing kind falls back to 'unknown'", () => {
  const store = new MockGraphRepository();
  store.addNodes([node({ id: "1", label: "widget", sourceFile: "src/a.ts" })]);
  const { results } = buildSearchPayload(store, "widget");
  assert.equal(results[0]!.kind, "unknown");
});

// ---------------------------------------------------------------------------
// buildNodeDetailPayload — FR-06/FR-11
// ---------------------------------------------------------------------------

function detailFixture(): MockGraphRepository {
  const store = new MockGraphRepository();
  store.addNodes([
    node({ id: "mod:file", label: "file.ts", sourceFile: "src/domain/file.ts", kind: "module" }),
    node({ id: "fn:target", label: "target", sourceFile: "src/domain/file.ts", kind: "function" }),
    node({ id: "fn:caller1", label: "caller1", sourceFile: "src/domain/other.ts", kind: "function" }),
    node({ id: "fn:caller2", label: "caller2", sourceFile: "src/application/other2.ts", kind: "function" }),
  ]);
  store.addEdges([
    edge({ source: "mod:file", target: "fn:target", relation: "contains" }),
    edge({ source: "fn:caller1", target: "fn:target", relation: "calls" }),
    edge({ source: "fn:caller2", target: "fn:target", relation: "calls" }),
  ]);
  return store;
}

test("buildNodeDetailPayload: unknown node id → null", () => {
  const store = detailFixture();
  assert.equal(buildNodeDetailPayload(store, "nope"), null);
});

test("buildNodeDetailPayload: node/declaredBy/invokedBy shaped per FR-11", () => {
  const store = detailFixture();
  const payload = buildNodeDetailPayload(store, "fn:target")!;
  assert.equal(payload.node.id, "fn:target");
  assert.equal(payload.node.label, "target");
  assert.equal(payload.node.degree, 2, "contains edge excluded from degree (A5)");

  assert.equal(payload.declaredBy.length, 1);
  assert.equal(payload.declaredBy[0]!.id, "mod:file");
  assert.equal(payload.declaredBy[0]!.relation, "contains");

  assert.equal(payload.invokedBy.length, 2);
  const invokerIds = payload.invokedBy.map((r) => r.id).sort();
  assert.deepEqual(invokerIds, ["fn:caller1", "fn:caller2"]);
  assert.equal(payload.invokedBy[0]!.relation, "calls");
});

test("buildNodeDetailPayload: node with no inbound edges → empty declaredBy/invokedBy", () => {
  const store = detailFixture();
  const payload = buildNodeDetailPayload(store, "mod:file")!;
  assert.deepEqual(payload.declaredBy, []);
  assert.deepEqual(payload.invokedBy, []);
});

test("buildNodeDetailPayload: neighbors covers ALL relations, both directions", () => {
  const store = detailFixture();
  const payload = buildNodeDetailPayload(store, "fn:target")!;
  // 3 incident edges total: contains (in) + 2 calls (in). All must appear.
  assert.equal(payload.neighbors.length, 3);
  const byKey = payload.neighbors.map((n) => `${n.relation}:${n.direction}:${n.id}`).sort();
  assert.deepEqual(byKey, [
    "calls:in:fn:caller1",
    "calls:in:fn:caller2",
    "contains:in:mod:file",
  ]);
});

test("buildNodeDetailPayload: outbound edges appear as direction 'out'", () => {
  const store = detailFixture();
  const payload = buildNodeDetailPayload(store, "fn:caller1")!;
  assert.equal(payload.neighbors.length, 1);
  assert.equal(payload.neighbors[0]!.direction, "out");
  assert.equal(payload.neighbors[0]!.id, "fn:target");
  assert.equal(payload.neighbors[0]!.relation, "calls");
});

// ---------------------------------------------------------------------------
// buildGraphPayload — full-graph endpoint for the explorer's initial render
// ---------------------------------------------------------------------------

test("buildGraphPayload: returns every node and edge with non-contains degree", () => {
  const store = detailFixture();
  const payload = buildGraphPayload(store);
  assert.equal(payload.truncated, false);
  assert.equal(payload.nodes.length, 4);
  assert.equal(payload.edges.length, 3);
  const target = payload.nodes.find((n) => n.id === "fn:target")!;
  assert.equal(target.degree, 2, "contains edges do not count toward degree");
  assert.equal(target.kind, "function");
  assert.equal(target.file, "src/domain/file.ts");
});

test("buildGraphPayload: maxNodes keeps highest-degree nodes and only edges among them", () => {
  const store = detailFixture();
  const payload = buildGraphPayload(store, 3);
  assert.equal(payload.truncated, true);
  assert.equal(payload.nodes.length, 3);
  // fn:target (degree 2) and the two callers (degree 1 each) win over mod:file (0).
  const ids = payload.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["fn:caller1", "fn:caller2", "fn:target"]);
  // The contains edge to the dropped mod:file must not leak into the payload.
  assert.ok(payload.edges.every((e) => ids.includes(e.from) && ids.includes(e.to)));
});

// ---------------------------------------------------------------------------
// buildNodeMemoriesPayload — FR-06/FR-12
// ---------------------------------------------------------------------------

test("buildNodeMemoriesPayload: node without anchors → empty array, not an error", () => {
  const store = new MockMemoryRepository();
  const verify: NodeVerifier = () => ({ exists: true, currentHash: null });
  assert.deepEqual(buildNodeMemoriesPayload(store, "fn:target", verify), { memories: [] });
});

test("buildNodeMemoriesPayload: active anchor → driftState usable, text combines title+content", () => {
  const store = new MockMemoryRepository();
  const { observation } = store.save({
    title: "Target caches results",
    content: "fn:target memoizes its output.",
    type: "architecture",
  });
  store.addAnchorsIfMissing(observation.id, [
    { nodeId: "fn:target", anchorFile: "src/domain/file.ts", anchorHash: "H1" },
  ]);
  const verify: NodeVerifier = () => ({ exists: true, currentHash: "H1" });
  const { memories } = buildNodeMemoriesPayload(store, "fn:target", verify, 10);

  assert.equal(memories.length, 1);
  assert.equal(memories[0]!.observationId, observation.id);
  assert.equal(memories[0]!.driftState, "usable");
  assert.equal(memories[0]!.text, "Target caches results\n\nfn:target memoizes its output.");
  assert.equal(memories[0]!.updatedAt, observation.updatedAt);
});

test("buildNodeMemoriesPayload: drifted anchor (unresolved) surfaces a warning driftState", () => {
  const store = new MockMemoryRepository();
  const { observation } = store.save({
    title: "Note",
    content: "unresolved anchor",
    type: "discovery",
  });
  store.addAnchorsIfMissing(observation.id, [{ nodeId: "fn:target" }]);
  const verify: NodeVerifier = () => ({ exists: true, currentHash: "H1" });
  const { memories } = buildNodeMemoriesPayload(store, "fn:target", verify);
  assert.equal(memories[0]!.driftState, "warning");
});

test("buildNodeMemoriesPayload: limit is forwarded to the store", () => {
  const store = new MockMemoryRepository();
  for (let i = 0; i < 3; i++) {
    const { observation } = store.save({ title: `T${i}`, content: `C${i}`, type: "discovery" });
    store.addAnchorsIfMissing(observation.id, [{ nodeId: "fn:target" }]);
  }
  const verify: NodeVerifier = () => ({ exists: true, currentHash: null });
  const { memories } = buildNodeMemoriesPayload(store, "fn:target", verify, 2);
  assert.equal(memories.length, 2);
});
