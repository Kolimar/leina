// yaml-extractor.test.ts — Tests unitarios para YamlInfraExtractor (etapa-7).
//
// Cubre:
//   REQ-YIE-1: supports() filtra .yml/.yaml, rechaza no-YAML
//   REQ-YIE-2: docker-compose → nodos service + edges deploys
//   REQ-YIE-3: GH Actions → nodo config
//   REQ-YIE-4: config genérico → nodo config
//   REQ-YIE-5: YAML malformado → errors.length > 0, sin excepción
//   REQ-YIE-7: schemaVersion:1, sin rawCalls/imports
//   Bridge: build.context → edge reads a makeId("src/api.ts")
//   makeId: mismo id en YAML extractor y tree-sitter
//
// Run: node --no-warnings --experimental-strip-types --test test/yaml-extractor.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const MIXED_REPO = join(import.meta.dirname, "fixtures", "mixed-repo");

// ---------------------------------------------------------------------------
// REQ-YIE-1: supports()
// ---------------------------------------------------------------------------

test("(yie-1a) supports('.yml') → true", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const ext = new YamlInfraExtractor("test");
  assert.strictEqual(ext.supports("docker-compose.yml"), true);
});

test("(yie-1b) supports('.yaml') → true", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const ext = new YamlInfraExtractor("test");
  assert.strictEqual(ext.supports("pipeline.yaml"), true);
});

test("(yie-1c) supports('.ts') → false", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const ext = new YamlInfraExtractor("test");
  assert.strictEqual(ext.supports("index.ts"), false);
});

test("(yie-1d) supports('Dockerfile') → false", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const ext = new YamlInfraExtractor("test");
  assert.strictEqual(ext.supports("Dockerfile"), false);
});

test("(yie-1e) id === 'yaml-infra'", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const ext = new YamlInfraExtractor("test");
  assert.strictEqual(ext.id, "yaml-infra");
});

// ---------------------------------------------------------------------------
// REQ-YIE-2: docker-compose → service nodes + deploys edges
// ---------------------------------------------------------------------------

