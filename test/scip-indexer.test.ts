// scip-indexer.test.ts — unit tests for src/infrastructure/extractors/semantic/
// scip-indexer.ts: Phase 2 tasks 2.1 (translateScipSymbol), 2.3 (calls/heritage
// edge derivation, EXTRACTED confidence, no rawCalls/imports), and 2.4
// (resolveScipIndexer PATH detection). The id-parity GOLDEN test against
// tree-sitter lives separately in test/scip-id-parity.test.ts (the gate).
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-indexer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeId } from "../src/domain/shared/id.ts";
import type { ScipDocument } from "../src/infrastructure/extractors/semantic/scip-proto.ts";
import {
  deriveScipDocumentGraph,
  parseScipSymbol,
  resolveScipIndexer,
  translateScipSymbol,
} from "../src/infrastructure/extractors/semantic/scip-indexer.ts";

const PKG = "scip-go gomod example.com/fixture db34c37859f0";

// ---------------------------------------------------------------------------
// translateScipSymbol — id translation, per case (task 2.1)
// ---------------------------------------------------------------------------

function doc(relativePath: string): ScipDocument {
  return { relativePath, language: "go", occurrences: [], symbols: [] };
}

test("(scip-id-toplevel-function) top-level function -> makeId(relPath, name)", () => {
  const id = translateScipSymbol(doc("main.go"), `${PKG} \`example.com/fixture\`/Foo().`, "go");
  assert.equal(id, makeId("main.go", "Foo"));
});

test("(scip-id-method-with-owner) method with owner type -> makeId(makeId(relPath, owner), method)", () => {
  const id = translateScipSymbol(doc("main.go"), `${PKG} \`example.com/fixture\`/Bar#Greet().`, "go");
  const classId = makeId("main.go", "Bar");
  assert.equal(id, makeId(classId, "Greet"));
});

test("(scip-id-type) a bare type descriptor (struct/interface) -> makeId(relPath, name)", () => {
  const id = translateScipSymbol(doc("main.go"), `${PKG} \`example.com/fixture\`/Bar#`, "go");
  assert.equal(id, makeId("main.go", "Bar"));
});

test("(scip-id-namespace-only) a namespace-only symbol (the package/file itself) -> the file id", () => {
  const id = translateScipSymbol(doc("main.go"), `${PKG} \`example.com/fixture\`/`, "go");
  assert.equal(id, makeId("main.go"));
});

test("(scip-id-local) a 'local N' symbol has no tree-sitter equivalent -> null", () => {
  assert.equal(translateScipSymbol(doc("main.go"), "local 0", "go"), null);
});

test("(scip-id-malformed) a symbol with fewer than 4 head fields -> null (never throws)", () => {
  assert.equal(translateScipSymbol(doc("main.go"), "scip-go gomod onlythree", "go"), null);
});

test("(scip-id-nested-owner) 3-level nesting folds owner chain like nested makeId calls", () => {
  const id = translateScipSymbol(doc("a.go"), `${PKG} \`example.com/fixture\`/Outer#Inner#Method().`, "go");
  const outerId = makeId("a.go", "Outer");
  const innerId = makeId(outerId, "Inner");
  assert.equal(id, makeId(innerId, "Method"));
});

// ---------------------------------------------------------------------------
// parseScipSymbol — grammar edge cases
// ---------------------------------------------------------------------------

test("(scip-parse-escaped-backtick) doubled backtick inside an escaped identifier decodes to a literal backtick", () => {
  const parsed = parseScipSymbol(`${PKG} \`a\`\`b\`.`);
  assert.ok(parsed && !parsed.isLocal);
  assert.equal(parsed.descriptors[0]!.name, "a`b");
  assert.equal(parsed.descriptors[0]!.suffix, "term");
});

test("(scip-parse-local) 'local N' parses as isLocal with no descriptors", () => {
  const parsed = parseScipSymbol("local 42");
  assert.ok(parsed?.isLocal);
  assert.equal(parsed.descriptors.length, 0);
});

