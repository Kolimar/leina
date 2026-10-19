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

// ---------------------------------------------------------------------------
// B4 — type aliases, enums, variables, accessors, object-literal methods and the
// anonymous default export are nodes; uses of them are edges
// ---------------------------------------------------------------------------

const KINDS = "data_kinds_ts";
const USER = "data_user_ts";

test("(b4-nodes) new declaration kinds get nodes with their own kind", () => {
  assert.deepStrictEqual(nodesOf("data-kinds.ts"), [
    `accessor:${KINDS}_account:balance`,
    `class:${KINDS}:account`,
    `enum:${KINDS}:color`,
    `method:${KINDS}_handlers:build`,
    `method:${KINDS}_handlers:query`,
    `module:${KINDS}`,
    `type:${KINDS}:status`,
    `type:${KINDS}:user`,
    `variable:${KINDS}:handlers`,
    `variable:${KINDS}:limit`,
    `variable:${KINDS}:save_re`,
    `variable:${KINDS}:user:variable`,
  ]);
  assert.deepStrictEqual(nodesOf("data-default.ts"), ["function:data_default_ts:default", "module:data_default_ts"]);
  assert.equal(node("data_default_ts:default").label, "default()");
  assert.equal(node(`${KINDS}:limit`).label, "LIMIT");
  assert.ok(node(`${KINDS}_account:balance`).signature, "accessors carry a signature");
});

test("(b4-structure) members of object literals and accessors hang off their owner", () => {
  assert.deepStrictEqual(edgesFrom(`${KINDS}:handlers`, ["method"]), [
    `${KINDS}:handlers -method-> ${KINDS}_handlers:build @L17`,
    `${KINDS}:handlers -method-> ${KINDS}_handlers:query @L20`,
  ]);
  assert.deepStrictEqual(edgesFrom(`${KINDS}:account`, ["method"]), [
    `${KINDS}:account -method-> ${KINDS}_account:balance @L25`,
  ]);
});

test("(b4-uses) consts, enums, type aliases, accessors and literal methods are reached by their users", () => {
  assert.deepStrictEqual(edgesFrom(`${USER}:usekinds`), [
    `${USER}:usekinds -calls-> data_default_ts:default @L8`,
    `${USER}:usekinds -calls-> ${KINDS}_handlers:build @L7`,
    `${USER}:usekinds -calls-> ${KINDS}_handlers:query @L9`,
    `${USER}:usekinds -references-> ${KINDS}:account @L5`,
    `${USER}:usekinds -references-> ${KINDS}:color @L8`,
    `${USER}:usekinds -references-> ${KINDS}:handlers @L7`,
    `${USER}:usekinds -references-> ${KINDS}:limit @L6`,
    `${USER}:usekinds -references-> ${KINDS}:status @L4`,
    `${USER}:usekinds -references-> ${KINDS}:user:variable @L8`,
    `${USER}:usekinds -references-> ${KINDS}_account:balance @L6`,
  ]);
});

test("(b4-merged-value-type) a const and a type alias sharing a name resolve by meaning", () => {
  // `u: User` is the type; `User.kind` (above) and `typeof User` are the value.
  assert.deepStrictEqual(edgesFrom(`${USER}:asuser`), [`${USER}:asuser -references-> ${KINDS}:user @L12`]);
  assert.deepStrictEqual(edgesFrom(`${KINDS}:user`), [`${KINDS}:user -references-> ${KINDS}:user:variable @L14`]);
});

// ---------------------------------------------------------------------------
// B1 — destructured dynamic imports and local renames resolve to the declaration
// ---------------------------------------------------------------------------

const DT = "dyn_target_ts";
const DU = "dyn_user_ts";

test("(b1-dynamic-shorthand) `const { f } = await import()` then `f()` is a call of f", () => {
  assert.deepStrictEqual(edgesFrom(`${DU}:shorthand`), [
    `${DU}:shorthand -calls-> ${DT}:runtask @L5`,
    `${DU}:shorthand -references-> ${DT}:runtask @L4`,
  ]);
});

test("(b1-dynamic-renamed) `const { f: g } = await import()` then `g()` is a call of f", () => {
  assert.deepStrictEqual(edgesFrom(`${DU}:renamed`), [
    `${DU}:renamed -calls-> ${DT}:stoptask @L10`,
    `${DU}:renamed -references-> ${DT}:stoptask @L9`,
  ]);
});

test("(b1-dynamic-namespace) `(await import()).f()` through a namespace const is a call of f", () => {
  assert.deepStrictEqual(edgesFrom(`${DU}:namespaced`), [`${DU}:namespaced -calls-> ${DT}:stoptask @L15`]);
});

test("(b1-local-alias) const aliases and shorthand properties are followed to the function", () => {
  assert.deepStrictEqual(edgesFrom(`${DU}:aliased`), [
    `${DU}:aliased -calls-> ${DT}:runtask @L21`,
    `${DU}:aliased -references-> ${DT}:runtask @L19`,
    `${DU}:aliased -references-> ${DT}:tools @L19`,
  ]);
  assert.deepStrictEqual(edgesFrom(`${DT}:tools`), [`${DT}:tools -references-> ${DT}:runtask @L8`]);
});
