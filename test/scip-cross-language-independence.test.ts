// scip-cross-language-independence.test.ts — sdd/scip-lang-rollout wave C,
// spec scenario "degradación independiente Rust/Python": one language's SCIP
// indexer being present (or absent) must never affect another language's
// extraction in the SAME build. Exercises the REAL composition root
// (buildDefaultRegistry -> buildGraph), not just ScipExtractor in isolation,
// over ONE project directory containing both a `.rs` and a `.py` file,
// using synthetic (hand-encoded) `.scip` payloads via
// test/helpers/fake-scip-indexer.ts + test/helpers/scip-encode.ts so no real
// toolchain is required to run this test.
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-cross-language-independence.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeIndex, pythonKind0FunctionSymbol, scipHead } from "./helpers/scip-encode.ts";

const HELPER = fileURLToPath(new URL("./helpers/fake-scip-indexer.ts", import.meta.url));
const FAKE_INDEXER_CMD = `${process.execPath} --no-warnings --experimental-strip-types ${HELPER}`;
const RUST_ENV_VAR = "LEINA_SCIP_RUST_INDEXER";
const PYTHON_ENV_VAR = "LEINA_SCIP_PYTHON_INDEXER";
const FIXTURE_ENV_VAR = "LEINA_FAKE_SCIP_FIXTURE";

async function buildAt(dir: string) {
  const { buildGraph } = await import("../src/application/graph/build.ts");
  const { buildDefaultRegistry } = await import("../src/cli/wiring.ts");
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "scip-independence-db-"));
  const store = new GraphStore(join(tmp, "graph.db"));
  try {
    const registry = await buildDefaultRegistry();
    const report = await buildGraph(dir, store, registry);
    return { report, nodes: store.allNodes(), edges: store.allEdges() };
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

function filesClaimedBy(report: Awaited<ReturnType<typeof buildAt>>["report"], id: string): number {
  return report.timings.extractors.find((e) => e.id === id)?.files ?? 0;
}

/** A project with one `.rs` and one `.py` file — real (trivial) source text
 * so tree-sitter's own fallback parse is well-formed too. */
function makeMixedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "scip-independence-proj-"));
  writeFileSync(join(dir, "main.rs"), "fn greet() -> &'static str {\n    \"hi\"\n}\n");
  writeFileSync(join(dir, "main.py"), "def greet():\n    return \"hi\"\n");
  return dir;
}

test("(scip-indep-rust-present-python-absent) rust-analyzer available, scip-python absent: .rs via SCIP, .py via tree-sitter, no interference", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "scip-independence-fixture-"));
  const dir = makeMixedProject();
  try {
    const rustHead = scipHead("scip-rust", "cargo", "fixture", "0.1.0");
    const rustFixture = join(scratch, "rust.scip");
    writeFileSync(
      rustFixture,
      encodeIndex({
        relativePath: "main.rs",
        language: "rust",
        symbols: [{ symbol: `${rustHead} greet().`, kind: 17, displayName: "greet" }],
      }),
    );

    const prevRust = process.env[RUST_ENV_VAR];
    const prevPython = process.env[PYTHON_ENV_VAR];
    const prevFixture = process.env[FIXTURE_ENV_VAR];
    process.env[RUST_ENV_VAR] = FAKE_INDEXER_CMD;
    delete process.env[PYTHON_ENV_VAR];
    process.env[FIXTURE_ENV_VAR] = rustFixture;
    let report: Awaited<ReturnType<typeof buildAt>>["report"];
    try {
      ({ report } = await buildAt(dir));
    } finally {
      if (prevRust === undefined) delete process.env[RUST_ENV_VAR];
      else process.env[RUST_ENV_VAR] = prevRust;
      if (prevPython === undefined) delete process.env[PYTHON_ENV_VAR];
      else process.env[PYTHON_ENV_VAR] = prevPython;
      if (prevFixture === undefined) delete process.env[FIXTURE_ENV_VAR];
      else process.env[FIXTURE_ENV_VAR] = prevFixture;
    }

    assert.ok(filesClaimedBy(report, "scip-rust") >= 1, "scip-rust must claim main.rs");
    assert.equal(filesClaimedBy(report, "scip-python"), 0, "scip-python must claim NOTHING (unavailable)");
    assert.ok(filesClaimedBy(report, "treesitter") >= 1, "treesitter must claim main.py (scip-python fallback)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("(scip-indep-python-present-rust-absent) scip-python available, rust-analyzer absent: .py via SCIP, .rs via tree-sitter, no interference", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "scip-independence-fixture2-"));
  const dir = makeMixedProject();
  try {
    const pyHead = scipHead("scip-python", "pip", "fixture", "0.1.0");
    const pyFixture = join(scratch, "python.scip");
    writeFileSync(
      pyFixture,
      encodeIndex({
        relativePath: "main.py",
        language: "python",
        symbols: [{ symbol: pythonKind0FunctionSymbol(pyHead, "greet"), kind: 0, displayName: "" }],
      }),
    );

    const prevRust = process.env[RUST_ENV_VAR];
    const prevPython = process.env[PYTHON_ENV_VAR];
    const prevFixture = process.env[FIXTURE_ENV_VAR];
    delete process.env[RUST_ENV_VAR];
    process.env[PYTHON_ENV_VAR] = FAKE_INDEXER_CMD;
    process.env[FIXTURE_ENV_VAR] = pyFixture;
    let report: Awaited<ReturnType<typeof buildAt>>["report"];
    try {
      ({ report } = await buildAt(dir));
    } finally {
      if (prevRust === undefined) delete process.env[RUST_ENV_VAR];
      else process.env[RUST_ENV_VAR] = prevRust;
      if (prevPython === undefined) delete process.env[PYTHON_ENV_VAR];
      else process.env[PYTHON_ENV_VAR] = prevPython;
      if (prevFixture === undefined) delete process.env[FIXTURE_ENV_VAR];
      else process.env[FIXTURE_ENV_VAR] = prevFixture;
    }

    assert.ok(filesClaimedBy(report, "scip-python") >= 1, "scip-python must claim main.py");
    assert.equal(filesClaimedBy(report, "scip-rust"), 0, "scip-rust must claim NOTHING (unavailable)");
    assert.ok(filesClaimedBy(report, "treesitter") >= 1, "treesitter must claim main.rs (scip-rust fallback)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
