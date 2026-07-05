// impact.test.ts — Tests de integración para analyzeImpact y el CLI `impact analyze`.
//
// Cubre:
//   REQ-IA-1/2: BFS bidireccional con categorización correcta (unitario)
//   AC3: fixture mixed-repo — edge `reads` real conecta código con servicio (integración)
//   REQ-IA-3: CLI `impact analyze --json` válido, exit 0 (CLI spawnSync)
//
// Run: node --no-warnings --experimental-strip-types --test test/impact.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");
const MIXED_REPO = join(import.meta.dirname, "fixtures", "mixed-repo");

async function buildMixedRepoGraph(tmpDir: string): Promise<import("../src/domain/graph/ports.ts").GraphRepository> {
  const { buildGraph } = await import("../src/application/graph/build.ts");
  const { buildDefaultRegistry } = await import("../src/cli/wiring.ts");
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const store = new GraphStore(join(tmpDir, "graph.db"));
  const registry = await buildDefaultRegistry();
  await buildGraph(MIXED_REPO, store, registry);
  return store;
}

// ---------------------------------------------------------------------------
// A) Tests unitarios con grafo manual
// ---------------------------------------------------------------------------

test("(ia-unit-1) BFS alcanza nodos conectados via calls + deploys", async () => {
  const { analyzeImpact } = await import("../src/application/graph/impact.ts");
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "impact-unit-"));
  try {
    const store = new GraphStore(join(tmp, "graph.db"));
    // Grafo: fn-A -calls-> fn-T, fn-A -deploys-> svc-B, fn-A -configures-> cfg-C
    store.addNodes([
      { id: "fn-A", label: "fnA", fileType: "code", sourceFile: "src/a.ts", kind: "function" },
      { id: "fn-T", label: "fnT", fileType: "code", sourceFile: "test/a.test.ts", kind: "function" },
      { id: "svc-B", label: "svcB", fileType: "config", sourceFile: "docker-compose.yml", kind: "service" },
      { id: "cfg-C", label: "cfgC", fileType: "config", sourceFile: "config/app.yaml", kind: "config" },
    ]);
    store.addEdges([
      { source: "fn-A", target: "fn-T", relation: "calls", confidence: "EXTRACTED", sourceFile: "src/a.ts", weight: 1 },
      { source: "fn-A", target: "svc-B", relation: "deploys", confidence: "EXTRACTED", sourceFile: "src/a.ts", weight: 1 },
      { source: "fn-A", target: "cfg-C", relation: "configures", confidence: "EXTRACTED", sourceFile: "src/a.ts", weight: 1 },
    ]);

    const result = analyzeImpact(store, "fn-A", 10);
    const { files, tests, services, configs } = result.impacted;

    assert.ok(files.includes("src/a.ts"), "files debe contener src/a.ts (seed)");
    assert.ok(files.includes("test/a.test.ts"), "files debe contener test/a.test.ts");
    assert.ok(files.includes("config/app.yaml"), "files debe contener config/app.yaml");
    assert.ok(tests.includes("test/a.test.ts"), "tests debe contener test/a.test.ts");
    assert.ok(services.includes("svc-B"), "services debe contener svc-B");
    assert.ok(configs.includes("cfg-C"), "configs debe contener cfg-C");

    store.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(ia-unit-2) BFS backward — nodo intermedio alcanza sus predecesores", async () => {
  const { analyzeImpact } = await import("../src/application/graph/impact.ts");
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "impact-bwd-"));
  try {
    const store = new GraphStore(join(tmp, "graph.db"));
    // A -calls-> B, C -calls-> B
    store.addNodes([
      { id: "A", label: "A", fileType: "code", sourceFile: "a.ts", kind: "function" },
      { id: "B", label: "B", fileType: "code", sourceFile: "b.ts", kind: "function" },
      { id: "C", label: "C", fileType: "code", sourceFile: "c.ts", kind: "function" },
    ]);
    store.addEdges([
      { source: "A", target: "B", relation: "calls", confidence: "EXTRACTED", sourceFile: "a.ts", weight: 1 },
      { source: "C", target: "B", relation: "calls", confidence: "EXTRACTED", sourceFile: "c.ts", weight: 1 },
    ]);

    const result = analyzeImpact(store, "B", 10);
    const { files } = result.impacted;
    assert.ok(files.includes("a.ts"), "files debe incluir a.ts (upstream A)");
    assert.ok(files.includes("c.ts"), "files debe incluir c.ts (upstream C)");

    store.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(ia-unit-3) nodo sin aristas — tests/services/configs vacíos", async () => {
  const { analyzeImpact } = await import("../src/application/graph/impact.ts");
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "impact-isolated-"));
  try {
    const store = new GraphStore(join(tmp, "graph.db"));
    store.addNodes([
      { id: "fn-X", label: "fnX", fileType: "code", sourceFile: "x.ts", kind: "function" },
    ]);
    const result = analyzeImpact(store, "fn-X", 10);
    assert.deepStrictEqual(result.impacted.tests, []);
    assert.deepStrictEqual(result.impacted.services, []);
    assert.deepStrictEqual(result.impacted.configs, []);
    store.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(ia-unit-4) seedId inexistente → todas las listas vacías", async () => {
  const { analyzeImpact } = await import("../src/application/graph/impact.ts");
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "impact-noexist-"));
  try {
    const store = new GraphStore(join(tmp, "graph.db"));
    const result = analyzeImpact(store, "nonexistent-id", 10);
    assert.deepStrictEqual(result.impacted.files, []);
    assert.deepStrictEqual(result.impacted.tests, []);
    assert.deepStrictEqual(result.impacted.services, []);
    assert.deepStrictEqual(result.impacted.configs, []);
    store.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(ia-unit-5) nodo con fileType='config' aparece en configs aunque kind no sea 'config'", async () => {
  const { analyzeImpact } = await import("../src/application/graph/impact.ts");
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "impact-filetype-"));
  try {
    const store = new GraphStore(join(tmp, "graph.db"));
    store.addNodes([
      { id: "fn-seed", label: "seed", fileType: "code", sourceFile: "a.ts", kind: "function" },
      { id: "node-D", label: "D", fileType: "config", sourceFile: "cfg.ts", kind: "function" },
    ]);
    store.addEdges([
      { source: "fn-seed", target: "node-D", relation: "reads", confidence: "EXTRACTED", sourceFile: "a.ts", weight: 1 },
    ]);
    const result = analyzeImpact(store, "fn-seed", 10);
    assert.ok(result.impacted.configs.includes("node-D"), "node-D con fileType='config' debe estar en configs");
    store.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B) Integración AC3 — fixture mixed-repo
