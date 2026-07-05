// scip-indexer-translate.test.ts — unit tests for sdd/scip-lang-rollout Ola A
// (tasks A1.4-A1.8/A2.2): the per-language generalizations added to
// scip-indexer.ts on top of the existing `"go"`-only translation logic
// (test/scip-indexer.test.ts) and the Go golden gate (test/scip-id-parity.test.ts):
//
//   - `normalizeImpl` (Rust `impl` self-type rewrite — task A1.4)
//   - `fallbackKind` (`kind===0` suffix fallback — task A1.5)
//   - Python nested-function flattening (task A1.6)
//   - `runScipIndexer`'s fail-closed guard (task A1.7)
//
// The Ola A design assumed scip-python had no `--output` flag and needed a
// `"cwd-default"` output strategy (guarded against clobbering a pre-existing
// file under the project root). Ola C task C1.3 confirmed empirically
// against the real `@sourcegraph/scip-python` 0.6.6 binary that this
// assumption was WRONG: `scip-python index --output <path>` works exactly
// like scip-go/rust-analyzer. `runScipIndexer` was simplified accordingly
// (single explicit-`--output` shape, no strategy branching) — the two tests
// that exercised the now-removed `"cwd-default"` mechanism specifically
// (successful resolve+cleanup, pre-existing-file no-clobber guard) were
// removed along with it; the fail-closed guard below is unaffected (it never
// depended on which output strategy produced the file).
//
// Uses the synthetic symbol-string builders + protobuf encoder added to
// test/helpers/scip-encode.ts (task A2.1) so the guard/cwd-default tests
// exercise the REAL spawn->read->cleanup pipeline (via
// test/helpers/fake-scip-indexer.ts) rather than only the in-memory
// translation functions.
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-indexer-translate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeId } from "../src/domain/shared/id.ts";
import type { ScipDocument } from "../src/infrastructure/extractors/semantic/scip-proto.ts";
import { deriveScipDocumentGraph, runScipIndexer, translateScipSymbol } from "../src/infrastructure/extractors/semantic/scip-indexer.ts";
import {
  encodeIndex,
  pythonKind0FunctionSymbol,
  pythonKind0MethodSymbol,
  pythonKind0TypeSymbol,
  pythonNestedFunctionSymbol,
  rustImplMethodSymbol,
  scipHead,
} from "./helpers/scip-encode.ts";

function doc(relativePath: string, symbols: ScipDocument["symbols"] = []): ScipDocument {
  return { relativePath, language: "go", occurrences: [], symbols };
}

// ---------------------------------------------------------------------------
// normalizeImpl (task A1.4) — Rust `impl` self-type rewrite
// ---------------------------------------------------------------------------

const RUST_HEAD = scipHead("scip-rust", "cargo", "fixture", "0.1.0");

test("(scip-impl-distinct-owners) two impl blocks in the same file get distinct owners, never a shared 'impl' owner", () => {
  const symA = rustImplMethodSymbol(RUST_HEAD, "Foo", "a");
  const symB = rustImplMethodSymbol(RUST_HEAD, "Bar", "b");
  const document = doc("lib.rs");
  const idA = translateScipSymbol(document, symA, "rust");
  const idB = translateScipSymbol(document, symB, "rust");
  assert.equal(idA, makeId(makeId("lib.rs", "Foo"), "a"));
  assert.equal(idB, makeId(makeId("lib.rs", "Bar"), "b"));
  assert.notEqual(idA, idB, "methods of two different impl blocks must not collide under a shared 'impl' owner");
});

test("(scip-impl-trait-self-type) impl Trait for Foo -> owner is the self-type Foo, not the trait", () => {
  const sym = rustImplMethodSymbol(RUST_HEAD, "Foo", "greet", "Greeter");
  const id = translateScipSymbol(doc("lib.rs"), sym, "rust");
  assert.equal(id, makeId(makeId("lib.rs", "Foo"), "greet"));
});

// ---------------------------------------------------------------------------
// fallbackKind (task A1.5) — kind===0 suffix fallback (scip-python)
// ---------------------------------------------------------------------------

const PY_HEAD = scipHead("scip-python", "pip", "fixture", "0.1.0");

test("(scip-fallback-type) kind=0 bare type descriptor -> typeFallback (class), not dropped", () => {
  const sym = pythonKind0TypeSymbol(PY_HEAD, "Foo");
  const document = doc("mod.py", [{ symbol: sym, kind: 0, displayName: "Foo", relationships: [] }]);
  const { nodes } = deriveScipDocumentGraph(document, "python");
  const fooId = makeId("mod.py", "Foo");
  const node = nodes.find((n) => n.id === fooId);
  assert.ok(node, "a kind=0 type descriptor must still produce a node via the fallback");
  assert.equal(node.kind, "class");
});

test("(scip-fallback-method-owner) kind=0 method WITH an owner -> method node", () => {
  const sym = pythonKind0MethodSymbol(PY_HEAD, "Foo", "bar");
  const document = doc("mod.py", [{ symbol: sym, kind: 0, displayName: "bar", relationships: [] }]);
  const { nodes } = deriveScipDocumentGraph(document, "python");
  const methodId = makeId(makeId("mod.py", "Foo"), "bar");
  const node = nodes.find((n) => n.id === methodId);
  assert.ok(node, "a kind=0 method with an owner must still produce a node via the fallback");
  assert.equal(node.kind, "method");
});

