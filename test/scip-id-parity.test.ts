// scip-id-parity.test.ts — THE GATE (Phase 2 task 2.2).
//
// Extracts the SAME fixture (test/fixtures/scip/go/main.go) through BOTH
// tree-sitter (extractFile) and the SCIP pipeline (readScipDocuments +
// deriveScipDocumentGraph, over the real scip-go-generated
// test/fixtures/scip/go/index.scip — see that directory's README for
// regeneration instructions), then asserts:
//
//   1. Every id tree-sitter produces for a definition SCIP also has an
//      equivalent for is byte-IDENTICAL (never merely similar).
//   2. Feeding both node sets through the real dedup() collapses them to
//      the SAME count as tree-sitter alone — i.e. SCIP node ids merge with
//      tree-sitter's, they do NOT duplicate.
//
// If this test fails because SCIP's ids diverge from tree-sitter's and it is
// not a trivial implementation bug in scip-indexer.ts, the correct response
// is to STOP and re-scope (id-parity is the single highest-risk assumption
// of the whole scip-ingestion change) — never to hack the fixture/dedup to
// force a pass.
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-id-parity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractFile } from "../src/infrastructure/extractors/treesitter.ts";
import { readScipDocuments } from "../src/infrastructure/extractors/semantic/scip-proto.ts";
import { deriveScipDocumentGraph } from "../src/infrastructure/extractors/semantic/scip-indexer.ts";
import { dedup } from "../src/application/graph/dedup.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/scip/go/", import.meta.url));
const SOURCE_PATH = `${FIXTURE_DIR}main.go`;
const SCIP_PATH = `${FIXTURE_DIR}index.scip`;

async function extractBoth() {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const tsResult = await extractFile("main.go", source, "go");

  const docs = [...readScipDocuments(SCIP_PATH)];
  assert.equal(docs.length, 1, "fixture index should contain exactly one Document (main.go)");
  const scipResult = deriveScipDocumentGraph(docs[0]!, "go");

  return { tsResult, scipResult };
}

test("(scip-gate-ids-identical) every tree-sitter definition id has a byte-identical SCIP counterpart", async () => {
  const { tsResult, scipResult } = await extractBoth();
  const scipIds = new Set(scipResult.nodes.map((n) => n.id));

  const missing: string[] = [];
  for (const n of tsResult.nodes) {
    if (!scipIds.has(n.id)) missing.push(`${n.id} (kind=${n.kind}, label=${n.label})`);
  }
  assert.deepEqual(
    missing,
    [],
    `SCIP is missing byte-identical ids for: ${missing.join(", ")}. ` +
      `This is the id-parity GATE (spec scenario "paridad de id (spike scip-go)") — ` +
      `a mismatch here means dedup() would DUPLICATE nodes instead of merging them.`,
  );
});

test("(scip-gate-no-scip-only-surplus) SCIP does not introduce definitions tree-sitter can't see (this fixture)", async () => {
  const { tsResult, scipResult } = await extractBoth();
  const tsIds = new Set(tsResult.nodes.map((n) => n.id));
  const surplus = scipResult.nodes.map((n) => n.id).filter((id) => !tsIds.has(id));
  assert.deepEqual(surplus, [], `unexpected SCIP-only node id(s) for this fixture: ${surplus.join(", ")}`);
});

test("(scip-gate-dedup-merges) dedup() collapses the combined node set to tree-sitter's own count — no duplication", async () => {
  const { tsResult, scipResult } = await extractBoth();
  const combined = dedup([...tsResult.nodes, ...scipResult.nodes], []);
  assert.equal(
    combined.nodes.length,
    tsResult.nodes.length,
    `dedup() should merge SCIP nodes into tree-sitter's ${tsResult.nodes.length} — got ${combined.nodes.length} ` +
      `(a higher count means id divergence caused duplication instead of a merge)`,
  );
});

test("(scip-gate-specific-ids) the four Go definitions in the fixture match exactly by id (file, function, interface, struct, method)", async () => {
  const { tsResult, scipResult } = await extractBoth();
  const byId = (nodes: typeof tsResult.nodes) => new Map(nodes.map((n) => [n.label, n.id] as const));
  const ts = byId(tsResult.nodes);
  const scip = byId(scipResult.nodes);

  for (const label of ["main.go", "Foo()", "Greeter", "Bar", "Greet()"]) {
    assert.ok(ts.has(label), `tree-sitter fixture must define a node labeled "${label}"`);
    assert.equal(scip.get(label), ts.get(label), `id mismatch for "${label}"`);
  }
});
