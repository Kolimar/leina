// resolve.test.ts — unit tests for src/extractors/resolve.ts (pure resolution)
// Run: node --no-warnings --experimental-strip-types --test test/resolve.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "../src/application/graph/resolve.ts";
import type {
  GraphEdge,
  GraphNode,
  ImportBinding,
  RawCall,
} from "../src/domain/graph/model.ts";

function fn(id: string, label: string, sourceFile: string): GraphNode {
  return { id, label, kind: "function", fileType: "code", sourceFile };
}
function cls(id: string, label: string, sourceFile: string): GraphNode {
  return { id, label, kind: "class", fileType: "code", sourceFile };
}
function method(id: string, label: string, sourceFile: string): GraphNode {
  return { id, label, kind: "method", fileType: "code", sourceFile };
}

function call(callee: string, fromId: string, sourceFile: string, extra: Partial<RawCall> = {}): RawCall {
  return {
    callee,
    fromId,
    sourceFile,
    sourceLocation: "L1",
    isMember: false,
    ...extra,
  };
}

function findCall(edges: GraphEdge[], source: string): GraphEdge | undefined {
  return edges.find((e) => e.source === source && (e.relation === "calls" || e.relation === "references"));
}

// ---------------------------------------------------------------------------
// Same-file resolution
// ---------------------------------------------------------------------------

test("same-file unique match → EXTRACTED calls edge", () => {
  const nodes = [fn("a", "caller", "x.ts"), fn("b", "helper", "x.ts")];
  const calls = [call("helper", "a", "x.ts")];
  const { edges } = resolve(nodes, [], calls, []);
  const e = findCall(edges, "a");
  assert.ok(e);
  assert.equal(e.target, "b");
  assert.equal(e.confidence, "EXTRACTED");
  assert.equal(e.relation, "calls");
});

test("self-recursion is filtered out (caller === callee)", () => {
  const nodes = [fn("a", "recurse", "x.ts")];
  const calls = [call("recurse", "a", "x.ts")];
  const { edges } = resolve(nodes, [], calls, []);
  assert.equal(findCall(edges, "a"), undefined);
});

test("unknown callee (no candidate) → no edge", () => {
  const nodes = [fn("a", "caller", "x.ts")];
  const calls = [call("doesNotExist", "a", "x.ts")];
  const { edges } = resolve(nodes, [], calls, []);
  assert.equal(edges.length, 0);
});

// ---------------------------------------------------------------------------
// Cross-file resolution
// ---------------------------------------------------------------------------

test("cross-file unique match → INFERRED", () => {
  const nodes = [fn("a", "caller", "x.ts"), fn("b", "helper", "y.ts")];
  const calls = [call("helper", "a", "x.ts")];
  const { edges } = resolve(nodes, [], calls, []);
  const e = findCall(edges, "a");
  assert.ok(e);
  assert.equal(e.target, "b");
  assert.equal(e.confidence, "INFERRED");
});

test("cross-file multiple candidates → AMBIGUOUS (first picked, not dropped)", () => {
  const nodes = [
    fn("a", "caller", "x.ts"),
    fn("b", "helper", "y.ts"),
    fn("c", "helper", "z.ts"),
  ];
  const calls = [call("helper", "a", "x.ts")];
  const { edges } = resolve(nodes, [], calls, []);
  const e = findCall(edges, "a");
  assert.ok(e);
  assert.equal(e.confidence, "AMBIGUOUS");
});

test("too many candidates (>4) → dropped (no edge)", () => {
  const nodes = [fn("a", "caller", "x.ts")];
  for (let i = 0; i < 5; i++) nodes.push(fn(`h${i}`, "helper", `f${i}.ts`));
  const calls = [call("helper", "a", "x.ts")];
  const { edges } = resolve(nodes, [], calls, []);
  assert.equal(findCall(edges, "a"), undefined);
});

// ---------------------------------------------------------------------------
// Import-guided resolution
// ---------------------------------------------------------------------------

test("import-guided: module path disambiguates multiple candidates → EXTRACTED", () => {
  const nodes = [
    fn("a", "caller", "x.ts"),
    fn("b", "make", "auth.ts"),
    fn("c", "make", "other.ts"),
  ];
  const calls = [call("make", "a", "x.ts")];
  const imports: ImportBinding[] = [{ localName: "make", module: "./auth", sourceFile: "x.ts" }];
  const { edges } = resolve(nodes, [], calls, imports);
  const e = findCall(edges, "a");
  assert.ok(e);
  assert.equal(e.target, "b", "module ./auth matched auth.ts");
  assert.equal(e.confidence, "EXTRACTED");
});

// ---------------------------------------------------------------------------
// Receiver-type resolution
// ---------------------------------------------------------------------------

