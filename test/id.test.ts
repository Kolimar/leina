// id.test.ts — unit tests for src/domain/shared/id.ts
// Covers: makeId unchanged (NFR-01), makeNamespacedId determinism (NFR-03),
// cross-repo uniqueness (SC-09), and separator non-collision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeId, makeNamespacedId, normalizeLabel, splitIdentifier } from "../src/domain/shared/id.ts";

// ---------------------------------------------------------------------------
// makeId — must not change (NFR-01)
// ---------------------------------------------------------------------------

test("(id-make-basic) makeId normalizes and joins with colon", () => {
  // normalizeLabel lowercases + collapses non-alphanumerics to underscore
  // "buildToken" → "buildtoken" (camelCase stays as one word, no underscore inserted)
  assert.equal(makeId("src/auth.ts", "buildToken"), "src_auth_ts:buildtoken");
});

test("(id-make-deterministic) makeId is deterministic across calls (NFR-03)", () => {
  const a = makeId("src/auth.ts", "buildToken");
  const b = makeId("src/auth.ts", "buildToken");
  assert.equal(a, b);
});

test("(id-make-no-separator-change) makeId uses ':' not '::'", () => {
  const id = makeId("src/foo.ts", "bar");
  assert.ok(!id.includes("::"), "makeId must never produce '::' separator");
});

// ---------------------------------------------------------------------------
// makeNamespacedId — workspace uniqueness (SC-09, NFR-03)
// ---------------------------------------------------------------------------

test("(id-ns-basic) makeNamespacedId prefixes repoKey with '::'", () => {
  const id = makeNamespacedId("repo-a", "src/auth.ts", "buildToken");
  assert.ok(id.startsWith("repo-a::"), `expected prefix 'repo-a::' in '${id}'`);
  const inner = makeId("src/auth.ts", "buildToken");
  assert.equal(id, `repo-a::${inner}`);
});

test("(id-ns-cross-repo-unique) same file+label in different repos yields different IDs (SC-09)", () => {
  const idA = makeNamespacedId("repo-a", "src/auth.ts", "buildToken");
  const idB = makeNamespacedId("repo-b", "src/auth.ts", "buildToken");
  assert.notEqual(idA, idB, "IDs in different repos must not collide");
});

test("(id-ns-deterministic) makeNamespacedId is deterministic (NFR-03)", () => {
  const a = makeNamespacedId("my-service", "src/auth.ts", "buildToken");
  const b = makeNamespacedId("my-service", "src/auth.ts", "buildToken");
  assert.equal(a, b);
});

test("(id-ns-key-normalized) repoKey is normalized to hyphens", () => {
  // org/repo style key normalized like a project key
  const id = makeNamespacedId("Acme Corp/My Service", "src/foo.ts", "doWork");
  assert.ok(id.startsWith("acme-corp-my-service::"), `got: ${id}`);
});

test("(id-ns-no-makeId-change) makeId still returns same result after makeNamespacedId exists", () => {
  // Regression: makeId must be byte-identical to before (NFR-01)
  assert.equal(makeId("src/auth.ts", "buildToken"), "src_auth_ts:buildtoken");
});

test("(id-ns-separator-unambiguous) '::' does not appear in makeId output", () => {
  // Ensures "::" is a safe separator between repoKey and inner id
  const inner = makeId("a::b.ts", "func::Name");
  assert.ok(!inner.includes("::"), "makeId output must not contain '::'");
  // After namespacing, only one '::' exists (the separator)
  const ns = makeNamespacedId("my-repo", "a::b.ts", "func::Name");
  const parts = ns.split("::");
  assert.equal(parts.length, 2, "only one '::' separator expected");
});

// ---------------------------------------------------------------------------
// normalizeLabel — unchanged (NFR-01)
// ---------------------------------------------------------------------------

test("(id-normalize-unchanged) normalizeLabel still collapses to underscores", () => {
  assert.equal(normalizeLabel("foo Bar-Baz"), "foo_bar_baz");
});

test("(id-split) splitIdentifier: camelCase, acronyms, snake_case, digits, paths", () => {
  assert.deepEqual(splitIdentifier("openFreshStore"), ["open", "fresh", "store"]);
  assert.deepEqual(splitIdentifier("HTTPServer2"), ["http", "server", "2"]);
  assert.deepEqual(splitIdentifier("memory_repository.ts"), ["memory", "repository", "ts"]);
  assert.deepEqual(splitIdentifier("kebab-case-name"), ["kebab", "case", "name"]);
  assert.deepEqual(splitIdentifier("Simple"), ["simple"]);
  assert.deepEqual(splitIdentifier(""), []);
});
