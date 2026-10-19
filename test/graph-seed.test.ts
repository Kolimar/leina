// graph-seed.test.ts — seed resolution for affected / path / impact (application/graph/seed.ts):
// exact-only matching, deterministic ranking, ambiguity alternatives and did-you-mean.
// Run: node --no-warnings --experimental-strip-types --test test/graph-seed.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";
import type { GraphRepository } from "../src/domain/graph/ports.ts";
import {
  ambiguityNote,
  noMatchMessage,
  resolutionInfo,
  resolveSeedQuery,
  selectorFor,
} from "../src/application/graph/seed.ts";
import { isTestLikePath } from "../src/application/graph/test-paths.ts";
import { MockGraphRepository } from "./mocks/graph.ts";

function node(id: string, label: string, sourceFile: string, over: Partial<GraphNode> = {}): GraphNode {
  return { id, label, fileType: "code", sourceFile, sourceLocation: "L1", kind: "function", ...over };
}
function edge(source: string, target: string, relation: string): GraphEdge {
  return { source, target, relation, confidence: "EXTRACTED", sourceFile: "x.ts", weight: 1 };
}

// A small graph with the collisions seed resolution has to settle:
//   - three `search()` methods (port, sqlite impl, test mock) + a `Search` class
//   - `checkGraph()` in doctor.ts, a module node per file
//   - `RelationCount` (substring bait for "Relation")
const NODES: GraphNode[] = [
  node("ports", "src/domain/ports.ts", "src/domain/ports.ts", { kind: "module", sourceLocation: undefined }),
  node("ports:repo", "MemoryRepository", "src/domain/ports.ts", { kind: "interface", sourceLocation: "L10" }),
  node("ports:repo:search", "search()", "src/domain/ports.ts", { kind: "method", sourceLocation: "L12" }),
  node("sqlite:repo", "SQLiteMemoryRepository", "src/infra/memory-repository.ts", { kind: "class", sourceLocation: "L5" }),
  node("sqlite:repo:search", "search()", "src/infra/memory-repository.ts", { kind: "method", sourceLocation: "L40" }),
  node("mock:repo", "MockMemoryRepository", "test/mocks/memory.ts", { kind: "class" }),
  node("mock:repo:search", "search()", "test/mocks/memory.ts", { kind: "method", sourceLocation: "L9" }),
  node("ui:search", "Search", "src/ui/search.ts", { kind: "class", sourceLocation: "L3" }),
  node("doctor", "src/cli/doctor.ts", "src/cli/doctor.ts", { kind: "module", sourceLocation: undefined }),
  node("doctor:checkgraph", "checkGraph()", "src/cli/doctor.ts", { sourceLocation: "L389" }),
  node("serve:relationcount", "RelationCount", "src/serve.ts", { kind: "interface", sourceLocation: "L26" }),
];
const EDGES: GraphEdge[] = [
  edge("ports:repo", "ports:repo:search", "method"),
  edge("sqlite:repo", "sqlite:repo:search", "method"),
  edge("mock:repo", "mock:repo:search", "method"),
  edge("doctor", "doctor:checkgraph", "contains"),
];

