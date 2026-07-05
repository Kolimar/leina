// scip-id-parity-python.test.ts — Python id-parity GATE (sdd/scip-lang-rollout,
// wave C, task C2.1). Mirrors scip-id-parity.test.ts's Go gate / scip-id-
// parity-rust.test.ts's Rust gate exactly, over the single-root project
// fixture at test/fixtures/scip/python/ (real scip-python-produced
// index.scip — see that directory's README for regeneration instructions
// and empirical notes, including two Ola-A-design corrections found here:
// scip-python DOES accept --output, and NEVER populates display_name).
//
// Same asserts as the Go/Rust gates, PLUS a Python-specific one
// (scip-gate-python-nested-flatten): two homonymous nested functions in
// different closures must collapse to the SAME flat id (matching
// tree-sitter's own owner-less nested-function behavior) — the exact
// regression `flattenNestedFns` (scip-indexer.ts) exists to guarantee.
//
// If this test fails because Python's ids diverge from tree-sitter's and it
// is not a trivial implementation bug in scip-indexer.ts, the correct
// response is to STOP and re-scope (per the tasks.md gate protocol) — never
// to hack the fixture/dedup to force a pass. Per C2.3: a real failure here
// blocks wave C's wiring (registry/CLI/doctor/docs) but does NOT affect the
// Go or Rust gates (both already wired, wave A/B).
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-id-parity-python.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractFile } from "../src/infrastructure/extractors/treesitter.ts";
import { readScipDocuments } from "../src/infrastructure/extractors/semantic/scip-proto.ts";
import { deriveScipDocumentGraph } from "../src/infrastructure/extractors/semantic/scip-indexer.ts";
import { dedup } from "../src/application/graph/dedup.ts";
import type { GraphNode } from "../src/domain/graph/model.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/scip/python/", import.meta.url));
const SCIP_PATH = `${FIXTURE_DIR}index.scip`;
const SOURCE_FILES = ["main.py", "pkg/helper.py", "pkg/stub.pyi"];

async function extractBoth(): Promise<{ tsNodes: GraphNode[]; scipNodes: GraphNode[] }> {
  const tsNodes: GraphNode[] = [];
  for (const relPath of SOURCE_FILES) {
    const source = readFileSync(`${FIXTURE_DIR}${relPath}`, "utf8");
    const res = await extractFile(relPath, source, "python");
    tsNodes.push(...res.nodes);
  }

  const docs = [...readScipDocuments(SCIP_PATH)];
  assert.equal(docs.length, 3, "fixture index should contain exactly three Documents (main.py, pkg/helper.py, pkg/stub.pyi)");
  const scipNodes: GraphNode[] = [];
  for (const doc of docs) scipNodes.push(...deriveScipDocumentGraph(doc, "python").nodes);

  return { tsNodes, scipNodes };
}

test("(scip-gate-python-ids-identical) every tree-sitter definition id has a byte-identical SCIP counterpart", async () => {
  const { tsNodes, scipNodes } = await extractBoth();
  const scipIds = new Set(scipNodes.map((n) => n.id));

  const missing: string[] = [];
  for (const n of tsNodes) {
    if (!scipIds.has(n.id)) missing.push(`${n.id} (kind=${n.kind}, label=${n.label}, file=${n.sourceFile})`);
  }
  assert.deepEqual(
    missing,
    [],
    `SCIP is missing byte-identical ids for: ${missing.join(", ")}. ` +
      `This is the Python id-parity GATE (sdd/scip-lang-rollout wave C, task C2.1) — ` +
      `a mismatch here means dedup() would DUPLICATE nodes instead of merging them.`,
  );
});

test("(scip-gate-python-no-scip-only-surplus) SCIP does not introduce definitions tree-sitter can't see (this fixture)", async () => {
  const { tsNodes, scipNodes } = await extractBoth();
  const tsIds = new Set(tsNodes.map((n) => n.id));
  const surplus = scipNodes.map((n) => n.id).filter((id) => !tsIds.has(id));
  assert.deepEqual(surplus, [], `unexpected SCIP-only node id(s) for this fixture: ${surplus.join(", ")}`);
});

test("(scip-gate-python-dedup-merges) dedup() collapses the combined node set to tree-sitter's OWN (already-deduped) count", async () => {
  const { tsNodes, scipNodes } = await extractBoth();
  // Unlike Go, scip-python emits one SymbolInformation per PARAMETER too
  // (e.g. `Greeter#greet().(self)`) which folds to the SAME id as its owning
  // method/function (`"parameter"` is excluded from ID_CHAIN_SUFFIXES) — so
  // SCIP's own raw node array carries internal duplicates tree-sitter's
  // never had. The correct baseline is still `dedup(tsNodes)` (tree-sitter
  // itself has ZERO internal duplication for this fixture, unlike Rust's
  // struct+impl coalescing) — `dedup()` over the combined set must still
  // collapse to that same count, proving SCIP's ids MERGE rather than add.
  const tsOnlyDeduped = dedup(tsNodes, []);
  const combined = dedup([...tsNodes, ...scipNodes], []);
  assert.equal(
    combined.nodes.length,
    tsOnlyDeduped.nodes.length,
    `dedup() should merge SCIP nodes into tree-sitter's own deduped count of ${tsOnlyDeduped.nodes.length} — ` +
      `got ${combined.nodes.length} (a higher count means id divergence caused duplication instead of a merge)`,
  );
});

