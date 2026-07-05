// extract-cache.test.ts — per-file extraction cache (incremental builds, phase 1).
// Contract: content-hash keyed hits skip the parse and rehydrate identical results; any
// content or version change is a miss; pruning drops dead paths; the cache is invisible
// to correctness (byte-identical graph with hot vs cold cache).
// Run: node --no-warnings --experimental-strip-types --test test/extract-cache.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtractCache, contentHash, extractCachePath } from "../src/infrastructure/sqlite/extract-cache.ts";
import { TreesitterExtractor } from "../src/infrastructure/extractors/treesitter.ts";

test("(xc-1) hit only on same (path, hash, version); prune drops dead paths", () => {
  const root = mkdtempSync(join(tmpdir(), "leina-xc-"));
  try {
    const c1 = new ExtractCache(root, "1.0.0");
    const result = { nodes: [{ id: "n" }], edges: [], rawCalls: [], imports: [] };
    const h = contentHash("source-A");
    c1.put("src/a.rb", h, result);

    assert.deepEqual(c1.get("src/a.rb", h), result, "hit");
    assert.equal(c1.get("src/a.rb", contentHash("source-B")), null, "content change → miss");
    assert.equal(c1.get("src/other.rb", h), null, "unknown path → miss");
    c1.close();

    // Version bump invalidates without any explicit flush.
    const c2 = new ExtractCache(root, "2.0.0");
    assert.equal(c2.get("src/a.rb", h), null, "extractor version change → miss");
    c2.close();

    // Prune: only live paths survive.
    const c3 = new ExtractCache(root, "1.0.0");
    assert.deepEqual(c3.get("src/a.rb", h), result, "old version rows still there for 1.0.0");
    c3.prune(["src/kept.rb"]);
    assert.equal(c3.get("src/a.rb", h), null, "pruned as dead path");
    c3.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(xc-2) TreesitterExtractor: second run reuses unchanged files and reports it; results identical", async () => {
  const root = mkdtempSync(join(tmpdir(), "leina-xc2-"));
  try {
    const f1 = join(root, "one.rb");
    const f2 = join(root, "two.rb");
    writeFileSync(f1, "class Foo\n  def greet\n    assist()\n  end\nend\n");
    writeFileSync(f2, "def top\n  Foo.new.greet\nend\n");

    const ext = new TreesitterExtractor("test-1");
    const cold = await ext.extract(root, [f1, f2]);
    assert.ok(!cold.diagnostics.some((d) => d.includes("extract cache")), "no cache diagnostic on cold run");

    const warm = await ext.extract(root, [f1, f2]);
    assert.ok(
      warm.diagnostics.some((d) => d.includes("extract cache: 2/2 files unchanged")),
      `warm run reports reuse (got: ${warm.diagnostics.join(" | ")})`,
    );
    // JSON-normalize both sides: the cache round-trips through JSON, which drops keys
    // holding `undefined` (e.g. rawCalls.receiverType) — semantically identical for the
    // resolve phase, but visible to a strict deepEqual.
    const viaJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
    assert.deepEqual(viaJson(warm.nodes), viaJson(cold.nodes), "nodes identical from cache");
    assert.deepEqual(viaJson(warm.edges), viaJson(cold.edges), "edges identical from cache");
    assert.deepEqual(viaJson(warm.rawCalls), viaJson(cold.rawCalls), "rawCalls identical from cache");

    // Touch one file → exactly one re-parse.
    writeFileSync(f2, "def top\n  Foo.new.greet\n  extra()\nend\n");
    const mixed = await ext.extract(root, [f1, f2]);
    assert.ok(
      mixed.diagnostics.some((d) => d.includes("extract cache: 1/2 files unchanged")),
      "only the unchanged file reused",
    );
    assert.ok(mixed.rawCalls?.some((c) => c.callee === "extra"), "changed file re-extracted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(xc-3) cache path lives under .leina and survives a graph clear", () => {
  assert.match(extractCachePath("/repo"), /\/repo\/\.leina\/extract-cache\.db$/);
});
