// Signature-extraction tests for the ts-morph semantic extractor.
// Asserts that function/method nodes carry a structured `signature` with:
//   - returnType (annotation-primary, resolved fallback with cleanup, 200-char cap)
//   - parameters (name + type + nullable + optional)
//   - accessModifier (for class methods)
//   - isAsync, isGenerator
//
// Run standalone: node --no-warnings --experimental-strip-types --test test/tsmorph-signatures.test.ts
// Also picked up by: npm test (glob test/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractTsProject } from "../src/infrastructure/extractors/semantic/tsmorph.ts";
import type { GraphNode, Signature } from "../src/domain/graph/model.ts";

// ---------------------------------------------------------------------------
// Shared extraction — run once at module scope, shared across all test cases.
// ---------------------------------------------------------------------------

const fixtureDir = join(import.meta.dirname, "fixtures", "tsmorph-signatures");

const FIXTURES = [
  "basics.ts",
  "inferred-return.ts",
  "cross-file-type.ts",
  "other-types.ts",
  "nullable-cases.ts",
  "async-and-generator.ts",
  "class-modifiers.ts",
  "arrows.ts",
  "long-generic.ts",
];

const { nodes } = extractTsProject(
  fixtureDir,
  FIXTURES.map((f) => join(fixtureDir, f)),
);

function getNode(id: string): GraphNode {
  const n = nodes.find((x) => x.id === id);
  if (!n) {
    throw new Error(
      `Node "${id}" not found. Available: ${nodes.map((x) => x.id).join(", ")}`,
    );
  }
  return n;
}

function getSig(id: string): Signature {
  const n = getNode(id);
  if (!n.signature) {
    throw new Error(`Node "${id}" has no signature.\nNode: ${JSON.stringify(n, null, 2)}`);
  }
  return n.signature;
}

function param(sig: Signature, i: number) {
  const p = sig.parameters[i];
  if (!p) {
    throw new Error(
      `Signature has no parameter at index ${i}. Params: ${JSON.stringify(sig.parameters)}`,
    );
  }
  return p;
}

// ---------------------------------------------------------------------------
// (sig-basics) explicit annotation primary
// ---------------------------------------------------------------------------
test("(sig-basics) explicit return annotation + typed params", () => {
  const sig = getSig("basics_ts:add");
  assert.equal(sig.returnType.text, "number");
  assert.equal(sig.returnType.nullable, false);
  assert.equal(sig.parameters.length, 2);
  assert.deepEqual(param(sig, 0), {
    name: "a",
    type: "number",
    nullable: false,
    optional: false,
  });
  assert.deepEqual(param(sig, 1), {
    name: "b",
    type: "number",
    nullable: false,
    optional: false,
  });
  assert.equal(sig.isAsync, false);
  assert.equal(sig.isGenerator, false);
  assert.equal(sig.accessModifier, undefined);
});

// ---------------------------------------------------------------------------
// (sig-inferred-return) no return annotation -> resolved fallback
// ---------------------------------------------------------------------------
test("(sig-inferred-return) inferred return type via fallback", () => {
  const sig = getSig("inferred_return_ts:greet");
  assert.equal(sig.returnType.text, "string");
  assert.equal(param(sig, 0).type, "string");
});

// ---------------------------------------------------------------------------
// (sig-cleanup) resolved-fallback strips import("...") qualification
// ---------------------------------------------------------------------------
test("(sig-cleanup) resolved fallback strips import(\"...\") prefix", () => {
  const sig = getSig("cross_file_type_ts:process");
  // The parameter `p` has no annotation; the inferred type references Payload
  // from ./other-types. The cleaned text must NOT include `import(`.
  const p0 = param(sig, 0);
  assert.ok(
    !p0.type.includes("import("),
    `Expected cleanup to strip import("...") prefix, got: ${p0.type}`,
  );
  assert.ok(
    p0.type.includes("Payload") || p0.type.includes("id"),
    `Expected Payload type to appear cleaned, got: ${p0.type}`,
  );
});

