// scip-indexer-run.test.ts — end-to-end coverage of `runScipIndexer` (task 3.x,
// wave 2): argv resolution, spawn, `.scip` output redirected to an ephemeral
// os.tmpdir() directory, streamed read via readScipDocuments +
// deriveScipDocumentGraph, and guaranteed tempdir cleanup — all WITHOUT
// requiring the real Go toolchain or scip-go binary.
//
// Uses `test/helpers/fake-scip-indexer.ts`, a stand-in binary that honors the
// SAME `... index --output <path> ./...` contract `runScipIndexer` builds, and
// copies the real committed `test/fixtures/scip/go/index.scip` fixture there —
// so this exercises the REAL argv-building/spawn/streaming/cleanup pipeline
// against a REAL (if canned) SCIP payload, not a mock of the parser.
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-indexer-run.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScipIndexer, runScipIndexer } from "../src/infrastructure/extractors/semantic/scip-indexer.ts";

const HELPER = fileURLToPath(new URL("./helpers/fake-scip-indexer.ts", import.meta.url));
// Same node flags this suite itself is run with (mirrors scip-streaming.test.ts's PROBE
// invocation) — `.ts` needs `--experimental-strip-types` to run as a plain child process.
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

/**
 * Point `os.tmpdir()` at a fresh PRIVATE directory for the duration of `fn`
 * (Node reads `TMPDIR` on POSIX / `TEMP`/`TMP` on Windows). `npm test` runs
 * every `test/*.test.ts` file as a SEPARATE concurrent process sharing the
 * same real OS tmpdir, so a before/after `readdirSync(tmpdir())` snapshot
 * in this file would otherwise race against `leina-scip-go-*` directories
 * created concurrently by scip-extractor.test.ts / scip-build-e2e.test.ts.
 * A private tmpdir root makes each test's snapshot exclusively its own.
 */
function withPrivateTmpdir<T>(fn: (privateTmpdir: string) => T): T {
  const priv = mkdtempSync(join(tmpdir(), "leina-scip-run-priv-"));
  const savedVars = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = priv;
  process.env.TMP = priv;
  process.env.TEMP = priv;
  try {
    return fn(priv);
  } finally {
    for (const [k, v] of Object.entries(savedVars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(priv, { recursive: true, force: true });
  }
}

test("(scip-run-1) resolveScipIndexer honors the env override (space-separated argv)", () => {
  withFakeIndexer(FAKE_INDEXER_CMD, () => {
    const argv = resolveScipIndexer("go");
    assert.deepEqual(argv, [process.execPath, "--no-warnings", "--experimental-strip-types", HELPER]);
  });
});

test("(scip-run-2) runScipIndexer returns null when no indexer is resolvable", () => {
  withFakeIndexer(undefined, () => {
    // PATH in the test sandbox never has a real `scip-go` binary.
    const res = runScipIndexer("go", process.cwd());
    assert.equal(res, null);
  });
});

test("(scip-run-3) runScipIndexer: fake indexer success -> real fixture graph, tempdir cleaned up", () => {
  withPrivateTmpdir((priv) => {
    withFakeIndexer(FAKE_INDEXER_CMD, () => {
      const res = runScipIndexer("go", process.cwd());
      assert.ok(res, "must return a result when the fake indexer succeeds");
      assert.equal(res.nodes.length, 5, "fixture yields 5 nodes (file, Foo, Greeter, Bar, Bar.Greet)");
      assert.ok(res.edges.length > 0, "fixture yields at least one edge");
      for (const e of res.edges) assert.equal(e.confidence, "EXTRACTED");
      const leftover = readdirSync(priv).filter((n) => n.startsWith("leina-scip-go-"));
      assert.deepEqual(leftover, [], "the ephemeral leina-scip-go-* tempdir must be removed after reading");
    });
  });
});

test("(scip-run-4) runScipIndexer: non-zero exit -> null, tempdir still cleaned up", () => {
  withPrivateTmpdir((priv) => {
    withFakeIndexer(`${FAKE_INDEXER_CMD} --fail`, () => {
      const res = runScipIndexer("go", process.cwd());
      assert.equal(res, null);
      const leftover = readdirSync(priv).filter((n) => n.startsWith("leina-scip-go-"));
      assert.deepEqual(leftover, [], "tempdir must be removed even when the indexer fails");
    });
  });
});

test("(scip-run-5) runScipIndexer never leaves the .scip file at the project root", () => {
  const root = mkdtempSync(join(tmpdir(), "leina-scip-root-"));
  try {
    withFakeIndexer(FAKE_INDEXER_CMD, () => {
      runScipIndexer("go", root);
    });
    assert.ok(!existsSync(join(root, "index.scip")), "must never write index.scip under the project root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