test("(yie-2a) docker-compose con depends_on → 2 nodos service + edge deploys", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-dc-"));
  const root = tmp;
  const dcFile = join(tmp, "docker-compose.yml");
  writeFileSync(dcFile, `
services:
  api:
    image: nginx
    depends_on:
      - db
  db:
    image: postgres
`);
  try {
    const ext = new YamlInfraExtractor("test");
    const result = await ext.extract(root, [dcFile]);

    assert.strictEqual(result.schemaVersion, 1);
    assert.strictEqual(result.errors.length, 0, `Errores inesperados: ${JSON.stringify(result.errors)}`);

    const serviceNodes = result.nodes.filter((n) => n.kind === "service");
    assert.ok(serviceNodes.length >= 2, `Esperado >= 2 nodos service, actual=${serviceNodes.length}`);

    const deploys = result.edges.filter((e) => e.relation === "deploys");
    assert.ok(deploys.length >= 1, `Esperado >= 1 edge deploys, actual=${deploys.length}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(yie-2b) docker-compose sin depends_on → 1 nodo service, edges vacíos (solo configures)", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-single-"));
  const dcFile = join(tmp, "docker-compose.yml");
  writeFileSync(dcFile, `
services:
  api:
    image: nginx
`);
  try {
    const ext = new YamlInfraExtractor("test");
    const result = await ext.extract(tmp, [dcFile]);

    const serviceNodes = result.nodes.filter((n) => n.kind === "service");
    assert.ok(serviceNodes.length >= 1, "Esperado >= 1 nodo service");

    const deployEdges = result.edges.filter((e) => e.relation === "deploys");
    assert.strictEqual(deployEdges.length, 0, "Sin depends_on → sin edges deploys");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bridge: build.context → edge reads
// ---------------------------------------------------------------------------

test("(yie-bridge) build.context → edge reads a makeId('src/api.ts')", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const { makeId } = await import("../src/domain/shared/id.ts");

  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-bridge-"));
  // Crear src/api.ts para que resolveCodePath lo encuentre
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(join(tmp, "src", "api.ts"), "export function apiHandler() {}");

  const dcFile = join(tmp, "docker-compose.yml");
  writeFileSync(dcFile, `
services:
  api:
    build:
      context: ./src/api.ts
`);
  try {
    const ext = new YamlInfraExtractor("test");
    const result = await ext.extract(tmp, [dcFile]);

    const readsEdges = result.edges.filter((e) => e.relation === "reads");
    assert.ok(readsEdges.length >= 1, `Esperado >= 1 edge reads, actual=${readsEdges.length}. edges=${JSON.stringify(result.edges)}`);

    const expectedModuleId = makeId("src/api.ts");
    const bridgeEdge = readsEdges.find((e) => e.target === expectedModuleId);
    assert.ok(
      bridgeEdge,
      `Esperado edge reads a ${expectedModuleId}, edges.reads=${JSON.stringify(readsEdges)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REQ-YIE-3: GH Actions → nodo config
// ---------------------------------------------------------------------------

test("(yie-3) GH Actions (jobs:) → nodo config, sin errors fatales", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-gha-"));
  const wfDir = join(tmp, ".github", "workflows");
  mkdirSync(wfDir, { recursive: true });
  const wfFile = join(wfDir, "ci.yml");
  writeFileSync(wfFile, `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
`);
  try {
    const ext = new YamlInfraExtractor("test");
    const result = await ext.extract(tmp, [wfFile]);

    const configNodes = result.nodes.filter((n) => n.kind === "config");
    assert.ok(configNodes.length >= 1, `Esperado >= 1 nodo config, actual=${configNodes.length}`);
    assert.strictEqual(result.errors.length, 0, `Errores inesperados: ${JSON.stringify(result.errors)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REQ-YIE-4: Config genérico → nodo config
// ---------------------------------------------------------------------------

test("(yie-4) config genérico → al menos 1 nodo config", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-cfg-"));
  const cfgFile = join(tmp, "app-settings.yaml");
  writeFileSync(cfgFile, `
app:
  name: my-app
  version: "1.0"
database:
  host: localhost
`);
  try {
    const ext = new YamlInfraExtractor("test");
    const result = await ext.extract(tmp, [cfgFile]);

    const configNodes = result.nodes.filter((n) => n.kind === "config");
    assert.ok(configNodes.length >= 1, `Esperado >= 1 nodo config`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REQ-YIE-5: YAML malformado → errors.length > 0, sin excepción
// ---------------------------------------------------------------------------

test("(yie-5) YAML malformado → errors.length > 0, sin throw", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-bad-"));
  const badFile = join(tmp, "broken.yml");
  // YAML inválido: tabulaciones en lugar de espacios (tree-sitter reporta error)
  writeFileSync(badFile, "key:\n\t- invalid_indent\n\t- also_invalid\nnested:\n\t\tbad: value");
  try {
    const ext = new YamlInfraExtractor("test");
    let result;
    assert.doesNotThrow(async () => {
      result = await ext.extract(tmp, [badFile]);
    }, "extract() no debe lanzar ante YAML malformado");
    result = await ext.extract(tmp, [badFile]);
    assert.ok(result.errors.length > 0, `Esperado errors.length > 0, actual=${result.errors.length}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REQ-YIE-7: schemaVersion:1, sin rawCalls/imports
// ---------------------------------------------------------------------------

test("(yie-7a) resultado tiene schemaVersion=1", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-schema-"));
  const cfgFile = join(tmp, "cfg.yaml");
  writeFileSync(cfgFile, "key: value\n");
  try {
    const ext = new YamlInfraExtractor("test");
    const result = await ext.extract(tmp, [cfgFile]);
    assert.strictEqual(result.schemaVersion, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(yie-7b) resultado NO tiene rawCalls ni imports", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-noraw-"));
  const cfgFile = join(tmp, "cfg.yaml");
  writeFileSync(cfgFile, "key: value\n");
  try {
    const ext = new YamlInfraExtractor("test");
    const result = await ext.extract(tmp, [cfgFile]);
    assert.strictEqual(result.rawCalls, undefined, "rawCalls debe ser undefined");
    assert.strictEqual(result.imports, undefined, "imports debe ser undefined");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixture mixed-repo: extractor procesa el docker-compose.yml real
// ---------------------------------------------------------------------------

test("(yie-fixture) extractor procesa fixture mixed-repo: nodos service + config", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const { existsSync } = await import("node:fs");
  const dcFile = join(MIXED_REPO, "docker-compose.yml");
  const cfgFile = join(MIXED_REPO, "config", "app.yaml");
  assert.ok(existsSync(dcFile), `Fixture docker-compose.yml no existe: ${dcFile}`);
  assert.ok(existsSync(cfgFile), `Fixture config/app.yaml no existe: ${cfgFile}`);

  const ext = new YamlInfraExtractor("test");
  const result = await ext.extract(MIXED_REPO, [dcFile, cfgFile]);

  const serviceNodes = result.nodes.filter((n) => n.kind === "service");
  const configNodes = result.nodes.filter((n) => n.kind === "config");
  assert.ok(serviceNodes.length >= 1, `Esperado >= 1 nodo service, actual=${serviceNodes.length}`);
  assert.ok(configNodes.length >= 1, `Esperado >= 1 nodo config, actual=${configNodes.length}`);

  // Verificar bridge: debe haber edge reads hacia makeId("src/api.ts")
  const { makeId } = await import("../src/domain/shared/id.ts");
  const expectedModuleId = makeId("src/api.ts");
  const readsEdges = result.edges.filter((e) => e.relation === "reads" && e.target === expectedModuleId);
  assert.ok(
    readsEdges.length >= 1,
    `Esperado edge reads hacia ${expectedModuleId} (bridge). edges=${JSON.stringify(result.edges.map(e => ({ r: e.relation, t: e.target })))}`,
  );
});

// ---------------------------------------------------------------------------
// tree-sitter path: the vendored grammar parses for real (no silent fallback)
// ---------------------------------------------------------------------------

test("(yie-ts-1) the vendored tree-sitter-yaml grammar loads and parses a valid document", async () => {
  const { probeYamlGrammar } = await import("../src/infrastructure/extractors/yaml.ts");
  assert.equal(await probeYamlGrammar(), null);
});

test("(yie-ts-2) flow-style compose (unreadable line by line) is extracted by tree-sitter", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-ts-flow-"));
  const dcFile = join(tmp, "docker-compose.yml");
  // Flow mappings, 4-space indentation, quoted keys and a long-form depends_on: the
  // line-based fallback sees no service lines here; only a real YAML parse does.
  writeFileSync(dcFile, `
services: {web: {image: nginx, depends_on: ["api"]}}
x-anchors: &defaults
    restart: always
`);
  const dc2 = join(tmp, "compose.yaml");
  writeFileSync(dc2, `
services:
    "api":
        <<: *defaults
        depends_on:
            db:
                condition: service_healthy
    db:
        image: postgres
`);
  try {
    process.env.LEINA_VERBOSE = "1"; // a fallback would announce itself in diagnostics
    const ext = new YamlInfraExtractor("test");
    const flow = await ext.extract(tmp, [dcFile]);
    assert.deepEqual(flow.diagnostics, [], `no fallback: ${JSON.stringify(flow.diagnostics)}`);
    assert.deepEqual(flow.errors, []);
    assert.deepEqual(flow.nodes.filter((n) => n.kind === "service").map((n) => n.label), ["web"]);
    assert.equal(flow.edges.filter((e) => e.relation === "deploys").length, 1);

    const block = await ext.extract(tmp, [dc2]);
    assert.deepEqual(block.diagnostics, []);
    assert.deepEqual(block.nodes.filter((n) => n.kind === "service").map((n) => n.label).sort(), ["api", "db"]);
    const deploys = block.edges.filter((e) => e.relation === "deploys");
    assert.equal(deploys.length, 1, "long-form depends_on yields one deploys edge (api → db)");
  } finally {
    delete process.env.LEINA_VERBOSE;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(yie-ts-3) a file tree-sitter cannot parse cleanly (templated YAML) falls back per file", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-ts-helm-"));
  const tpl = join(tmp, "deployment.yaml");
  writeFileSync(tpl, `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "app.fullname" . }}
{{- if .Values.extra }}
  labels: {{ toYaml .Values.extra | nindent 4 }}
{{- end }}
`);
  const ok = join(tmp, "ok.yaml");
  writeFileSync(ok, "jobs:\n  build: {runs-on: x}\n");
  try {
    const ext = new YamlInfraExtractor("test");
    const result = await ext.extract(tmp, [tpl, ok]);
    assert.deepEqual(result.errors, []);
    const labels = result.nodes.map((n) => n.label);
    assert.ok(labels.includes("deployment.yaml"), "templated file still yields its config node");
    assert.ok(labels.includes("build"), "a later clean file still takes the tree-sitter path");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REQ-D6: an unusable grammar degrades to the line-based fallback, quietly by default
// ---------------------------------------------------------------------------

function brokenWasm(dir: string): string {
  const p = join(dir, "not-a-grammar.wasm");
  writeFileSync(p, "this is not wasm");
  return p;
}

test("(yie-d6a) sin -v/LEINA_VERBOSE, diagnostics viene vacío (grammar sano o roto)", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-d6-quiet-"));
  const cfgFile = join(tmp, "cfg.yaml");
  writeFileSync(cfgFile, "key: value\n");
  try {
    delete process.env.LEINA_VERBOSE;
    for (const ext of [new YamlInfraExtractor("test"), new YamlInfraExtractor("test", { wasmPath: brokenWasm(tmp) })]) {
      const result = await ext.extract(tmp, [cfgFile]);
      assert.deepStrictEqual(result.diagnostics, []);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(yie-d6b) con LEINA_VERBOSE=1 y un grammar que no carga, el diagnóstico nombra el fallback", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-d6-verbose-"));
  const cfgFile = join(tmp, "cfg.yaml");
  writeFileSync(cfgFile, "key: value\n");
  try {
    process.env.LEINA_VERBOSE = "1";
    const ext = new YamlInfraExtractor("test", { wasmPath: brokenWasm(tmp) });
    const result = await ext.extract(tmp, [cfgFile]);
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0]!, /failed to load .*line-based fallback/);
  } finally {
    delete process.env.LEINA_VERBOSE;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(yie-d6c) el fallback line-based sigue siendo correcto (docker-compose) con o sin verbose", async () => {
  const { YamlInfraExtractor } = await import("../src/infrastructure/extractors/yaml.ts");
  const tmp = mkdtempSync(join(tmpdir(), "yaml-ext-d6-fallback-"));
  const dcFile = join(tmp, "docker-compose.yml");
  writeFileSync(dcFile, `
services:
  api:
    image: nginx
    depends_on:
      - db
  db:
    image: postgres
`);
  try {
    const ext = new YamlInfraExtractor("test", { wasmPath: brokenWasm(tmp) });
    const quiet = await ext.extract(tmp, [dcFile]);
    process.env.LEINA_VERBOSE = "1";
    const verbose = await ext.extract(tmp, [dcFile]);
    delete process.env.LEINA_VERBOSE;
    const healthy = await new YamlInfraExtractor("test").extract(tmp, [dcFile]);

    const svcNames = (r: typeof quiet) => r.nodes.filter((n) => n.kind === "service").map((n) => n.label).sort();
    assert.deepStrictEqual(svcNames(quiet), ["api", "db"]);
    assert.deepStrictEqual(svcNames(quiet), svcNames(verbose));
    assert.deepStrictEqual(svcNames(quiet), svcNames(healthy), "fallback and tree-sitter agree on plain compose");
    const deploys = (r: typeof quiet) => r.edges.filter((e) => e.relation === "deploys").length;
    assert.strictEqual(deploys(quiet), deploys(verbose));
    assert.strictEqual(deploys(quiet), deploys(healthy));
  } finally {
    delete process.env.LEINA_VERBOSE;
    rmSync(tmp, { recursive: true, force: true });
  }
});
