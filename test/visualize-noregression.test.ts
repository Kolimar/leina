// visualize-noregression.test.ts — FR-16 byte-compat regression guard for `graph visualize`.
//
// Context: graph-serve task 3.1 extracted the pure builders (`buildVisNodes`, `buildVisEdges`,
// `nodeDetail`, `buildGroupCounts`) OUT of `html-export.ts` so `serve-payloads.ts` could reuse
// them, WITHOUT touching `renderGraphHtml` or `html-export.test.ts` (design §4, tasks 3.1/5.1).
// `html-export.test.ts`'s `(he-golden-single)`/`(he-golden-drilldown)` tests already prove the
// rendered HTML is byte-identical to the pre-refactor golden fixtures — that is the primary
// FR-16 evidence and it required ZERO changes across olas 3-5.
//
// What was still MISSING (the gap this file closes): nothing cross-checked that the JSON
// embedded in `renderGraphHtml`'s output is actually PRODUCED BY the same extracted builder
// functions that `html-export-builders.test.ts` (task 3.1) and `serve-payloads.ts` (the new
// `/api/.../stats`, `/nodes/:id` endpoints) also call. The golden tests alone would only catch a
// future divergence if it also changed the rendered bytes for THIS fixture — they would not
// prove the two code paths (offline HTML export vs. live JSON API) stayed wired to the same
// pure logic. This file makes that link explicit: it parses the `DATA`/`META` blobs back out of
// `renderGraphHtml`'s HTML and deep-equals them against calling `buildVisNodes`/`buildVisEdges`/
// `buildGroupCounts` directly — so a future edit that re-inlines divergent logic into
// `renderGraphHtml` fails here even if it happens to keep this fixture's bytes unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderGraphHtml,
  buildVisNodes,
  buildVisEdges,
  buildGroupCounts,
} from "../src/application/graph/html-export.ts";
import type { NodeLinkGraph } from "../src/domain/graph/model.ts";
import { FAKE_VIS } from "./helpers/golden.ts";

/** Extracts and JSON.parses the `DATA`/`META` blobs embedded by `htmlTemplate()`. */
function extractEmbedded(html: string): { data: unknown; meta: unknown } {
  const dataMatch = /const DATA = (\{.*?\});\n/s.exec(html);
  const metaMatch = /const META = (\{.*?\});\n/s.exec(html);
  assert.ok(dataMatch, "expected `const DATA = {...};` in rendered HTML");
  assert.ok(metaMatch, "expected `const META = {...};` in rendered HTML");
  return { data: JSON.parse(dataMatch[1]!), meta: JSON.parse(metaMatch[1]!) };
}

// No-edge fixture: buildVisNodes' degree/god-node params (`degreeMap`, `godNodeIds`) come from
// an internal (non-exported) `buildDegreeMap()` over the graph's edges. With zero edges that map
// is trivially empty, so calling `buildVisNodes(nodes, new Map(), new Set())` directly reproduces
// exactly what `renderGraphHtml` computes internally for this fixture — letting us assert node
// equality without re-implementing the (intentionally private) degree/god-node derivation.
function makeNodeOnlyGraph(): NodeLinkGraph {
  return {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      { id: "fn:a", label: "NodeA", fileType: "code", sourceFile: "src/domain/a.ts", kind: "function" },
      { id: "mod:b", label: "b.ts", fileType: "code", sourceFile: "src/application/b.ts", kind: "module" },
      { id: "cls:c", label: "NodeC", fileType: "code", sourceFile: "src/infrastructure/c.ts", kind: "class" },
    ],
    links: [],
  };
}

function makeEdgedGraph(): NodeLinkGraph {
  const g = makeNodeOnlyGraph();
  return {
    ...g,
    links: [
      { source: "fn:a", target: "mod:b", relation: "imports", confidence: "EXTRACTED", sourceFile: "src/domain/a.ts", weight: 1 },
      { source: "fn:a", target: "cls:c", relation: "calls", confidence: "INFERRED", sourceFile: "src/domain/a.ts", weight: 1 },
    ],
  };
}

// `renderGraphHtml` embeds via `JSON.stringify`, which drops `undefined`-valued keys (e.g. an
// unlabeled node's `label`). Round-tripping the directly-called builder's output through
// JSON the same way keeps this a fair byte-shape comparison rather than an artifact of
// `undefined` object keys vs. absent keys.
function roundTripJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("(vn-1) renderGraphHtml's embedded nodes are literally buildVisNodes' output, not a re-inlined copy", () => {
  const g = makeNodeOnlyGraph();
  const { content } = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  const { data } = extractEmbedded(content);

  const expectedNodes = buildVisNodes(g.nodes, new Map(), new Set());
  assert.deepEqual((data as { nodes: unknown }).nodes, roundTripJson(expectedNodes));
});

test("(vn-2) renderGraphHtml's embedded edges are literally buildVisEdges' output", () => {
  const g = makeEdgedGraph();
  const { content } = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  const { data } = extractEmbedded(content);

  const expectedEdges = buildVisEdges(g.links);
  assert.deepEqual((data as { edges: unknown }).edges, roundTripJson(expectedEdges));
});

test("(vn-3) renderGraphHtml's embedded layer counts are literally buildGroupCounts' output", () => {
  const g = makeEdgedGraph();
  const { content } = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  const { meta } = extractEmbedded(content);

  const expectedCounts = buildGroupCounts(g.nodes);
  assert.deepEqual((meta as { layers: unknown }).layers, expectedCounts);
});

test("(vn-4) FR-16 parity: same project, two consecutive renders → byte-identical HTML", () => {
  // Same intent as html-export.test.ts's (he-1) purity check, but exercised here again as an
  // explicit FR-16 regression marker scoped to Phase 5's closure of the graph-serve change —
  // "GIVEN the same project WHEN run before/after THEN node/edge parity in the HTML".
  const g = makeEdgedGraph();
  const r1 = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  const r2 = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  assert.equal(r1.content, r2.content);
});