// ---------------------------------------------------------------------------
// deriveScipDocumentGraph — edges EXTRACTED, no rawCalls/imports (task 2.3)
// ---------------------------------------------------------------------------

const FOO_SYM = `${PKG} \`example.com/fixture\`/Foo().`;
const BAR_SYM = `${PKG} \`example.com/fixture\`/Bar#`;
const BAR_GREET_SYM = `${PKG} \`example.com/fixture\`/Bar#Greet().`;
const GREETER_SYM = `${PKG} \`example.com/fixture\`/Greeter#`;
const GREETER_GREET_SYM = `${PKG} \`example.com/fixture\`/Greeter#Greet.`; // term suffix — NOT callable

function fixtureDoc(): ScipDocument {
  return {
    relativePath: "main.go",
    language: "go",
    occurrences: [
      { range: { startLine: 3, startCharacter: 0, endLine: 3, endCharacter: 3 }, symbol: FOO_SYM, symbolRoles: 1, enclosingRange: { startLine: 3, startCharacter: 0, endLine: 5, endCharacter: 1 } },
      { range: { startLine: 13, startCharacter: 5, endLine: 13, endCharacter: 8 }, symbol: BAR_SYM, symbolRoles: 1, enclosingRange: null },
      { range: { startLine: 18, startCharacter: 14, endLine: 18, endCharacter: 19 }, symbol: BAR_GREET_SYM, symbolRoles: 1, enclosingRange: { startLine: 18, startCharacter: 0, endLine: 20, endCharacter: 1 } },
      { range: { startLine: 8, startCharacter: 5, endLine: 8, endCharacter: 12 }, symbol: GREETER_SYM, symbolRoles: 1, enclosingRange: null },
      // Reference to Foo() inside Bar.Greet's body -> should become a `calls` edge.
      { range: { startLine: 19, startCharacter: 8, endLine: 19, endCharacter: 11 }, symbol: FOO_SYM, symbolRoles: 8, enclosingRange: null },
      // Reference to the (non-callable, term-suffixed) interface method spec, also inside
      // Bar.Greet's body -> must NOT become a `calls` edge (isCallableSymbol === false).
      { range: { startLine: 19, startCharacter: 20, endLine: 19, endCharacter: 25 }, symbol: GREETER_GREET_SYM, symbolRoles: 8, enclosingRange: null },
    ],
    symbols: [
      { symbol: FOO_SYM, kind: 17, displayName: "Foo", relationships: [] },
      {
        symbol: BAR_SYM,
        kind: 49,
        displayName: "Bar",
        relationships: [{ symbol: GREETER_SYM, isImplementation: true, isTypeDefinition: false }],
      },
      {
        symbol: BAR_GREET_SYM,
        kind: 26,
        displayName: "Greet",
        relationships: [{ symbol: GREETER_GREET_SYM, isImplementation: true, isTypeDefinition: false }],
      },
      { symbol: GREETER_SYM, kind: 21, displayName: "Greeter", relationships: [] },
      // Interface method spec (MethodSpecification=67) — must NOT get a node (tree-sitter
      // never emits one for a Go interface method element either).
      { symbol: GREETER_GREET_SYM, kind: 67, displayName: "Greet", relationships: [] },
    ],
  };
}

test("(scip-graph-shape) deriveScipDocumentGraph returns ONLY {nodes, edges} — no rawCalls/imports", () => {
  const result = deriveScipDocumentGraph(fixtureDoc(), "go");
  assert.deepEqual(Object.keys(result).sort(), ["edges", "nodes"]);
});

test("(scip-graph-confidence) every emitted edge is EXTRACTED", () => {
  const { edges } = deriveScipDocumentGraph(fixtureDoc(), "go");
  assert.ok(edges.length > 0, "must emit at least one edge");
  for (const e of edges) assert.equal(e.confidence, "EXTRACTED", `edge ${e.source}->${e.target} (${e.relation})`);
});

