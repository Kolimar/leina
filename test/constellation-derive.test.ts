// constellation-derive.test.ts — FU#1: deriveConstellation reduces a merged workspace
// graph to (repoStats, crossEdges) for the workspace "constellation" visualize view.
//
// Cubre además:
//   GH-04 — pureza de renderConstellationHtml (dos llamadas → mismo output)
//   GH-04 — golden test graph-constellation.html

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveConstellation, renderConstellationHtml } from "../src/application/graph/html-export.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";
import { FAKE_VIS, assertGolden } from "./helpers/golden.ts";

function n(id: string, repo: string): GraphNode {
  return { id, label: id, fileType: "code", sourceFile: `${id}.ts`, kind: "function", repo };
}

function e(source: string, target: string, repo?: string): GraphEdge {
  return { source, target, relation: "calls", confidence: "EXTRACTED", sourceFile: "x.ts", weight: 1, repo };
}

test("(constellation) groups nodes per repo and isolates cross-repo edges", () => {
  const nodes: GraphNode[] = [n("a1", "a"), n("a2", "a"), n("b1", "b")];
  const edges: GraphEdge[] = [
    e("a1", "a2", "a"),   // intra-repo a
    e("a1", "b1", "a"),   // cross a -> b
    e("b1", "a2", "b"),   // cross b -> a
    e("a1", "ghost"),     // target not a node → skipped
  ];

  const { repoStats, crossEdges } = deriveConstellation(nodes, edges);

  assert.deepEqual(repoStats.get("a"), { nodeCount: 2, edgeCount: 1 });
  assert.deepEqual(repoStats.get("b"), { nodeCount: 1, edgeCount: 0 });

  assert.equal(crossEdges.length, 2, "only the two cross-repo edges are kept (ghost target skipped)");
  const pairs = crossEdges.map((c) => `${c.source}->${c.target}`).sort();
  assert.deepEqual(pairs, ["a->b", "b->a"]);
});

test("(constellation) nodes without a repo fall under 'unknown'", () => {
  const nodes: GraphNode[] = [
    { id: "x", label: "x", fileType: "code", sourceFile: "x.ts", kind: "function" },
  ];
  const { repoStats, crossEdges } = deriveConstellation(nodes, []);
  assert.deepEqual(repoStats.get("unknown"), { nodeCount: 1, edgeCount: 0 });
  assert.equal(crossEdges.length, 0);
});

// ── GH-04: pureza de renderConstellationHtml ──────────────────────────────────

test("(gh-04-purity) renderConstellationHtml: dos llamadas con mismos args → output idéntico", () => {
  const nodes: GraphNode[] = [n("a1", "repo-a"), n("a2", "repo-a"), n("b1", "repo-b")];
  const edges: GraphEdge[] = [
    e("a1", "b1", "repo-a"),  // cross a -> b
  ];
  const { repoStats, crossEdges } = deriveConstellation(nodes, edges);

  const r1 = renderConstellationHtml(repoStats, crossEdges, FAKE_VIS, { projectName: "P" });
  const r2 = renderConstellationHtml(repoStats, crossEdges, FAKE_VIS, { projectName: "P" });
  assert.equal(r1.content, r2.content, "renderConstellationHtml debe ser pura/idempotente");
});

// ── GH-04: Golden graph-constellation.html ──────────────────────────────────

test("(gh-04-golden) golden graph-constellation.html (GH-04)", () => {
  const nodes: GraphNode[] = [n("a1", "repo-a"), n("a2", "repo-a"), n("b1", "repo-b")];
  const edges: GraphEdge[] = [e("a1", "b1", "repo-a")];
  const { repoStats, crossEdges } = deriveConstellation(nodes, edges);
  const { content } = renderConstellationHtml(repoStats, crossEdges, FAKE_VIS, { projectName: "P" });
  assertGolden("graph-constellation.html", content);
});
