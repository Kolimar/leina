// source-size-cap.test.ts — the per-file size cap on graph sources.
//
// Extractors (tree-sitter, YAML, ts-morph) and the manifest hash read every source whole,
// so one multi-megabyte (virtually always generated) file used to cost unbounded memory
// and time on every build and freshness check. Files above MAX_SOURCE_BYTES are skipped
// with a diagnostic — and the build and the freshness gate must AGREE on that, or a
// skipped file would read as "added" forever and re-trigger a rebuild on every query.
// Run: node --no-warnings --experimental-strip-types --test test/source-size-cap.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOURCE_BYTES, partitionBySize } from "../src/application/graph/sources.ts";
import { isStale, readManifest } from "../src/application/graph/manifest.ts";
import { buildGraph, type BuildReport } from "../src/application/graph/build.ts";
import { buildDefaultRegistry } from "../src/cli/wiring.ts";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";

/** A syntactically valid TS file of exactly `bytes` bytes (one function + padding comment). */
function tsOfSize(bytes: number): string {
  const head = "export function giant(): number { return 1; }\n// ";
  return head + "x".repeat(bytes - head.length);
}

async function build(dir: string): Promise<{ report: BuildReport; files: string[]; err: string }> {
  const store = new GraphStore(join(dir, "graph.db"));
  const original = process.stderr.write.bind(process.stderr);
  let err = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    const report = await buildGraph(dir, store, await buildDefaultRegistry());
    const files = [...new Set(store.allNodes().map((n) => n.sourceFile))];
    return { report, files, err };
  } finally {
    process.stderr.write = original;
    store.close();
  }
}

test("(cap-1) partitionBySize keeps files up to the cap and reports larger ones with their size", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-cap-part-"));
  try {
    writeFileSync(join(dir, "at-cap.ts"), tsOfSize(MAX_SOURCE_BYTES));
    writeFileSync(join(dir, "over.ts"), tsOfSize(MAX_SOURCE_BYTES + 1));
    const { kept, oversize } = partitionBySize([join(dir, "at-cap.ts"), join(dir, "over.ts"), join(dir, "gone.ts")]);
    assert.deepEqual(kept, [join(dir, "at-cap.ts"), join(dir, "gone.ts")], "at-cap kept; a vanished file is left to the build");
    assert.deepEqual(oversize, [{ file: join(dir, "over.ts"), bytes: MAX_SOURCE_BYTES + 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(cap-2) build skips an oversize source with a diagnostic; manifest and freshness agree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-cap-build-"));
  try {
    writeFileSync(join(dir, "small.ts"), "export function small(): number { return 1; }\n");
    writeFileSync(join(dir, "huge.ts"), tsOfSize(MAX_SOURCE_BYTES + 1));
    const { report, files, err } = await build(dir);

    assert.deepEqual(report.oversizeSkipped, ["huge.ts"]);
    assert.ok(!files.includes("huge.ts"), "no node extracted from the oversize file");
    assert.ok(files.includes("small.ts"), "normal sources still extracted");
    assert.match(err, /skipped huge\.ts .*size cap/, "stderr diagnostic names the file");
    assert.ok(!("huge.ts" in (readManifest(dir)?.files ?? {})), "manifest never hashes it");
    assert.deepEqual(isStale(dir), { stale: false, reason: "fresh" }, "an untracked oversize file is not 'added'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(cap-3) a tracked source that grows past the cap is stale; the rebuild drops it and is fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-cap-grow-"));
  try {
    writeFileSync(join(dir, "grow.ts"), "export function grow(): number { return 1; }\n");
    await build(dir);
    writeFileSync(join(dir, "grow.ts"), tsOfSize(MAX_SOURCE_BYTES + 1));
    assert.deepEqual(isStale(dir), { stale: true, reason: "touched:grow.ts" });

    const { report, files } = await build(dir);
    assert.deepEqual(report.oversizeSkipped, ["grow.ts"]);
    assert.ok(!files.includes("grow.ts"), "dropped from the graph");
    assert.equal(isStale(dir).stale, false, "fresh after the rebuild");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
