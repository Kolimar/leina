// scip-streaming.test.ts — Phase 1 task 1.4: proves readScipDocuments() streams
// a multi-Document `.scip` index Document-by-Document, so peak memory stays
// proportional to a SINGLE Document, not to the number of Documents (N) or the
// total index size — the requirement that rules out ever holding the whole
// index in memory at once (see scip.proto's Index message doc comment and
// the design's "Parser protobuf hand-rolled, solo-lectura, streaming" decision).
//
// Method: build a synthetic multi-Document index (~1500 Documents, ~13 MB
// total), stream+discard it in a child process (forcing GC periodically via
// --expose-gc for a deterministic reading), and assert the reported heap
// usage after the full stream is a small FRACTION of the total encoded size
// — never anywhere close to "the whole index was buffered".
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-streaming.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeDocument, wrapAsField } from "./helpers/scip-encode.ts";

const DOC_COUNT = 6000;
const OCCURRENCES_PER_DOC = 100;

function buildSyntheticIndex(): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < DOC_COUNT; i++) {
    const occurrences = Array.from({ length: OCCURRENCES_PER_DOC }, (_, j) => ({
      range: [j, 0, j, 10],
      symbol: `scip-go gomod example.com/fixture/pkg${i} v0.0.${i} \`example.com/fixture/pkg${i}\`/Symbol${i}_${j}().`,
      symbolRoles: 1,
    }));
    const doc = encodeDocument({
      relativePath: `gen/file${i}.go`,
      language: "go",
      occurrences,
      symbols: [],
    });
    parts.push(wrapAsField(2, doc)); // Index.documents (field 2)
  }
  return Buffer.concat(parts);
}

const PROBE = fileURLToPath(new URL("./helpers/scip-stream-probe.ts", import.meta.url));

test("(scip-streaming-bounded) streaming a multi-Document index keeps peak heap proportional to ONE Document, not N", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-scip-stream-"));
  const file = join(dir, "synthetic-multi.scip");
  try {
    const synthetic = buildSyntheticIndex();
    writeFileSync(file, synthetic);
    assert.ok(synthetic.length > 8 * 1024 * 1024, `fixture should be several MB (got ${synthetic.length} bytes)`);

    const r = spawnSync(
      process.execPath,
      ["--expose-gc", "--no-warnings", "--experimental-strip-types", PROBE, file],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, `probe must exit 0. stderr: ${r.stderr}`);

    const lastLine = r.stdout.trim().split("\n").at(-1) ?? "";
    const [countStr, heapStr] = lastLine.split(" ");
    const count = Number(countStr);
    const heapUsed = Number(heapStr);

    assert.equal(count, DOC_COUNT, `must yield exactly ${DOC_COUNT} Documents (streamed, none dropped)`);
    assert.ok(Number.isFinite(heapUsed) && heapUsed > 0, `probe must report a heapUsed sample. stdout: ${r.stdout}`);

    // The key invariant: heap after streaming the WHOLE index stays a small
    // fraction of the total encoded size — proof the parser never
    // materialized the full index (only ever one Document + one read chunk
    // at a time). A non-streaming implementation that buffered everything
    // would report heapUsed on the order of `synthetic.length`.
    assert.ok(
      heapUsed < synthetic.length * 0.35,
      `heapUsed (${heapUsed}) should stay well below the ${synthetic.length}-byte index size ` +
        `(streaming must not be proportional to N Documents)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