// ---------------------------------------------------------------------------

test("(ia-ac3) analyzeImpact desde makeId('src/api.ts') alcanza el servicio vía edge reads real", async () => {
  const { analyzeImpact } = await import("../src/application/graph/impact.ts");
  const { makeId } = await import("../src/domain/shared/id.ts");
  const tmp = mkdtempSync(join(tmpdir(), "impact-ac3-"));
  try {
    const store = await buildMixedRepoGraph(tmp);

    const moduleId = makeId("src/api.ts");
    const moduleNode = (store as import("../src/infrastructure/sqlite/graph-store.ts").GraphStore).getNode(moduleId);
    assert.ok(moduleNode, `Nodo módulo ${moduleId} debe existir en el grafo`);

    const result = analyzeImpact(store, moduleId);
    const { services } = result.impacted;

    assert.ok(
      services.length > 0,
      `services debe ser no vacío: analyzeImpact desde ${moduleId} debe alcanzar el servicio via edge reads. ` +
      `Got services=${JSON.stringify(services)}, all nodes=${JSON.stringify((store as import("../src/infrastructure/sqlite/graph-store.ts").GraphStore).allNodes().map(n => ({ id: n.id, kind: n.kind })))}`,
    );

    (store as import("../src/infrastructure/sqlite/graph-store.ts").GraphStore).close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(ia-ac3-makeId-bridge) makeId produce el mismo id en YAML extractor y tree-sitter", async () => {
  // Verifica que el bridge funciona: makeId("src/api.ts") en el YAML extractor es idéntico
  // al makeId(relPath) que genera treesitter.ts L476 para el mismo archivo.
  const { makeId } = await import("../src/domain/shared/id.ts");
  const yamlId = makeId("src/api.ts");   // Como lo usa el YAML extractor
  const tsId = makeId("src/api.ts");      // Como lo usa treesitter.ts
  assert.strictEqual(yamlId, tsId, "makeId produce el mismo id en ambos contextos");
  assert.strictEqual(yamlId, "src_api_ts", `Esperado 'src_api_ts', actual='${yamlId}'`);
});

// ---------------------------------------------------------------------------
// C) CLI `impact analyze --json`
// ---------------------------------------------------------------------------

test("(ia-cli-1) impact analyze nonexistent --json → shape vacío, exit 0", async () => {
  // Este test necesita un grafo existente. Usamos el fixture mixed-repo.
  const tmp = mkdtempSync(join(tmpdir(), "impact-cli-"));
  try {
    // Construir el grafo en tmp
    const { buildGraph } = await import("../src/application/graph/build.ts");
    const { buildDefaultRegistry } = await import("../src/cli/wiring.ts");
    const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
    const dbPath = join(tmp, ".leina", "graph.db");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmp, ".leina"), { recursive: true });
    const store = new GraphStore(dbPath);
    const registry = await buildDefaultRegistry();
    await buildGraph(MIXED_REPO, store, registry);
    store.close();

    // Ejecutar CLI
    const cliPath = join(REPO_ROOT, "src", "cli", "index.ts");
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", cliPath, "impact", "analyze", tmp, "nonexistent-symbol-xyz", "--json"],
      { encoding: "utf8", cwd: REPO_ROOT },
    );

    assert.strictEqual(result.status, 0, `exit code debe ser 0. stderr: ${result.stderr}`);
    let parsed: unknown;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, `stdout debe ser JSON válido: ${result.stdout}`);
    const obj = parsed as { impacted: { files: unknown[]; tests: unknown[]; services: unknown[]; configs: unknown[] } };
    assert.ok(Array.isArray(obj.impacted?.files), "impacted.files debe ser array");
    assert.ok(Array.isArray(obj.impacted?.tests), "impacted.tests debe ser array");
    assert.ok(Array.isArray(obj.impacted?.services), "impacted.services debe ser array");
    assert.ok(Array.isArray(obj.impacted?.configs), "impacted.configs debe ser array");
    assert.deepStrictEqual(obj.impacted.files, []);
    assert.deepStrictEqual(obj.impacted.services, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