// ---------------------------------------------------------------------------
// (sig-cap) 200-char cap on long inferred generics
// ---------------------------------------------------------------------------
test("(sig-cap) inferred return capped at 200 chars", () => {
  const sig = getSig("long_generic_ts:deeplynested");
  assert.ok(
    sig.returnType.text.length <= 200,
    `Expected returnType.text.length <= 200, got ${sig.returnType.text.length}`,
  );
  // If it had to be truncated, it ends with the ellipsis sentinel.
  if (sig.returnType.text.length === 200) {
    assert.ok(sig.returnType.text.endsWith("..."));
  }
});

// ---------------------------------------------------------------------------
// (sig-nullable) the 4 nullability scenarios
// ---------------------------------------------------------------------------
test("(sig-nullable-return) T | null return -> nullable=true", () => {
  const sig = getSig("nullable_cases_ts:finduser");
  assert.equal(sig.returnType.nullable, true);
});

test("(sig-nullable-param) T | undefined param -> nullable=true, optional=false", () => {
  const sig = getSig("nullable_cases_ts:logmaybe");
  const p0 = param(sig, 0);
  assert.equal(p0.nullable, true);
  assert.equal(p0.optional, false);
});

test("(sig-optional-question) x?: T -> nullable=true, optional=true", () => {
  const sig = getSig("nullable_cases_ts:withoptional");
  const y = param(sig, 1);
  assert.equal(y.name, "y");
  assert.equal(y.optional, true);
  assert.equal(y.nullable, true);
});

test("(sig-optional-default) x = default -> nullable=false, optional=true", () => {
  const sig = getSig("nullable_cases_ts:withdefault");
  const y = param(sig, 1);
  assert.equal(y.name, "y");
  assert.equal(y.optional, true);
  assert.equal(y.nullable, false);
});

// ---------------------------------------------------------------------------
// (sig-async-generator) the 4 async/generator combinations
// ---------------------------------------------------------------------------
test("(sig-async-function) async function -> isAsync=true", () => {
  const sig = getSig("async_and_generator_ts:fetchuser");
  assert.equal(sig.isAsync, true);
  assert.equal(sig.isGenerator, false);
});

test("(sig-generator-function) function* -> isGenerator=true", () => {
  const sig = getSig("async_and_generator_ts:counter");
  assert.equal(sig.isAsync, false);
  assert.equal(sig.isGenerator, true);
});

test("(sig-async-generator) async function* -> both true", () => {
  const sig = getSig("async_and_generator_ts:streamusers");
  assert.equal(sig.isAsync, true);
  assert.equal(sig.isGenerator, true);
});

test("(sig-async-arrow) async arrow -> isAsync=true via modifier", () => {
  const sig = getSig("async_and_generator_ts:fetchone");
  assert.equal(sig.isAsync, true);
  assert.equal(sig.isGenerator, false);
});

// ---------------------------------------------------------------------------
// (sig-modifiers) class method access modifiers
// ---------------------------------------------------------------------------
test("(sig-modifier-public) public method -> accessModifier=public", () => {
  const sig = getSig("class_modifiers_ts_service:publicmethod");
  assert.equal(sig.accessModifier, "public");
});

test("(sig-modifier-private) private method -> accessModifier=private", () => {
  const sig = getSig("class_modifiers_ts_service:privatehelper");
  assert.equal(sig.accessModifier, "private");
});

test("(sig-modifier-protected) protected method -> accessModifier=protected", () => {
  const sig = getSig("class_modifiers_ts_service:protectedstep");
  assert.equal(sig.accessModifier, "protected");
});

test("(sig-arrow-field) class arrow field -> signature captured", () => {
  const sig = getSig("class_modifiers_ts_service:handler");
  assert.equal(sig.returnType.text, "boolean");
  const p0 = param(sig, 0);
  assert.equal(p0.name, "n");
  assert.equal(p0.type, "number");
});

// ---------------------------------------------------------------------------
// (sig-arrow-var) top-level arrow / FunctionExpression VariableDeclaration
// ---------------------------------------------------------------------------
test("(sig-arrow-var) export const f = (x) => ... -> signature captured", () => {
  const sig = getSig("arrows_ts:incr");
  assert.equal(sig.returnType.text, "number");
  const p0 = param(sig, 0);
  assert.equal(p0.name, "x");
  assert.equal(p0.type, "number");
});

test("(sig-fn-expr-var) export const f = function (x) ... -> signature captured", () => {
  const sig = getSig("arrows_ts:decr");
  assert.equal(sig.returnType.text, "number");
  assert.equal(param(sig, 0).name, "x");
});
