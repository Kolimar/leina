// Graph-shape tests for the ts-morph extractor over test/fixtures/tsmorph-graph:
// id disambiguation for colliding declarations, plus the node kinds and relations the
// later fixture files exercise. Assertions name exact edges (source, target, relation,
// line) so a regression shows up as a precise diff.
//
// Run standalone: node --no-warnings --experimental-strip-types --test test/tsmorph-graph.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { extractTsProject } from "../src/infrastructure/extractors/semantic/tsmorph.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";

const fixtureDir = join(import.meta.dirname, "fixtures", "tsmorph-graph");
const files = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => join(fixtureDir, f));

const { nodes, edges } = extractTsProject(fixtureDir, files);

const fmt = (e: GraphEdge): string => `${e.source} -${e.relation}-> ${e.target} @${e.sourceLocation}`;

/** Every edge leaving `source` (any relation in `relations`), formatted and sorted, deduped. */
function edgesFrom(source: string, relations?: string[]): string[] {
  return [
    ...new Set(
      edges.filter((e) => e.source === source && (!relations || relations.includes(e.relation))).map(fmt),
    ),
  ].sort();
}

function node(id: string): GraphNode {
  const n = nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id} missing; ids:\n${nodes.map((x) => x.id).join("\n")}`);
  return n;
}

function nodesOf(file: string): string[] {
  return nodes
    .filter((n) => n.sourceFile === file)
    .map((n) => `${n.kind}:${n.id}`)
    .sort();
}

// ---------------------------------------------------------------------------
// B3 — colliding ids are disambiguated, non-colliding ids stay as they were
// ---------------------------------------------------------------------------

const COLL = "collisions_ts";

test("(b3-distinct-nodes) case-colliding declarations get distinct nodes; first registered keeps the plain id", () => {
  assert.deepStrictEqual(nodesOf("collisions.ts"), [
    `class:${COLL}:factory`,
    `class:${COLL}:parser`,
    `function:${COLL}:hostspec:function`,
    `function:${COLL}:parser:function`,
    `interface:${COLL}:hostspec`,
    `method:${COLL}_factory:create`,
    `method:${COLL}_factory:create:method`,
    `method:${COLL}_parser:parse`,
    `module:${COLL}`,
  ]);
  assert.equal(node(`${COLL}:hostspec:function`).label, "hostSpec()");
  assert.equal(node(`${COLL}:hostspec`).label, "HostSpec");
});

test("(b3-no-self-loop) `new Parser()` inside function parser() is an edge, not a dropped self-loop", () => {
  assert.deepStrictEqual(edgesFrom(`${COLL}:parser:function`), [
    `${COLL}:parser:function -references-> ${COLL}:parser @L17`,
    `${COLL}:parser:function -references-> ${COLL}:parser @L18`,
  ]);
  assert.deepStrictEqual(edgesFrom(`${COLL}:hostspec:function`), [
    `${COLL}:hostspec:function -references-> ${COLL}:hostspec @L7`,
  ]);
});

test("(b3-static-vs-instance) a static and an instance member of one name are distinct nodes", () => {
  assert.deepStrictEqual(edgesFrom(`${COLL}_factory:create:method`, ["calls"]), [
    `${COLL}_factory:create:method -calls-> ${COLL}_factory:create @L27`,
  ]);
});

test("(b3-callers) callers resolve to the right colliding declaration", () => {
  assert.deepStrictEqual(edgesFrom("collisions_caller_ts:usecollisions", ["calls"]), [
    `collisions_caller_ts:usecollisions -calls-> ${COLL}:hostspec:function @L4`,
    `collisions_caller_ts:usecollisions -calls-> ${COLL}:parser:function @L5`,
    `collisions_caller_ts:usecollisions -calls-> ${COLL}_factory:create:method @L6`,
    `collisions_caller_ts:usecollisions -calls-> ${COLL}_parser:parse @L5`,
  ]);
});

test("(b3-unique-ids) the extractor emits each node id once", () => {
  const ids = nodes.map((n) => n.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepStrictEqual(dupes, []);
});
