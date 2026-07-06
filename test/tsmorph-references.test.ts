// Type + value reference-edge tests for the ts-morph semantic extractor
// (sdd/tsmorph-reference-edges). Covers REQ-TR-1, REQ-VR-1, REQ-NR-1..5.
//
// Run standalone: node --no-warnings --experimental-strip-types --test test/tsmorph-references.test.ts
// Also picked up by: npm test (glob test/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractTsProject } from "../src/infrastructure/extractors/semantic/tsmorph.ts";
import type { GraphEdge } from "../src/domain/graph/model.ts";

// ---------------------------------------------------------------------------
// Shared extraction — run once at module scope, shared across all test cases.
// ---------------------------------------------------------------------------

const fixtureDir = join(import.meta.dirname, "fixtures", "tsmorph-refs");

const { edges } = extractTsProject(fixtureDir, [
  join(fixtureDir, "decls.ts"),
  join(fixtureDir, "refs.ts"),
]);

// ---------------------------------------------------------------------------
// Expected node IDs (makeId normalises path + name -> lowercase + underscores)
// ---------------------------------------------------------------------------

const DECLS = "decls_ts";
const GRAPH_NODE = "decls_ts:graphnode";
const GRAPH_EDGE = "decls_ts:graphedge";
const BASE = "decls_ts:base";
const IBASE = "decls_ts:ibase";
const TARGET = "decls_ts:target";
const TARGET_RUN = "decls_ts_target:run";
const BUILD_GRAPH = "decls_ts:buildgraph";
const MY_HANDLER = "decls_ts:myhandler";
const REGISTER_HANDLER = "decls_ts:registerhandler";
const UNUSED_EXPORT = "decls_ts:unusedexport";
const RECURSIVE_NODE = "decls_ts:recursivenode";

const REFS = "refs_ts";
const USE_NODE = "refs_ts:usenode";
const USE_MAP = "refs_ts:usemap";
const USE_PRIMITIVE = "refs_ts:useprimitive";
const USE_TARGET = "refs_ts:usetarget";
const DERIVED = "refs_ts:derived";
const USE_NAMESPACE_MEMBER = "refs_ts:usenamespacemember";
const WRAP = "refs_ts:wrap";

function hasEdge(relation: GraphEdge["relation"], src: string, tgt: string): boolean {
  return edges.some(
    (e) => e.relation === relation && e.source === src && e.target === tgt && e.confidence === "EXTRACTED",
  );
}

function countEdges(relation: GraphEdge["relation"], src: string, tgt: string): number {
  return edges.filter((e) => e.relation === relation && e.source === src && e.target === tgt).length;
}

function edgesInfo(): string {
  return JSON.stringify(edges, null, 2);
}

// ---------------------------------------------------------------------------
// REQ-TR-1 — TypeReference walk
// ---------------------------------------------------------------------------

test("(tr-param-return) parameter + return type annotations -> references", () => {
  assert.ok(hasEdge("references", USE_NODE, GRAPH_NODE), `esperado ${USE_NODE} -references-> ${GRAPH_NODE}\n${edgesInfo()}`);
  assert.ok(hasEdge("references", USE_NODE, GRAPH_EDGE), `esperado ${USE_NODE} -references-> ${GRAPH_EDGE}\n${edgesInfo()}`);
});

test("(tr-generic-nested) nested generic type-arg (Map<string, GraphNode>) resolves inner type", () => {
  assert.ok(hasEdge("references", USE_MAP, GRAPH_NODE), `esperado ${USE_MAP} -references-> ${GRAPH_NODE}\n${edgesInfo()}`);
});

test("(tr-negative-primitive) primitive types do not resolve to a registered decl", () => {
  const spurious = edges.filter((e) => e.relation === "references" && e.source === USE_PRIMITIVE);
  assert.strictEqual(spurious.length, 0, `no se esperaban references desde ${USE_PRIMITIVE}\n${JSON.stringify(spurious, null, 2)}`);
});

// ---------------------------------------------------------------------------
// REQ-VR-1 — value-position Identifier walk
// ---------------------------------------------------------------------------

test("(vr-object-literal-value) symbol referenced as a value (not called) inside an object literal", () => {
  assert.ok(hasEdge("references", REFS, BUILD_GRAPH), `esperado ${REFS} -references-> ${BUILD_GRAPH}\n${edgesInfo()}`);
});

test("(vr-argument) symbol passed as an argument (not the callee itself)", () => {
  assert.ok(hasEdge("references", REFS, MY_HANDLER), `esperado ${REFS} -references-> ${MY_HANDLER}\n${edgesInfo()}`);
  // The call itself still produces its own `calls` edge, unaffected.
  assert.ok(hasEdge("calls", REFS, REGISTER_HANDLER), `esperado ${REFS} -calls-> ${REGISTER_HANDLER}\n${edgesInfo()}`);
});

test("(vr-negative-unregistered-local) exact references edge set — no spurious extras from local unregistered identifiers", () => {
  // `n`, `x`, `t` are local params/vars, never registered in declToId, so they
  // can never surface as edge participants. Assert the FULL references set
  // matches exactly the 8 edges intended by the fixture (no more, no less) —
  // stronger than checking absence one-by-one.
  const refEdges = edges
    .filter((e) => e.relation === "references")
    .map((e) => `${e.source}->${e.target}@${e.sourceLocation}`)
    .sort();
  const expected = [
    `${USE_TARGET}->${TARGET}@L37`,
    `${USE_NODE}->${GRAPH_NODE}@L10`,
    `${USE_NODE}->${GRAPH_EDGE}@L10`,
    `${USE_MAP}->${GRAPH_NODE}@L16`,
    `${WRAP}->${RECURSIVE_NODE}@L58`,
    `${REFS}->${BUILD_GRAPH}@L28`,
    `${REFS}->${MY_HANDLER}@L32`,
    `${USE_NAMESPACE_MEMBER}->${DECLS}@L52`,
  ].sort();
  assert.deepStrictEqual(refEdges, expected, `conjunto de references inesperado\n${edgesInfo()}`);
});

