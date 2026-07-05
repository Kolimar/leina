// scip-extractor.test.ts — ScipExtractor adapter contract (task 3.1): verify()
// with the fixture, extract() whole-project, D4 claiming (errors empty only on
// success), and degradation when the indexer is unavailable/fails — all
// exercised end-to-end via `test/helpers/fake-scip-indexer.ts` (no real Go
// toolchain/scip-go required).
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-extractor.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScipExtractor } from "../src/infrastructure/extractors/semantic/scip.ts";

const HELPER = fileURLToPath(new URL("./helpers/fake-scip-indexer.ts", import.meta.url));
const FAKE_INDEXER_CMD = `${process.execPath} --no-warnings --experimental-strip-types ${HELPER}`;
const ENV_VAR = "LEINA_SCIP_GO_INDEXER";

function withFakeIndexer<T>(argv: string | undefined, fn: () => T): T {
  const prev = process.env[ENV_VAR];
  if (argv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = argv;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
}

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

test("(scip-ext-1) verify(): skip when the indexer isn't in PATH (this sandbox has no scip-go)", async () => {
  await withFakeIndexer(undefined, async () => {
    const ext = new ScipExtractor("go", "test");
    const check = await ext.verify();
    assert.equal(check.status, "skip");
    assert.match(check.message ?? "", /scip install go|SCIP indexer/);
  });
});

test("(scip-ext-2) verify(): ok with the fake indexer, actual node/edge counts match the real fixture", async () => {
  await withFakeIndexer(FAKE_INDEXER_CMD, async () => {
    const ext = new ScipExtractor("go", "test");
    const check = await ext.verify();
    assert.equal(check.status, "ok", check.message);
    assert.equal(check.actual?.nodes, 5);
    assert.ok((check.actual?.edges ?? 0) > 0);
    assert.equal(check.result?.errors.length, 0);
  });
});

test("(scip-ext-3) verify(): never throws even if the indexer exits non-zero", async () => {
  await withFakeIndexer(`${FAKE_INDEXER_CMD} --fail`, async () => {
    const ext = new ScipExtractor("go", "test");
    const check = await ext.verify();
    // A failed spawn -> runScipIndexer returns null -> verify() reports skip (never fail/throw).
    assert.equal(check.status, "skip");
  });
});

// ---------------------------------------------------------------------------
// extract() — whole project, D4 claiming
// ---------------------------------------------------------------------------

test("(scip-ext-4) extract(): no .go candidates -> errors non-empty, does not claim", async () => {
  const ext = new ScipExtractor("go", "test");
  const result = await ext.extract(process.cwd(), ["foo.ts", "bar.py"]);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.extractor.id, "scip-go");
  assert.ok(result.errors.length > 0);
  assert.equal(result.nodes.length, 0);
  assert.equal(result.rawCalls, undefined);
  assert.equal(result.imports, undefined);
});

test("(scip-ext-5) extract(): indexer unavailable -> errors non-empty (tree-sitter fallback), never throws", async () => {
  await withFakeIndexer(undefined, async () => {
    const ext = new ScipExtractor("go", "test");
    const result = await ext.extract(process.cwd(), ["main.go"]);
    assert.ok(result.errors.length > 0);
    assert.equal(result.nodes.length, 0);
  });
});

test("(scip-ext-6) extract(): fake indexer succeeds -> errors empty (claims), nodes/edges from the real fixture", async () => {
  await withFakeIndexer(FAKE_INDEXER_CMD, async () => {
    const ext = new ScipExtractor("go", "test");
    const result = await ext.extract(process.cwd(), ["main.go"]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.nodes.length, 5);
    assert.ok(result.edges.length > 0);
    for (const e of result.edges) assert.equal(e.confidence, "EXTRACTED");
  });
});

test("(scip-ext-7) extract(): indexer spawn fails (non-zero exit) -> errors non-empty, falls back cleanly", async () => {
  await withFakeIndexer(`${FAKE_INDEXER_CMD} --fail`, async () => {
    const ext = new ScipExtractor("go", "test");
    const result = await ext.extract(process.cwd(), ["main.go"]);
    assert.ok(result.errors.length > 0);
    assert.equal(result.nodes.length, 0);
  });
});

// ---------------------------------------------------------------------------
// supports() / whole-project semantics
// ---------------------------------------------------------------------------

test("(scip-ext-8) extract() is whole-project: passing root + a single candidate still yields the full fixture graph", async () => {
  const root = mkdtempSync(join(tmpdir(), "leina-scip-ext-root-"));
  try {
    await withFakeIndexer(FAKE_INDEXER_CMD, async () => {
      const ext = new ScipExtractor("go", "test");
      // Only ONE candidate file supplied — the fake indexer still returns the whole
      // fixture's 5-node graph, proving extract() invokes the indexer over the
      // project root rather than per-candidate-file.
      const result = await ext.extract(root, [join(root, "onefile.go")]);
      assert.equal(result.nodes.length, 5);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
