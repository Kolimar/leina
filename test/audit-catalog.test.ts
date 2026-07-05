// audit-catalog.test.ts — unit tests for buildCatalog
// Covers: single-repo (no repo field), multi-repo grouping, cross-repo edges,
// totals, empty graph.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { buildCatalog } from "../src/application/audit/catalog.ts";
import type { GraphNode, GraphEdge } from "../src/domain/graph/model.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "audit-catalog-"));
}

function makeNode(id: string, repo?: string): GraphNode {
  return { id, label: id, fileType: "code", kind: "function", sourceFile: "src/x.ts", ...(repo ? { repo } : {}) };
}

function makeEdge(source: string, target: string, repo?: string): GraphEdge {
  return { source, target, relation: "calls", confidence: "EXTRACTED", sourceFile: "src/x.ts", weight: 1, ...(repo ? { repo } : {}) };
}

// ---------------------------------------------------------------------------
// Empty graph
// ---------------------------------------------------------------------------

test("(cat-empty) empty graph → empty catalog", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      const cat = buildCatalog(store);
      assert.equal(cat.totalNodes, 0);
      assert.equal(cat.totalEdges, 0);
      assert.equal(cat.repos.length, 0);
      assert.equal(cat.crossEdges.length, 0);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Single-repo (no repo field)
// ---------------------------------------------------------------------------

test("(cat-single) nodes without repo → grouped under ''", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([makeNode("fn-a"), makeNode("fn-b")]);
      store.addEdges([makeEdge("fn-a", "fn-b")]);
      const cat = buildCatalog(store);
      assert.equal(cat.totalNodes, 2);
      assert.equal(cat.totalEdges, 1);
      assert.equal(cat.repos.length, 1);
      assert.equal(cat.repos[0]!.repoKey, "");
      assert.equal(cat.repos[0]!.nodes.length, 2);
      assert.equal(cat.crossEdges.length, 0, "no cross edges in single repo");
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Multi-repo grouping
// ---------------------------------------------------------------------------

test("(cat-multi) nodes grouped by repo field", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([
        makeNode("svc-a::fn1", "svc-a"),
        makeNode("svc-a::fn2", "svc-a"),
        makeNode("svc-b::fn1", "svc-b"),
      ]);
      const cat = buildCatalog(store);
      assert.equal(cat.totalNodes, 3);
      const repoKeys = cat.repos.map((r) => r.repoKey).sort();
      assert.deepEqual(repoKeys, ["svc-a", "svc-b"]);
      const repoA = cat.repos.find((r) => r.repoKey === "svc-a")!;
      assert.equal(repoA.nodes.length, 2);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Cross-repo edges
// ---------------------------------------------------------------------------

test("(cat-cross) cross-repo edges detected", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([makeNode("svc-a::fn1", "svc-a"), makeNode("svc-b::fn2", "svc-b")]);
      // Edge from svc-a to svc-b → cross-repo
      store.addEdges([makeEdge("svc-a::fn1", "svc-b::fn2", "svc-a")]);
      const cat = buildCatalog(store);
      assert.equal(cat.crossEdges.length, 1);
      assert.equal(cat.crossEdges[0]!.source, "svc-a::fn1");
      assert.equal(cat.crossEdges[0]!.target, "svc-b::fn2");
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Intra-repo edges are NOT cross-repo
// ---------------------------------------------------------------------------

test("(cat-intra) intra-repo edges not counted as cross-repo", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([makeNode("svc-a::fn1", "svc-a"), makeNode("svc-a::fn2", "svc-a")]);
      store.addEdges([makeEdge("svc-a::fn1", "svc-a::fn2", "svc-a")]);
      const cat = buildCatalog(store);
      assert.equal(cat.crossEdges.length, 0);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