test("(scip-graph-nodes) nodes: file + Foo/Bar/Greeter/Bar.Greet, but NOT the interface method spec", () => {
  const { nodes } = deriveScipDocumentGraph(fixtureDoc(), "go");
  const ids = nodes.map((n) => n.id);
  const fileId = makeId("main.go");
  const fooId = makeId("main.go", "Foo");
  const barId = makeId("main.go", "Bar");
  const greeterId = makeId("main.go", "Greeter");
  const greetId = makeId(barId, "Greet");
  assert.ok(ids.includes(fileId));
  assert.ok(ids.includes(fooId));
  assert.ok(ids.includes(barId));
  assert.ok(ids.includes(greeterId));
  assert.ok(ids.includes(greetId));
  // Greeter#Greet (MethodSpecification, term suffix) has no tree-sitter equivalent.
  assert.equal(nodes.length, 5, `unexpected extra node(s): ${JSON.stringify(ids)}`);
});

test("(scip-graph-contains-method) contains edges from file, method edge from owner", () => {
  const { edges } = deriveScipDocumentGraph(fixtureDoc(), "go");
  const fileId = makeId("main.go");
  const barId = makeId("main.go", "Bar");
  const greetId = makeId(barId, "Greet");
  assert.ok(edges.some((e) => e.source === fileId && e.target === barId && e.relation === "contains"));
  assert.ok(edges.some((e) => e.source === barId && e.target === greetId && e.relation === "method"));
});

test("(scip-graph-implements) implements edges come straight from relationships[]", () => {
  const { edges } = deriveScipDocumentGraph(fixtureDoc(), "go");
  const barId = makeId("main.go", "Bar");
  const greeterId = makeId("main.go", "Greeter");
  assert.ok(edges.some((e) => e.source === barId && e.target === greeterId && e.relation === "implements"));
});

test("(scip-graph-calls) a call to Foo() inside Bar.Greet's enclosing range becomes a `calls` edge", () => {
  const { edges } = deriveScipDocumentGraph(fixtureDoc(), "go");
  const barId = makeId("main.go", "Bar");
  const greetId = makeId(barId, "Greet");
  const fooId = makeId("main.go", "Foo");
  const calls = edges.filter((e) => e.relation === "calls");
  assert.ok(calls.some((e) => e.source === greetId && e.target === fooId), `expected a calls edge Bar.Greet -> Foo, got: ${JSON.stringify(calls)}`);
});

test("(scip-graph-no-noncallable-calls) a reference to a non-callable (term-suffixed) symbol never becomes a `calls` edge", () => {
  const { edges } = deriveScipDocumentGraph(fixtureDoc(), "go");
  const calls = edges.filter((e) => e.relation === "calls");
  assert.equal(calls.length, 1, `expected exactly one calls edge (Foo), got: ${JSON.stringify(calls)}`);
});

// ---------------------------------------------------------------------------
// resolveScipIndexer — PATH/env detection (task 2.4)
// ---------------------------------------------------------------------------

test("(scip-resolve-env-override) an explicit env override wins and is split into argv parts", () => {
  const prev = process.env.LEINA_SCIP_GO_INDEXER;
  process.env.LEINA_SCIP_GO_INDEXER = "some-fake-scip-go --flag";
  try {
    assert.deepEqual(resolveScipIndexer("go"), ["some-fake-scip-go", "--flag"]);
  } finally {
    if (prev === undefined) delete process.env.LEINA_SCIP_GO_INDEXER;
    else process.env.LEINA_SCIP_GO_INDEXER = prev;
  }
});

test("(scip-resolve-path-empty) no env override and no binary in PATH -> null", () => {
  const prevEnv = process.env.LEINA_SCIP_GO_INDEXER;
  const prevPath = process.env.PATH;
  delete process.env.LEINA_SCIP_GO_INDEXER;
  process.env.PATH = "/nonexistent-leina-test-path"; // guarantee scip-go cannot be found regardless of host machine
  try {
    assert.equal(resolveScipIndexer("go"), null);
  } finally {
    if (prevEnv === undefined) delete process.env.LEINA_SCIP_GO_INDEXER;
    else process.env.LEINA_SCIP_GO_INDEXER = prevEnv;
    process.env.PATH = prevPath;
  }
});
