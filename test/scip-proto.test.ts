// scip-proto.test.ts — unit tests for the hand-rolled protobuf wire-format
// reader (src/infrastructure/extractors/semantic/scip-proto.ts).
//
// Covers: varint/zigzag decoding vectors, length-delimited/packed-repeated
// decoding via a REAL `.scip` fixture (generated with scip-go — see
// test/fixtures/scip/go/README.md for regeneration instructions), and the
// "unknown field never throws" contract (Phase 1, tasks 1.1/1.2).
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-proto.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  readScipDocuments,
  readScipMetadata,
  SYMBOL_ROLE_DEFINITION,
  zigzagDecode,
} from "../src/infrastructure/extractors/semantic/scip-proto.ts";
import {
  encodeDocument,
  encodeOccurrence,
  indexDocumentField,
  indexMetadataField,
  stringField,
  unknownVarintField,
  wrapAsField,
} from "./helpers/scip-encode.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/scip/go/index.scip", import.meta.url));

// ---------------------------------------------------------------------------
// zigzag — vectors from the protobuf encoding spec
// ---------------------------------------------------------------------------

test("(scip-proto-zigzag) zigzagDecode matches the canonical protobuf vectors", () => {
  assert.equal(zigzagDecode(0), 0);
  assert.equal(zigzagDecode(1), -1);
  assert.equal(zigzagDecode(2), 1);
  assert.equal(zigzagDecode(3), -2);
  assert.equal(zigzagDecode(4294967294), 2147483647);
  assert.equal(zigzagDecode(4294967295), -2147483648);
});

// ---------------------------------------------------------------------------
// Real fixture — length-delimited/packed decoding end to end
// ---------------------------------------------------------------------------

test("(scip-proto-metadata) readScipMetadata reads tool_info from the real scip-go fixture", () => {
  const meta = readScipMetadata(FIXTURE);
  assert.ok(meta, "metadata must be present");
  assert.equal(meta.toolInfo?.name, "scip-go");
  assert.ok(meta.projectRoot.length > 0);
});

test("(scip-proto-documents) readScipDocuments streams the real fixture's single Document with occurrences/symbols", () => {
  const docs = [...readScipDocuments(FIXTURE)];
  assert.equal(docs.length, 1);
  const doc = docs[0]!;
  assert.equal(doc.relativePath, "main.go");
  assert.ok(doc.occurrences.length > 0, "must decode packed-repeated range ints into occurrences");
  assert.ok(doc.symbols.length > 0, "must decode SymbolInformation entries");

  const fooDef = doc.occurrences.find(
    (o) => o.symbol.endsWith("/Foo().") && (o.symbolRoles & SYMBOL_ROLE_DEFINITION) !== 0,
  );
  assert.ok(fooDef, "Foo() definition occurrence must be present");
  assert.ok(fooDef.range, "range must decode (packed varints)");
  assert.ok(fooDef.enclosingRange, "enclosing_range must decode (packed varints)");

  const barSym = doc.symbols.find((s) => s.symbol.endsWith("/Bar#"));
  assert.ok(barSym, "Bar# SymbolInformation must be present");
  assert.ok(
    barSym.relationships.some((r) => r.isImplementation),
    "Bar# must carry an is_implementation relationship to Greeter#",
  );
});

// ---------------------------------------------------------------------------
// Unknown field — never throws (Phase 1 task 1.2)
// ---------------------------------------------------------------------------

test("(scip-proto-unknown-field) an unrecognized top-level Index field is skipped, never throws", () => {
  const synthetic = Buffer.concat([
    indexMetadataField("test-tool", "0.0.1"),
    unknownVarintField(99, 42), // a field number this parser does not know about
    indexDocumentField({ relativePath: "a.go", occurrences: [], symbols: [] }),
  ]);
  const path = fileURLToPath(new URL("./fixtures/scip/synthetic-unknown-field.scip", import.meta.url));
  writeFileSync(path, synthetic);
  try {
    assert.doesNotThrow(() => {
      const docs = [...readScipDocuments(path)];
      assert.equal(docs.length, 1);
      assert.equal(docs[0]!.relativePath, "a.go");
    });
    assert.doesNotThrow(() => {
      const meta = readScipMetadata(path);
      assert.equal(meta?.toolInfo?.name, "test-tool");
    });
  } finally {
    rmSync(path, { force: true });
  }
});

test("(scip-proto-unknown-nested-field) an unrecognized nested Occurrence field is skipped, never throws", () => {
  // Field 99 inside an Occurrence submessage: a hypothetical future addition.
  const occBytes = Buffer.concat([
    encodeOccurrence({ range: [1, 0, 5], symbol: "local 0", symbolRoles: SYMBOL_ROLE_DEFINITION }),
    unknownVarintField(99, 7),
  ]);
  const docBytes = Buffer.concat([stringField(1, "b.go"), wrapAsField(2, occBytes)]);
  const synthetic = wrapAsField(2, docBytes); // Index.documents (field 2)
  const path = fileURLToPath(new URL("./fixtures/scip/synthetic-unknown-nested.scip", import.meta.url));
  writeFileSync(path, synthetic);
  try {
    const docs = [...readScipDocuments(path)];
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.relativePath, "b.go");
    assert.equal(docs[0]!.occurrences.length, 1);
    assert.equal(docs[0]!.occurrences[0]!.symbol, "local 0");
  } finally {
    rmSync(path, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Uses the imported encodeDocument helper too, so the generic helper module is
// exercised end to end (not just the manual field composition above).
// ---------------------------------------------------------------------------

test("(scip-proto-roundtrip) a hand-encoded synthetic Document round-trips through the decoder", () => {
  const docBytes = encodeDocument({
    relativePath: "synthetic.go",
    language: "go",
    occurrences: [{ range: [0, 0, 3], symbol: "local 0", symbolRoles: SYMBOL_ROLE_DEFINITION }],
    symbols: [{ symbol: "local 0", kind: 61, displayName: "x" }],
  });
  const synthetic = wrapAsField(2, docBytes); // Index.documents (field 2)
  const path = fileURLToPath(new URL("./fixtures/scip/synthetic-roundtrip.scip", import.meta.url));
  writeFileSync(path, synthetic);
  try {
    const docs = [...readScipDocuments(path)];
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.relativePath, "synthetic.go");
    assert.equal(docs[0]!.language, "go");
    assert.equal(docs[0]!.symbols[0]!.displayName, "x");
  } finally {
    rmSync(path, { force: true });
  }
});
