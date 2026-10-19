// graph-affected-contracts.test.ts — `affected` across interface → implementation and
// base → override (member-level `implements` / `overrides` edges, impl → contract).
// Run: node --no-warnings --experimental-strip-types --test test/graph-affected-contracts.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";
import { affected, type AffectedHit } from "../src/application/graph/query.ts";
import { analyzeImpact } from "../src/application/graph/impact.ts";

function node(id: string, kind: string, sourceFile = `src/${id}.ts`): GraphNode {
  const label = kind === "method" || kind === "function" ? `${id.split(".").at(-1)}()` : id;
  return { id, label, fileType: "code", sourceFile, sourceLocation: "L1", kind };
}
function edge(source: string, target: string, relation: string, over: Partial<GraphEdge> = {}): GraphEdge {
  return { source, target, relation, confidence: "EXTRACTED", sourceFile: `src/${source}.ts`, sourceLocation: "L9", weight: 1, ...over };
}

// Port.search is the interface member; SqliteRepo.search and MockRepo.search implement it.
// searchMemory() and memSearch() call the PORT (typed against the interface); a test
// calls SqliteRepo.search directly; cliMain calls searchMemory.
const NODES: GraphNode[] = [
  node("Port", "interface"), node("Port.search", "method"),
  node("SqliteRepo", "class"), node("SqliteRepo.search", "method"),
  node("MockRepo", "class", "test/mocks/repo.ts"), node("MockRepo.search", "method", "test/mocks/repo.ts"),
  node("searchMemory", "function"), node("memSearch", "function"), node("cliMain", "function"),
  node("repoTest", "module", "test/repo.test.ts"),
  node("wiring", "function"),
];
const EDGES: GraphEdge[] = [
  edge("Port", "Port.search", "method"),
  edge("SqliteRepo", "SqliteRepo.search", "method"),
  edge("MockRepo", "MockRepo.search", "method"),
  edge("SqliteRepo", "Port", "implements"), // class-level: must NOT lift
  edge("MockRepo", "Port", "implements"),
  edge("SqliteRepo.search", "Port.search", "implements"),
  edge("MockRepo.search", "Port.search", "implements"),
  edge("searchMemory", "Port.search", "calls", { sourceLocation: "L19" }),
  edge("memSearch", "Port.search", "calls", { sourceLocation: "L177" }),
  edge("cliMain", "searchMemory", "calls"),
  edge("repoTest", "SqliteRepo.search", "calls", { sourceFile: "test/repo.test.ts", sourceLocation: "L40" }),
  edge("wiring", "Port", "references"), // a type reference to the interface
];

function withGraph(fn: (store: GraphStore) => void, nodes = NODES, edges = EDGES): void {
  const dir = mkdtempSync(join(tmpdir(), "graph-contracts-"));
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

const byId = (hits: AffectedHit[]): Map<string, AffectedHit> => new Map(hits.map((h) => [h.node.id, h]));

test("(contract-1) affected(Impl.method) includes the callers of the interface member it implements, via it", () => {
  withGraph((store) => {
    const hits = byId(affected(store, "SqliteRepo.search", 3));
    assert.equal(hits.get("repoTest")?.via, undefined, "direct caller: no via");
    for (const id of ["searchMemory", "memSearch"]) {
      const h = hits.get(id);
      assert.ok(h, `${id} reached through Port.search`);
      assert.equal(h.depth, 1, "port callers count as direct dependents");
      assert.equal(h.viaRelation, "calls");
      assert.equal(h.via?.id, "Port.search");
      assert.equal(h.target, "Port.search");
    }
    assert.equal(hits.get("searchMemory")?.site, "src/searchMemory.ts:19");
    assert.equal(hits.get("cliMain")?.depth, 2, "the walk continues from lifted callers");
    assert.ok(!hits.has("MockRepo.search"), "a sibling implementation is not a dependent");
    assert.ok(!hits.has("Port.search"), "the contract itself is not reported as a dependent");
    assert.ok(!hits.has("wiring"), "class-level implements does not lift type references");
  });
});

test("(contract-2) affected(Interface.member) includes its implementations, then their own callers", () => {
  withGraph((store) => {
    const hits = byId(affected(store, "Port.search", 3));
    assert.equal(hits.get("SqliteRepo.search")?.viaRelation, "implements");
    assert.equal(hits.get("MockRepo.search")?.viaRelation, "implements");
    assert.equal(hits.get("SqliteRepo.search")?.depth, 1);
    assert.equal(hits.get("searchMemory")?.depth, 1);
    assert.equal(hits.get("repoTest")?.depth, 2, "a direct caller of an implementation is impacted too");
    assert.equal(hits.get("searchMemory")?.via, undefined, "direct callers of the seed carry no via");
  });
});

test("(contract-3) overrides chains lift transitively: Sub.m → Base.m → Port.m", () => {
  const nodes = [
    node("Port.m", "method"), node("Base.m", "method"), node("Sub.m", "method"),
    node("usesPort", "function"), node("usesBase", "function"), node("usesSub", "function"),
  ];
  const edges = [
    edge("Base.m", "Port.m", "implements"),
    edge("Sub.m", "Base.m", "overrides"),
    edge("usesPort", "Port.m", "calls"),
    edge("usesBase", "Base.m", "calls"),
    edge("usesSub", "Sub.m", "calls"),
  ];
  withGraph((store) => {
    const hits = byId(affected(store, "Sub.m", 1));
    assert.deepEqual([...hits.keys()].sort(), ["usesBase", "usesPort", "usesSub"]);
    assert.equal(hits.get("usesBase")?.via?.id, "Base.m");
    assert.equal(hits.get("usesPort")?.via?.id, "Port.m");
    // From the base, the override is impacted (overrides propagates like implements).
    const fromBase = byId(affected(store, "Base.m", 1));
    assert.equal(fromBase.get("Sub.m")?.viaRelation, "overrides");
  }, nodes, edges);
});

test("(contract-4) a guessed (AMBIGUOUS) implements edge does not lift", () => {
  const nodes = [node("Port.m", "method"), node("Impl.m", "method"), node("caller", "function")];
  const edges = [
    edge("Impl.m", "Port.m", "implements", { confidence: "AMBIGUOUS" }),
    edge("caller", "Port.m", "calls"),
  ];
  withGraph((store) => {
    assert.deepEqual(affected(store, "Impl.m", 3), []);
  }, nodes, edges);
});

test("(contract-5) a file seed lifts its members too, and depth 1 already includes lifted callers", () => {
  const nodes = [...NODES, node("sqliteFile", "module", "src/sqlite.ts")];
  const edges = [...EDGES, edge("sqliteFile", "SqliteRepo", "contains"), edge("sqliteFile", "SqliteRepo.search", "contains")];
  withGraph((store) => {
    const ids = affected(store, "sqliteFile", 1).map((h) => h.node.id).sort();
    assert.ok(ids.includes("searchMemory") && ids.includes("memSearch"), ids.join(","));
  }, nodes, edges);
});

test("(contract-6) impact analyze reaches the interface callers through the implements edge", () => {
  withGraph((store) => {
    const files = analyzeImpact(store, "SqliteRepo.search", 2).impacted.files;
    assert.ok(files.includes("src/searchMemory.ts"), files.join(","));
  });
});