// ---------------------------------------------------------------------------
// REQ-NR-1..5 — anti-duplication (negative scenarios)
// ---------------------------------------------------------------------------

test("(nr1-callee-not-duplicated) callee of Call/New produces exactly one edge, not an extra references", () => {
  // `new Target()` already produces its own `references` edge via linkCallEdges
  // (NewExpression branch) — the value walk must not add a second one to the
  // same (source, target) pair.
  assert.strictEqual(countEdges("references", USE_TARGET, TARGET), 1, `esperado exactamente 1 references ${USE_TARGET}->${TARGET}\n${edgesInfo()}`);
  // `t.run()` — the callee is excluded from the value walk too.
  assert.strictEqual(countEdges("references", USE_TARGET, TARGET_RUN), 0, `no se esperaba references ${USE_TARGET}->${TARGET_RUN}\n${edgesInfo()}`);
  assert.ok(hasEdge("calls", USE_TARGET, TARGET_RUN), `esperado ${USE_TARGET} -calls-> ${TARGET_RUN}\n${edgesInfo()}`);
});

test("(nr2-heritage-not-duplicated) class extends/implements identifiers do not duplicate as references", () => {
  assert.ok(hasEdge("extends", DERIVED, BASE), `esperado ${DERIVED} -extends-> ${BASE}\n${edgesInfo()}`);
  assert.ok(hasEdge("implements", DERIVED, IBASE), `esperado ${DERIVED} -implements-> ${IBASE}\n${edgesInfo()}`);
  assert.strictEqual(countEdges("references", DERIVED, BASE), 0, `no se esperaba references ${DERIVED}->${BASE}\n${edgesInfo()}`);
  assert.strictEqual(countEdges("references", DERIVED, IBASE), 0, `no se esperaba references ${DERIVED}->${IBASE}\n${edgesInfo()}`);
});

test("(nr3-import-specifier-unused) an unused ImportSpecifier binding does not generate a references edge", () => {
  const anyRefToUnused = edges.some((e) => e.relation === "references" && e.target === UNUSED_EXPORT);
  assert.ok(!anyRefToUnused, `no se esperaba ninguna references hacia ${UNUSED_EXPORT}\n${edgesInfo()}`);
});

test("(nr4-property-access-name-node) namespace-qualified call's name-node does not duplicate the calls edge", () => {
  assert.ok(hasEdge("calls", USE_NAMESPACE_MEMBER, BUILD_GRAPH), `esperado ${USE_NAMESPACE_MEMBER} -calls-> ${BUILD_GRAPH}\n${edgesInfo()}`);
  assert.strictEqual(
    countEdges("references", USE_NAMESPACE_MEMBER, BUILD_GRAPH),
    0,
    `no se esperaba references adicional ${USE_NAMESPACE_MEMBER}->${BUILD_GRAPH} (name-node debe excluirse)\n${edgesInfo()}`,
  );
  // The namespace object identifier itself is a legitimate, distinct reference
  // to the module (not to buildGraph).
  assert.ok(hasEdge("references", USE_NAMESPACE_MEMBER, DECLS), `esperado ${USE_NAMESPACE_MEMBER} -references-> ${DECLS}\n${edgesInfo()}`);
});

test("(nr5-no-self-loop) a self-referencing interface does not produce a self-loop", () => {
  const selfLoop = edges.some((e) => e.relation === "references" && e.source === RECURSIVE_NODE && e.target === RECURSIVE_NODE);
  assert.ok(!selfLoop, `no se esperaba self-loop en ${RECURSIVE_NODE}\n${edgesInfo()}`);
  // Referencing the recursive type from elsewhere still works normally.
  assert.ok(hasEdge("references", WRAP, RECURSIVE_NODE), `esperado ${WRAP} -references-> ${RECURSIVE_NODE}\n${edgesInfo()}`);
});

// ---------------------------------------------------------------------------
// Stable counts — calls/extends/implements unaffected by the new walks (REQ-NF-1/2)
// ---------------------------------------------------------------------------

test("(stable-counts) calls/extends/implements counts unaffected by the new reference walks", () => {
  const byRelation: Record<string, number> = {};
  for (const e of edges) byRelation[e.relation] = (byRelation[e.relation] ?? 0) + 1;
  assert.strictEqual(byRelation.calls, 3, `calls: esperado=3 actual=${byRelation.calls}\n${JSON.stringify(byRelation)}`);
  assert.strictEqual(byRelation.extends, 1, `extends: esperado=1 actual=${byRelation.extends}\n${JSON.stringify(byRelation)}`);
  assert.strictEqual(byRelation.implements, 1, `implements: esperado=1 actual=${byRelation.implements}\n${JSON.stringify(byRelation)}`);
});

// ---------------------------------------------------------------------------
// REQ-NF-2 — determinism: two runs over the same fixture yield the same multiset
// ---------------------------------------------------------------------------

test("(determinism) two extractTsProject runs over the same fixture produce identical edge multisets", () => {
  const run2 = extractTsProject(fixtureDir, [
    join(fixtureDir, "decls.ts"),
    join(fixtureDir, "refs.ts"),
  ]);
  const norm = (es: GraphEdge[]): string[] =>
    es
      .map((e) => `${e.source}\0${e.target}\0${e.relation}\0${e.confidence}\0${e.sourceLocation}`)
      .sort();
  assert.deepStrictEqual(norm(run2.edges), norm(edges), "las dos corridas deben producir el mismo multiset de aristas");
});
