// scip-id-parity-rust.test.ts — Rust id-parity GATE (sdd/scip-lang-rollout,
// wave B, task B2.1). Mirrors scip-id-parity.test.ts's Go gate exactly, over
// the 2-crate workspace fixture at test/fixtures/scip/rust/ (real
// rust-analyzer-produced index.scip — see that directory's README for
// regeneration instructions and empirical notes).
//
// Same asserts as the Go gate, PLUS a Rust-specific one (scip-gate-rust-impl-
// owners-distinct): two impl blocks sharing a method NAME ("greet", on Foo's
// inherent impl and Bar's trait impl, in the SAME file) must resolve to
// DIFFERENT owner ids — the exact regression `normalizeImpl` exists to
// prevent (rust-analyzer's synthetic `impl#[SelfType]` descriptor, left
// unrewritten, would collapse every impl block in a file under one shared
// invented `impl` owner).
//
// If this test fails because Rust's ids diverge from tree-sitter's and it is
// not a trivial implementation bug in scip-indexer.ts, the correct response
// is to STOP and re-scope (per the tasks.md gate protocol) — never to hack
// the fixture/dedup to force a pass. Per B2.3: a real failure here blocks
// wave B's wiring (registry/CLI/doctor/docs) but does NOT affect the Go gate
// or a parallel Python wave.
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-id-parity-rust.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractFile } from "../src/infrastructure/extractors/treesitter.ts";
import { readScipDocuments } from "../src/infrastructure/extractors/semantic/scip-proto.ts";
import { deriveScipDocumentGraph } from "../src/infrastructure/extractors/semantic/scip-indexer.ts";
import { dedup } from "../src/application/graph/dedup.ts";
import type { GraphNode } from "../src/domain/graph/model.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/scip/rust/", import.meta.url));
const SCIP_PATH = `${FIXTURE_DIR}index.scip`;
const SOURCE_FILES = ["crate_a/src/lib.rs", "crate_b/src/main.rs"];

async function extractBoth(): Promise<{ tsNodes: GraphNode[]; scipNodes: GraphNode[] }> {
  const tsNodes: GraphNode[] = [];
  for (const relPath of SOURCE_FILES) {
    const source = readFileSync(`${FIXTURE_DIR}${relPath}`, "utf8");
    const res = await extractFile(relPath, source, "rust");
    tsNodes.push(...res.nodes);
  }

  const docs = [...readScipDocuments(SCIP_PATH)];
  assert.equal(docs.length, 2, "fixture index should contain exactly two Documents (crate_a/src/lib.rs, crate_b/src/main.rs)");
  const scipNodes: GraphNode[] = [];
  for (const doc of docs) scipNodes.push(...deriveScipDocumentGraph(doc, "rust").nodes);

  return { tsNodes, scipNodes };
}

test("(scip-gate-rust-ids-identical) every tree-sitter definition id has a byte-identical SCIP counterpart", async () => {
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
      `This is the Rust id-parity GATE (sdd/scip-lang-rollout wave B, task B2.1) — ` +
      `a mismatch here means dedup() would DUPLICATE nodes instead of merging them.`,
  );
});

test("(scip-gate-rust-no-scip-only-surplus) SCIP does not introduce definitions tree-sitter can't see (this fixture)", async () => {
  const { tsNodes, scipNodes } = await extractBoth();
  const tsIds = new Set(tsNodes.map((n) => n.id));
  const surplus = scipNodes.map((n) => n.id).filter((id) => !tsIds.has(id));
  assert.deepEqual(surplus, [], `unexpected SCIP-only node id(s) for this fixture: ${surplus.join(", ")}`);
});

test("(scip-gate-rust-dedup-merges) dedup() collapses the combined node set to tree-sitter's OWN (already-deduped) count", async () => {
  const { tsNodes, scipNodes } = await extractBoth();
  // Unlike the Go fixture, Rust's tree-sitter output itself already carries
  // internal duplicate ids: a `struct Foo` declaration AND its separate
  // `impl Foo { ... }` block both resolve to `makeId(relPath, "Foo")` (by
  // design — see treesitter.ts's rust `classTypes`/`defName`, "impl_item"
  // coalesces with its Self type). So the correct baseline to compare
  // against is `dedup(tsNodes)`, not the raw (pre-dedup) tree-sitter count.
  const tsOnlyDeduped = dedup(tsNodes, []);
  const combined = dedup([...tsNodes, ...scipNodes], []);
  assert.equal(
    combined.nodes.length,
    tsOnlyDeduped.nodes.length,
    `dedup() should merge SCIP nodes into tree-sitter's own deduped count of ${tsOnlyDeduped.nodes.length} — ` +
      `got ${combined.nodes.length} (a higher count means id divergence caused duplication instead of a merge)`,
  );
});