function withStore(fn: (store: GraphRepository) => void, nodes = NODES, edges = EDGES): void {
  const dir = mkdtempSync(join(tmpdir(), "graph-seed-"));
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

test("(seed-1) a raw node id resolves directly", () => {
  withStore((store) => {
    const res = resolveSeedQuery(store, "sqlite:repo:search");
    assert.equal(res.seed?.id, "sqlite:repo:search");
    assert.deepEqual(res.alternatives, []);
  });
});

test("(seed-2) an exact name matches a function label with or without ()", () => {
  withStore((store) => {
    assert.equal(resolveSeedQuery(store, "checkGraph").seed?.id, "doctor:checkgraph");
    assert.equal(resolveSeedQuery(store, "checkGraph()").seed?.id, "doctor:checkgraph");
    assert.equal(resolveSeedQuery(store, "checkgraph").seed?.id, "doctor:checkgraph", "case-insensitive still exact");
  });
});

test("(seed-3) ranking: case-sensitive > case-insensitive, then non-test > test, then kind, then path", () => {
  withStore((store) => {
    // "search" exactly equals the three search() methods; "Search" (class) only case-insensitively.
    const res = resolveSeedQuery(store, "search");
    assert.equal(res.seed?.id, "ports:repo:search", "case-exact, non-test, method, first path");
    assert.deepEqual(
      res.alternatives.map((c) => c.node.id),
      ["sqlite:repo:search", "mock:repo:search", "ui:search"],
      "test mock after production code; the case-insensitive class last",
    );
    // "Search" flips the case tier: the class is now the only case-exact match.
    assert.equal(resolveSeedQuery(store, "Search").seed?.id, "ui:search");
  });
});

test("(seed-4) kind rank: function/method/class > interface/type > other > module", () => {
  const nodes = [
    node("m", "thing", "src/a.ts", { kind: "module" }),
    node("c", "thing", "src/z.ts", { kind: "const" }),
    node("i", "thing", "src/b.ts", { kind: "interface" }),
    node("f", "thing()", "src/y.ts", { kind: "function" }),
  ];
  withStore((store) => {
    const res = resolveSeedQuery(store, "thing");
    assert.deepEqual([res.seed?.id, ...res.alternatives.map((c) => c.node.id)], ["f", "i", "c", "m"]);
  }, nodes, []);
});

test("(seed-5) Owner.member and Owner#member select a method through its owner (owner case-insensitive)", () => {
  withStore((store) => {
    assert.equal(resolveSeedQuery(store, "SQLiteMemoryRepository.search").seed?.id, "sqlite:repo:search");
    assert.equal(resolveSeedQuery(store, "SqliteMemoryRepository.search").seed?.id, "sqlite:repo:search");
    assert.equal(resolveSeedQuery(store, "MemoryRepository#search()").seed?.id, "ports:repo:search");
    assert.equal(resolveSeedQuery(store, "ns.MockMemoryRepository.search").seed?.id, "mock:repo:search", "innermost owner");
    assert.equal(resolveSeedQuery(store, "Nope.search").seed, null);
  });
});

test("(seed-6) <path>:<symbol> matches a /-aligned suffix of the node's file", () => {
  withStore((store) => {
    assert.equal(resolveSeedQuery(store, "src/cli/doctor.ts:checkGraph").seed?.id, "doctor:checkgraph");
    assert.equal(resolveSeedQuery(store, "doctor.ts:checkGraph").seed?.id, "doctor:checkgraph");
    assert.equal(resolveSeedQuery(store, "/abs/repo/src/cli/doctor.ts:checkGraph").seed?.id, "doctor:checkgraph", "absolute path");
    assert.equal(resolveSeedQuery(store, "ctor.ts:checkGraph").seed, null, "not segment-aligned");
    assert.equal(resolveSeedQuery(store, "memory-repository.ts:search").seed?.id, "sqlite:repo:search");
    assert.equal(resolveSeedQuery(store, "test/mocks/memory.ts:MockMemoryRepository.search").seed?.id, "mock:repo:search");
  });
});

test("(seed-7) a bare file path (or path suffix) selects the module node", () => {
  withStore((store) => {
    assert.equal(resolveSeedQuery(store, "src/cli/doctor.ts").seed?.id, "doctor", "exact module label");
    assert.equal(resolveSeedQuery(store, "cli/doctor.ts").seed?.id, "doctor", "suffix");
    assert.equal(resolveSeedQuery(store, "octor.ts").seed, null, "no substring");
  });
});

test("(seed-8) no silent substring fallback: a near-miss returns suggestions, not a node", () => {
  withStore((store) => {
    const res = resolveSeedQuery(store, "Relation");
    assert.equal(res.seed, null, "RelationCount must NOT be picked for Relation");
    assert.equal(res.suggestions[0]?.selector, "RelationCount");
    assert.equal(res.suggestions[0]?.at, "src/serve.ts:26");
    const msg = noMatchMessage(res);
    assert.match(msg, /^no exact match for "Relation"; did you mean:\n {2}RelationCount +src\/serve\.ts:26/);
    const typo = resolveSeedQuery(store, "checkGrap");
    assert.equal(typo.suggestions[0]?.node.id, "doctor:checkgraph", "edit-distance suggestion");
    assert.ok(resolveSeedQuery(store, "zzzqqq").suggestions.length === 0);
    assert.match(noMatchMessage(resolveSeedQuery(store, "zzzqqq")), /^no exact match for "zzzqqq" \(selectors:/);
  });
});

test("(seed-9) ambiguity: the note names the choice and a selector per alternative that resolves back uniquely", () => {
  withStore((store) => {
    const res = resolveSeedQuery(store, "search");
    const note = ambiguityNote(res);
    assert.ok(note);
    assert.match(note, /^note: "search" matches 4 nodes; using MemoryRepository\.search \(src\/domain\/ports\.ts:12\)/);
    assert.deepEqual(
      res.alternatives.map((c) => c.selector),
      ["SQLiteMemoryRepository.search", "MockMemoryRepository.search", "src/ui/search.ts:Search"],
    );
    for (const c of [res.chosen!, ...res.alternatives]) {
      assert.equal(resolveSeedQuery(store, c.selector).seed?.id, c.node.id, `${c.selector} round-trips`);
    }
    assert.equal(ambiguityNote(resolveSeedQuery(store, "checkGraph")), null, "unique → no note");
    const info = resolutionInfo(res);
    assert.equal(info.alternatives?.length, 3);
    assert.match(info.note ?? "", /matches 4 nodes/);
    assert.deepEqual(resolutionInfo(resolveSeedQuery(store, "checkGraph")), {});
  });
});

test("(seed-10) selectorFor falls back to path:name, then to the id, when shorter forms collide", () => {
  const nodes = [
    node("a:f", "f()", "src/a.ts"),
    node("b:f", "f()", "src/b.ts"),
    node("b:f2", "f()", "src/b.ts", { sourceLocation: "L9" }),
  ];
  withStore((store) => {
    assert.equal(selectorFor(store, nodes[0]!), "src/a.ts:f");
    assert.equal(selectorFor(store, nodes[1]!), "b:f", "same file + name twice → id");
  }, nodes, []);
});

test("(seed-11) resolution is deterministic regardless of insertion order", () => {
  withStore((store) => {
    const forward = resolveSeedQuery(store, "search");
    withStore((reversed) => {
      const back = resolveSeedQuery(reversed, "search");
      assert.equal(back.seed?.id, forward.seed?.id);
      assert.deepEqual(back.alternatives.map((c) => c.node.id), forward.alternatives.map((c) => c.node.id));
    }, [...NODES].reverse(), [...EDGES].reverse());
  });
});

test("(seed-12) a port without findByLabelExact (overlays, mocks) resolves the same via allNodes", () => {
  const mock = new MockGraphRepository();
  mock.addNodes(NODES);
  mock.addEdges(EDGES);
  withStore((store) => {
    for (const q of ["search", "Search", "SqliteMemoryRepository.search", "doctor.ts:checkGraph", "Relation"]) {
      const a = resolveSeedQuery(store, q);
      const b = resolveSeedQuery(mock, q);
      assert.equal(b.seed?.id, a.seed?.id, q);
      assert.deepEqual(b.alternatives.map((c) => c.selector), a.alternatives.map((c) => c.selector), q);
    }
  });
});

test("(seed-13) GraphStore.findByLabelExact: case-insensitive exact, several spellings, no substring", () => {
  withStore((store) => {
    const gs = store as GraphStore;
    assert.deepEqual(gs.findByLabelExact(["CHECKGRAPH()"]).map((n) => n.id), ["doctor:checkgraph"]);
    assert.deepEqual(gs.findByLabelExact(["search", "search()"]).map((n) => n.id).sort(),
      ["mock:repo:search", "ports:repo:search", "sqlite:repo:search", "ui:search"]);
    assert.deepEqual(gs.findByLabelExact(["Relation"]), []);
  });
});

test("(seed-14) isTestLikePath: test dirs, mocks, fixtures and test file names; not lookalikes", () => {
  for (const p of ["test/a.ts", "src/__tests__/a.ts", "test/mocks/memory.ts", "pkg/mock/x.go", "x/fixtures/y.ts",
    "src/a.test.ts", "src/a.spec.js", "pkg/a_test.go", "tests/test_a.py", "C:\\repo\\test\\a.ts"]) {
    assert.ok(isTestLikePath(p), p);
  }
  for (const p of ["src/testing-utils.ts", "src/contest.ts", "src/latest/a.ts", "src/attest.ts", "src/mocked.ts"]) {
    assert.ok(!isTestLikePath(p), p);
  }
});