test("(scip-gate-python-specific-ids) file/class/method/function/pyi-stub ids match exactly", async () => {
  const { tsNodes, scipNodes } = await extractBoth();
  const byLabelAndFile = (nodes: GraphNode[]): Map<string, string> => new Map(nodes.map((n) => [`${n.sourceFile}::${n.label}`, n.id]));
  const ts = byLabelAndFile(tsNodes);
  const scip = byLabelAndFile(scipNodes);

  const expectations: [string, string][] = [
    ["main.py::main.py", "file"],
    ["main.py::outer_a()", "top-level function with nested closure"],
    ["main.py::main()", "top-level function"],
    ["pkg/helper.py::pkg/helper.py", "file"],
    ["pkg/helper.py::Greeter", "class"],
    ["pkg/helper.py::greet()", "method"],
    ["pkg/helper.py::add()", "top-level function"],
    ["pkg/stub.pyi::pkg/stub.pyi", "file (.pyi stub)"],
    ["pkg/stub.pyi::stub_func()", ".pyi stub function"],
  ];
  for (const [key, what] of expectations) {
    assert.ok(ts.has(key), `tree-sitter fixture must define a node for ${what} (${key})`);
    assert.equal(scip.get(key), ts.get(key), `id mismatch for ${what} (${key})`);
  }
});

test("(scip-gate-python-nested-flatten) two homonymous nested 'helper' functions in different closures collapse to ONE flat id", async () => {
  const { tsNodes, scipNodes } = await extractBoth();

  const helperIdsOf = (nodes: GraphNode[]) =>
    nodes.filter((n) => n.sourceFile === "main.py" && n.label === "helper()").map((n) => n.id);
  const tsHelperIds = helperIdsOf(tsNodes);
  const scipHelperIds = helperIdsOf(scipNodes);

  // tree-sitter itself already collapses both nested closures to ONE flat id
  // (it never tracks an enclosing FUNCTION as an owner) — so BOTH raw arrays
  // have length 2 (one per closure) but only ONE distinct id.
  assert.equal(tsHelperIds.length, 2, "tree-sitter fixture should define 2 nested 'helper()' occurrences (outer_a, outer_b)");
  assert.equal(new Set(tsHelperIds).size, 1, "tree-sitter's own 2 nested helper() ids must already be flat/identical");
  assert.ok(scipHelperIds.length >= 1, "SCIP must translate at least one 'helper()' occurrence");
  assert.equal(new Set(scipHelperIds).size, 1, "SCIP's nested helper() ids must collapse to ONE flat id — this is what flattenNestedFns exists to guarantee");
  assert.equal([...new Set(scipHelperIds)][0], [...new Set(tsHelperIds)][0], "the flat helper() id must be byte-identical between tree-sitter and SCIP");
});

test("(scip-gate-python-cross-file-call-site) main()'s callees (Greeter.greet, add) both translate, from separate Documents in ONE index", async () => {
  const { tsNodes, scipNodes } = await extractBoth();
  const scipIds = new Set(scipNodes.map((n) => n.id));
  const mainNode = tsNodes.find((n) => n.sourceFile === "main.py" && n.label === "main()");
  const greetNode = tsNodes.find((n) => n.sourceFile === "pkg/helper.py" && n.label === "greet()");
  const addNode = tsNodes.find((n) => n.sourceFile === "pkg/helper.py" && n.label === "add()");
  assert.ok(mainNode, "tree-sitter fixture must define main.py's main()");
  assert.ok(greetNode, "tree-sitter fixture must define pkg/helper.py's Greeter.greet()");
  assert.ok(addNode, "tree-sitter fixture must define pkg/helper.py's add()");
  assert.ok(scipIds.has(mainNode.id), "SCIP must translate main.py's main() (cross-file caller)");
  assert.ok(scipIds.has(greetNode.id), "SCIP must translate pkg/helper.py's Greeter.greet() (cross-file callee)");
  assert.ok(scipIds.has(addNode.id), "SCIP must translate pkg/helper.py's add() (cross-file callee)");
});

// ---------------------------------------------------------------------------
// Fail-closed guard (task C2.2) — reusing the derivation-level guard already
// exercised generically in test/scip-indexer-translate.test.ts (task A1.7),
// asserted here specifically against a Python-shaped symbol with NO
// fallbackKind mapping (a bare `meta`-suffixed descriptor, which IS kept in
// the id chain but maps to no NodeKind) — proving a document that has
// symbols but zero translatable definitions produces ONLY the file node,
// never a silently-dropped or silently-invented one.
// ---------------------------------------------------------------------------

test("(scip-gate-python-fail-closed-no-nodes) a document with symbols but zero translatable definitions yields only the file node", () => {
  const untranslatable = "scip-python python fixture 0.0.0 mod/untranslatable:";
  const document = {
    relativePath: "mod.py",
    language: "python",
    occurrences: [],
    symbols: [{ symbol: untranslatable, kind: 0, displayName: "", relationships: [] }],
  };
  const { nodes } = deriveScipDocumentGraph(document, "python");
  assert.equal(nodes.length, 1, "only the synthetic file node should be produced — the untranslatable symbol must not silently become a node");
  assert.equal(nodes[0]!.kind, "module", "the sole node must be the file/module node, not an invented definition");
});
