// html-export-builders.test.ts — unit tests for the pure builders newly exported from
// src/application/graph/html-export.ts (graph-serve task 3.1: buildVisNodes, buildVisEdges,
// nodeDetail, buildGroupCounts). Kept in a SEPARATE file from html-export.test.ts on
// purpose — that file's expectations must stay unchanged (byte-compat regression guard,
// FR-16), this one only exercises the newly-exported symbols directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVisNodes,
  buildVisEdges,
  nodeDetail,
  buildGroupCounts,
} from "../src/application/graph/html-export.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";

function node(over: Partial<GraphNode> & { id: string; label: string; sourceFile: string }): GraphNode {
  return { fileType: "code", ...over };
}

test("buildVisNodes: shows label for god nodes and modules, hides it otherwise", () => {
  const godFn = node({ id: "fn:god", label: "GodFn", sourceFile: "src/domain/a.ts", kind: "function" });
  const plainFn = node({ id: "fn:plain", label: "PlainFn", sourceFile: "src/domain/b.ts", kind: "function" });
  const mod = node({ id: "mod:c", label: "src/domain/c.ts", sourceFile: "src/domain/c.ts", kind: "module" });

  const nodes = buildVisNodes([godFn, plainFn, mod], new Map(), new Set(["fn:god"])) as {
    id: string;
    label?: string;
    group: string;
  }[];

  assert.equal(nodes.find((n) => n.id === "fn:god")!.label, "GodFn");
  assert.equal(nodes.find((n) => n.id === "fn:plain")!.label, undefined);
  assert.equal(nodes.find((n) => n.id === "mod:c")!.label, "c.ts", "module label is basename'd");
  assert.equal(nodes.find((n) => n.id === "fn:god")!.group, "domain");
});

test("buildVisEdges: dashes:true only for INFERRED confidence", () => {
  const edges: GraphEdge[] = [
    { source: "a", target: "b", relation: "calls", confidence: "INFERRED", sourceFile: "x", weight: 1 },
    { source: "a", target: "c", relation: "calls", confidence: "EXTRACTED", sourceFile: "x", weight: 1 },
  ];
  const built = buildVisEdges(edges) as { dashes: boolean }[];
  assert.equal(built[0]!.dashes, true);
  assert.equal(built[1]!.dashes, false);
});

test("nodeDetail: escapes label/file, includes degree and layer", () => {
  const n = node({
    id: "fn:a",
    label: "<script>",
    sourceFile: "src/domain/a.ts",
    kind: "function",
    community: 2,
  });
  const d = nodeDetail(n, 5);
  assert.equal(d.label, "&lt;script&gt;");
  assert.equal(d.kind, "function");
  assert.equal(d.layer, "domain");
  assert.equal(d.community, 2);
  assert.equal(d.degree, 5);
  assert.ok(String(d.file).startsWith("src/domain/a.ts"));
});

test("nodeDetail: no signature → empty sig string", () => {
  const n = node({ id: "fn:a", label: "A", sourceFile: "src/domain/a.ts", kind: "function" });
  const d = nodeDetail(n, 0);
  assert.equal(d.sig, "");
});

test("buildGroupCounts: counts nodes per top-level folder/layer", () => {
  const nodes = [
    node({ id: "1", label: "a", sourceFile: "src/domain/a.ts" }),
    node({ id: "2", label: "b", sourceFile: "src/domain/b.ts" }),
    node({ id: "3", label: "c", sourceFile: "src/application/c.ts" }),
  ];
  const counts = buildGroupCounts(nodes);
  assert.deepEqual(counts, { domain: 2, application: 1 });
});