test("receiver-type disambiguates a method call → EXTRACTED", () => {
  const nodes = [
    fn("a", "caller", "x.ts"),
    cls("F", "TokenFactory", "f.ts"),
    method("m1", "make", "f.ts"),
    cls("G", "Other", "g.ts"),
    method("m2", "make", "g.ts"),
  ];
  const edges: GraphEdge[] = [
    { source: "F", target: "m1", relation: "method", confidence: "EXTRACTED", sourceFile: "f.ts", weight: 1 },
    { source: "G", target: "m2", relation: "method", confidence: "EXTRACTED", sourceFile: "g.ts", weight: 1 },
  ];
  const calls = [call("make", "a", "x.ts", { isMember: true, receiverType: "TokenFactory" })];
  const { edges: out } = resolve(nodes, edges, calls, []);
  const e = findCall(out, "a");
  assert.ok(e);
  assert.equal(e.target, "m1");
  assert.equal(e.confidence, "EXTRACTED");
});

// ---------------------------------------------------------------------------
// Heritage edge retargeting
// ---------------------------------------------------------------------------

test("heritage edge retargets placeholder id to real type → EXTRACTED", () => {
  const nodes = [cls("childId", "Child", "c.ts"), cls("baseId", "Base", "b.ts")];
  // placeholder target "base" (makeId form) instead of the real node id
  const edges: GraphEdge[] = [
    { source: "childId", target: "base", relation: "extends", confidence: "INFERRED", sourceFile: "c.ts", weight: 1 },
  ];
  const { edges: out } = resolve(nodes, edges, [], []);
  const e = out.find((x) => x.relation === "extends");
  assert.ok(e);
  assert.equal(e.target, "baseId");
  assert.equal(e.confidence, "EXTRACTED");
});

test("heritage edge to unknown base is kept as-is (external)", () => {
  const nodes = [cls("childId", "Child", "c.ts")];
  const edges: GraphEdge[] = [
    { source: "childId", target: "external_base", relation: "extends", confidence: "INFERRED", sourceFile: "c.ts", weight: 1 },
  ];
  const { edges: out } = resolve(nodes, edges, [], []);
  const e = out.find((x) => x.relation === "extends");
  assert.ok(e);
  assert.equal(e.target, "external_base");
});

test("call targeting a class yields a references edge (not calls)", () => {
  const nodes = [fn("a", "caller", "x.ts"), cls("C", "Widget", "x.ts")];
  const calls = [call("Widget", "a", "x.ts")];
  const { edges } = resolve(nodes, [], calls, []);
  const e = edges.find((x) => x.source === "a");
  assert.ok(e);
  assert.equal(e.relation, "references");
});

// ---------------------------------------------------------------------------
// scopeFiles parameter — NFR-01 (no scope → identical), SC-10/11 setup (D4)
// ---------------------------------------------------------------------------

test("(scope-NFR-01) no scopeFiles → identical result to before", () => {
  // Same setup as "same-file unique match → EXTRACTED calls edge"
  const nodes = [fn("a", "caller", "x.ts"), fn("b", "helper", "x.ts")];
  const calls = [call("helper", "a", "x.ts")];
  const withoutScope = resolve(nodes, [], calls, []);
  const withUndefined = resolve(nodes, [], calls, [], undefined);
  assert.deepEqual(withoutScope.edges, withUndefined.edges, "undefined scopeFiles must be byte-identical");
});

test("(scope-filter) scopeFiles restricts candidates to files in scope", () => {
  // Two functions with same label in different files
  // repo-a scope: only "a.ts"; resolver should prefer the candidate from "a.ts"
  const nodes = [
    fn("caller:id", "callMe", "caller.ts"),
    fn("a:helper", "helper", "a.ts"),
    fn("b:helper", "helper", "b.ts"), // same name, different file
  ];
  const rawCalls = [call("helper", "caller:id", "caller.ts")];

  // Without scope: multiple candidates → AMBIGUOUS or arbitrary
  const _withoutScope = resolve(nodes, [], rawCalls, []);
  // With scope restricted to "a.ts": should resolve to a:helper (only in-scope candidate)
  const scope = new Set(["a.ts"]);
  const withScope = resolve(nodes, [], rawCalls, [], scope);
  const edge = findCall(withScope.edges, "caller:id");
  assert.ok(edge, "edge must exist with scope");
  assert.equal(edge.target, "a:helper", "scope must restrict to in-scope candidate");
});

test("(scope-empty-set) empty Set<string> scopeFiles behaves like no scope", () => {
  const nodes = [fn("a", "caller", "x.ts"), fn("b", "helper", "x.ts")];
  const rawCalls = [call("helper", "a", "x.ts")];
  const withEmpty = resolve(nodes, [], rawCalls, [], new Set());
  const without = resolve(nodes, [], rawCalls, []);
  assert.deepEqual(withEmpty.edges, without.edges, "empty scope must be equivalent to no scope");
});

test("(scope-no-match-fallback) if no candidate is in scope, falls back to unscoped pick", () => {
  // Only one candidate exists, not in scope → should still resolve (fallback)
  const nodes = [fn("caller:id", "caller", "src.ts"), fn("target:id", "target", "other.ts")];
  const rawCalls = [call("target", "caller:id", "src.ts")];
  const scope = new Set(["src.ts"]); // target is NOT in src.ts
  const { edges } = resolve(nodes, [], rawCalls, [], scope);
  const edge = findCall(edges, "caller:id");
  assert.ok(edge, "should fall back to unscoped resolution when no candidate in scope");
  assert.equal(edge.target, "target:id");
});
