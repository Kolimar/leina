// scip-build-e2e.test.ts — task 4.3: full buildGraph() E2E through the real
// composition root (buildDefaultRegistry), with NO scip-go on PATH (this
// sandbox never has it) and WITH a fake scip-go (via
// test/helpers/fake-scip-indexer.ts) so both the degraded and the
// compiler-grade paths are exercised over the real registry order, not just
// the ScipExtractor adapter in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/scip/go/", import.meta.url));
const HELPER = fileURLToPath(new URL("./helpers/fake-scip-indexer.ts", import.meta.url));
const FAKE_INDEXER_CMD = `${process.execPath} --no-warnings --experimental-strip-types ${HELPER}`;
const ENV_VAR = "LEINA_SCIP_GO_INDEXER";

async function buildAt(dir: string) {
  const { buildGraph } = await import("../src/application/graph/build.ts");
  const { buildDefaultRegistry } = await import("../src/cli/wiring.ts");
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "scip-e2e-"));
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

test("(scip-e2e-1) no scip-go on PATH: treesitter claims .go, build succeeds, same node count as the id-parity gate fixture", async () => {
  const prev = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
  try {
    const { nodes } = await buildAt(FIXTURE_DIR);
    // main.go + Foo + Greeter + Bar + Bar.Greet — the same 5 tree-sitter would
    // produce alone (scip-id-parity.test.ts); with no indexer, scip-go claims
    // nothing (D4) and tree-sitter is the sole source of these nodes.
    assert.equal(nodes.length, 5, `expected 5 nodes from tree-sitter fallback, got ${nodes.length}: ${JSON.stringify(nodes.map((n) => n.label))}`);
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
});

test("(scip-e2e-2) with a (fake) scip-go available: scip-go claims .go, treesitter does not double-produce nodes", async () => {
  const prev = process.env[ENV_VAR];
  process.env[ENV_VAR] = FAKE_INDEXER_CMD;
  try {
    const { nodes, edges } = await buildAt(FIXTURE_DIR);
    // scip-go claims main.go (errors=[]) -> treesitter never sees it as a candidate
    // (recordClaimed marks it handled) -> still 5 nodes, no duplication, and the
    // SCIP-only distinction (Greeter as "interface" rather than tree-sitter's "class")
    // is now visible — confirming scip-go's result, not tree-sitter's, won.
    assert.equal(nodes.length, 5, `expected 5 nodes (no duplication), got ${nodes.length}`);
    const greeter = nodes.find((n) => n.label === "Greeter");
    assert.ok(greeter, "Greeter node must exist");
    assert.equal(greeter.kind, "interface", "scip-go distinguishes Interface from Class; tree-sitter's Go config cannot");
    assert.ok(edges.length > 0);
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
});