test("(scip-gate-rust-specific-ids) file/function/trait/struct/enum/union ids match exactly", async () => {
  const { tsNodes, scipNodes } = await extractBoth();
  const byLabelAndFile = (nodes: GraphNode[]): Map<string, string> => new Map(nodes.map((n) => [`${n.sourceFile}::${n.label}`, n.id]));
  const ts = byLabelAndFile(tsNodes);
  const scip = byLabelAndFile(scipNodes);

  const expectations: [string, string][] = [
    ["crate_a/src/lib.rs::crate_a/src/lib.rs", "file"],
    ["crate_a/src/lib.rs::Foo", "inherent-impl struct"],
    ["crate_a/src/lib.rs::Greeter", "trait"],
    ["crate_a/src/lib.rs::Bar", "trait-impl struct"],
    ["crate_a/src/lib.rs::Direction", "enum"],
    ["crate_a/src/lib.rs::Number", "union"],
    ["crate_a/src/lib.rs::describe()", "top-level function"],
    ["crate_b/src/main.rs::crate_b/src/main.rs", "file"],
    ["crate_b/src/main.rs::main()", "binary entrypoint"],
  ];
  for (const [key, what] of expectations) {
    assert.ok(ts.has(key), `tree-sitter fixture must define a node for ${what} (${key})`);
    assert.equal(scip.get(key), ts.get(key), `id mismatch for ${what} (${key})`);
  }
});

test("(scip-gate-rust-impl-owners-distinct) Foo/Bar/Greeter's same-named 'greet' methods resolve to 3 DIFFERENT owner ids", async () => {
  const { tsNodes, scipNodes } = await extractBoth();

  // All three "greet()" definitions share a label; disambiguate by walking
  // each node set's OWN "contains this class label" structure instead —
  // simplest robust way: every node set must contain exactly 3 nodes labeled
  // "greet()", and their ids must all be pairwise distinct (no shared
  // invented "impl" owner collapsing them).
  const greetIdsOf = (nodes: GraphNode[]) => nodes.filter((n) => n.label === "greet()").map((n) => n.id);
  const tsGreetIds = greetIdsOf(tsNodes);
  const scipGreetIds = greetIdsOf(scipNodes);

  assert.equal(tsGreetIds.length, 3, `tree-sitter fixture should define exactly 3 "greet()" methods (Foo/Bar/Greeter), got ${tsGreetIds.length}`);
  assert.equal(scipGreetIds.length, 3, `SCIP should translate exactly 3 "greet()" methods (Foo/Bar/Greeter), got ${scipGreetIds.length}`);
  assert.equal(new Set(tsGreetIds).size, 3, "tree-sitter's 3 greet() ids must be pairwise distinct (no owner collision)");
  assert.equal(new Set(scipGreetIds).size, 3, "SCIP's 3 greet() ids must be pairwise distinct — this is what normalizeImpl exists to guarantee");
  assert.deepEqual(new Set(scipGreetIds), new Set(tsGreetIds), "the SET of 3 greet() owner ids must be byte-identical between tree-sitter and SCIP");
});

test("(scip-gate-rust-cross-crate-call-site) crate_b's main() and crate_a's describe() both translate, from 2 separate Documents in ONE index", async () => {
  const { tsNodes, scipNodes } = await extractBoth();
  const scipIds = new Set(scipNodes.map((n) => n.id));
  const mainNode = tsNodes.find((n) => n.sourceFile === "crate_b/src/main.rs" && n.label === "main()");
  const describeNode = tsNodes.find((n) => n.sourceFile === "crate_a/src/lib.rs" && n.label === "describe()");
  assert.ok(mainNode, "tree-sitter fixture must define crate_b's main()");
  assert.ok(describeNode, "tree-sitter fixture must define crate_a's describe()");
  assert.ok(scipIds.has(mainNode.id), "SCIP must translate crate_b's main() (cross-crate caller)");
  assert.ok(scipIds.has(describeNode.id), "SCIP must translate crate_a's describe() (cross-crate callee)");
});