test("(scip-fallback-function-no-owner) kind=0 method WITHOUT an owner -> function node", () => {
  const sym = pythonKind0FunctionSymbol(PY_HEAD, "standalone");
  const document = doc("mod.py", [{ symbol: sym, kind: 0, displayName: "standalone", relationships: [] }]);
  const { nodes } = deriveScipDocumentGraph(document, "python");
  const fnId = makeId("mod.py", "standalone");
  const node = nodes.find((n) => n.id === fnId);
  assert.ok(node, "a kind=0 top-level function must still produce a node via the fallback");
  assert.equal(node.kind, "function");
});

// ---------------------------------------------------------------------------
// Python nested-function flattening (task A1.6)
// ---------------------------------------------------------------------------

test("(scip-python-flatten) two homonymous nested functions in different closures flatten to the SAME id", () => {
  const symA = pythonNestedFunctionSymbol(PY_HEAD, "outer_a", "inner");
  const symB = pythonNestedFunctionSymbol(PY_HEAD, "outer_b", "inner");
  const document = doc("mod.py");
  const idA = translateScipSymbol(document, symA, "python");
  const idB = translateScipSymbol(document, symB, "python");
  const flatId = makeId("mod.py", "inner");
  assert.equal(idA, flatId, "a nested function's owner (its enclosing FUNCTION) must be dropped");
  assert.equal(idB, flatId, "two homonymous nested functions in different closures must collapse to one flat id");
});

test("(scip-python-flatten-not-rust) the SAME nested-descriptor shape is NOT flattened for Rust (flattenNestedFns=false)", () => {
  // Sanity check that flattening is per-language config, not a global behavior:
  // reusing the nested-function symbol shape under "rust" must keep the owner.
  const sym = pythonNestedFunctionSymbol(RUST_HEAD, "outer", "inner");
  const id = translateScipSymbol(doc("lib.rs"), sym, "rust");
  assert.equal(id, makeId(makeId("lib.rs", "outer"), "inner"));
});

// ---------------------------------------------------------------------------
// runScipIndexer fail-closed guard (task A1.7)
// ---------------------------------------------------------------------------

const HELPER = fileURLToPath(new URL("./helpers/fake-scip-indexer.ts", import.meta.url));
const FAKE_INDEXER_CMD = `${process.execPath} --no-warnings --experimental-strip-types ${HELPER}`;
const ENV_VAR = "LEINA_SCIP_PYTHON_INDEXER";
const FIXTURE_ENV_VAR = "LEINA_FAKE_SCIP_FIXTURE";

function withFakePythonIndexer<T>(fixturePath: string, fn: () => T): T {
  const prevArgv = process.env[ENV_VAR];
  const prevFixture = process.env[FIXTURE_ENV_VAR];
  process.env[ENV_VAR] = FAKE_INDEXER_CMD;
  process.env[FIXTURE_ENV_VAR] = fixturePath;
  try {
    return fn();
  } finally {
    if (prevArgv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prevArgv;
    if (prevFixture === undefined) delete process.env[FIXTURE_ENV_VAR];
    else process.env[FIXTURE_ENV_VAR] = prevFixture;
  }
}

function writeSyntheticFixture(scratchDir: string, name: string, doc_: Parameters<typeof encodeIndex>[0]): string {
  const path = join(scratchDir, name);
  writeFileSync(path, encodeIndex(doc_));
  return path;
}

test("(scip-run-guard-fail-closed) symbols present but NONE translate to a node -> runScipIndexer returns null", () => {
  const scratch = mkdtempSync(join(tmpdir(), "leina-scip-guard-"));
  const root = mkdtempSync(join(tmpdir(), "leina-scip-guard-root-"));
  try {
    // A `meta`-suffixed descriptor (`name:`) is kept in the id chain but has
    // no fallbackKind mapping (only `type`/`method` final suffixes do) — so
    // this document has 1 symbol and ZERO translatable definition nodes.
    const sym = `${PY_HEAD} extra:`;
    const fixturePath = writeSyntheticFixture(scratch, "guard.scip", {
      relativePath: "mod.py",
      language: "python",
      symbols: [{ symbol: sym, kind: 0, displayName: "extra" }],
    });
    withFakePythonIndexer(fixturePath, () => {
      const res = runScipIndexer("python", root);
      assert.equal(res, null, "an index with symbols but zero translatable nodes must not be claimed");
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("(scip-run-explicit-output-success) explicit --output: spawns, derives real nodes, and cleans up the ephemeral tmpDir", () => {
  const scratch = mkdtempSync(join(tmpdir(), "leina-scip-flag-"));
  const root = mkdtempSync(join(tmpdir(), "leina-scip-flag-root-"));
  try {
    const sym = pythonKind0TypeSymbol(PY_HEAD, "Foo");
    const fixturePath = writeSyntheticFixture(scratch, "flag.scip", {
      relativePath: "mod.py",
      language: "python",
      symbols: [{ symbol: sym, kind: 0, displayName: "Foo" }],
    });
    withFakePythonIndexer(fixturePath, () => {
      const res = runScipIndexer("python", root);
      assert.ok(res, "an explicit-output index with a translatable node must be claimed");
      const fooId = makeId("mod.py", "Foo");
      assert.ok(res.nodes.some((n) => n.id === fooId), "the derived node must be present in the result");
    });
    // The project root itself must never be written to — every language now
    // writes its output under an ephemeral tmpDir only (see runScipIndexer).
    assert.ok(!existsSync(join(root, "index.scip")), "the project root must never receive an index.scip file");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
