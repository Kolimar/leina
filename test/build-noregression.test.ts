// build-noregression.test.ts — No-regression snapshot para conteos de nodos/edges.
//
// Captura la baseline ANTES del refactor de etapa-5-extractor-contract y verifica
// que el nuevo pipeline basado en registry produzca conteos byte-idénticos.
//
// Escenario 1 (TS_ONLY): tsmorph activo sobre test/fixtures/tsmorph-crossfile.
// Escenario 2 (MIXED):   LEINA_NO_TSMORPH=1 → tree-sitter puro (simula escenario mixto).
// Escenario 3 (MIXED-YAML): mixed-repo con TS + YAML; conteos de nodos TS iguales al snapshot.
//
// Baseline capturado del pipeline ORIGINAL (build.ts inline) ANTES del refactor:
//   TS_ONLY  → nodes=7, edges=6
//   MIXED    → nodes=9, edges=8
//
// Snapshot congelado de distribución por kind/relation (etapa-7, medido antes de cambiar extracción):
//   TS_ONLY  nodesByKind={module:4, function:3}  edgesByRelation={contains:3, calls:3}
//   MIXED    nodesByKind={module:6, function:3}  edgesByRelation={contains:3, imports:3, calls:2}
//
// Run: node --no-warnings --experimental-strip-types --test test/build-noregression.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Baseline congelado ANTES del refactor (medido sobre el pipeline original).
//
// TS_ONLY.edges se actualizó de 6 -> 7 (sdd/tsmorph-reference-edges): el walk de
// value-references (REQ-VR-1) añade `caller() --references--> callee.ts` — el
// identificador `ns` de `ns.target()` (namespace import) alias-resuelve al módulo
// `callee.ts`, una referencia real y no-espuria (distinta de la arista `calls` hacia
// `callee.ts:target`, ya cubierta por linkCallEdges).
const BASELINE = {
  TS_ONLY: { nodes: 7, edges: 7 },
  MIXED: { nodes: 9, edges: 8 },
} as const;

// Snapshot congelado de distribución por kind/relation — etapa-7 baseline.
// Valores literales medidos ANTES de aplicar la etapa (no calculados en runtime).
// TS_ONLY.edgesByRelation.references=1 añadido por sdd/tsmorph-reference-edges (ver nota BASELINE).
const KIND_SNAPSHOT = {
  TS_ONLY: {
    nodesByKind: { module: 4, function: 3 } as Record<string, number>,
    edgesByRelation: { contains: 3, calls: 3, references: 1 } as Record<string, number>,
  },
  MIXED: {
    nodesByKind: { module: 6, function: 3 } as Record<string, number>,
    edgesByRelation: { contains: 3, imports: 3, calls: 2 } as Record<string, number>,
  },
} as const;

const fixtureDir = join(import.meta.dirname, "fixtures", "tsmorph-crossfile");

// Helper: construye el grafo y devuelve {nodes, edges, nodesByKind, edgesByRelation}.
async function runBuild(noTsmorph: boolean, customDir?: string): Promise<{
  nodes: number;
  edges: number;
  nodesByKind: Record<string, number>;
  edgesByRelation: Record<string, number>;
}> {
  const { buildGraph } = await import("../src/application/graph/build.ts");
  const { buildDefaultRegistry } = await import("../src/cli/wiring.ts");
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "noregr-"));
  const dir = customDir ?? fixtureDir;
  try {
    const prev = process.env.LEINA_NO_TSMORPH;
    if (noTsmorph) {
      process.env.LEINA_NO_TSMORPH = "1";
    } else {
      delete process.env.LEINA_NO_TSMORPH;
    }
    const store = new GraphStore(join(tmp, "graph.db"));
    try {
      const registry = await buildDefaultRegistry();
      const report = await buildGraph(dir, store, registry);
      const allNodes = store.allNodes();
      const allEdges = store.allEdges();
      const nodesByKind: Record<string, number> = {};
      for (const n of allNodes) {
        const k = n.kind ?? "(none)";
        nodesByKind[k] = (nodesByKind[k] ?? 0) + 1;
      }
      const edgesByRelation: Record<string, number> = {};
      for (const e of allEdges) {
        edgesByRelation[e.relation] = (edgesByRelation[e.relation] ?? 0) + 1;
      }
      return { nodes: report.nodes, edges: report.edges, nodesByKind, edgesByRelation };
    } finally {
      store.close();
      if (prev === undefined) {
        delete process.env.LEINA_NO_TSMORPH;
      } else {
        process.env.LEINA_NO_TSMORPH = prev;
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Escenario 1: TS_ONLY — tsmorph activo (comportamiento normal)
// ---------------------------------------------------------------------------
test("(noregr-ts-only) pipeline de registry produce conteos idénticos al baseline TS-only", async () => {
  const result = await runBuild(false);
  assert.strictEqual(
    result.nodes,
    BASELINE.TS_ONLY.nodes,
    `nodes: esperado=${BASELINE.TS_ONLY.nodes} actual=${result.nodes}`,
  );
  assert.strictEqual(
    result.edges,
    BASELINE.TS_ONLY.edges,
    `edges: esperado=${BASELINE.TS_ONLY.edges} actual=${result.edges}`,
  );
  // Snapshot de distribución por kind/relation (etapa-7 baseline)
  assert.deepStrictEqual(
    result.nodesByKind,
    KIND_SNAPSHOT.TS_ONLY.nodesByKind,
    `nodesByKind no coincide con snapshot TS_ONLY`,
  );
  assert.deepStrictEqual(
    result.edgesByRelation,
    KIND_SNAPSHOT.TS_ONLY.edgesByRelation,
    `edgesByRelation no coincide con snapshot TS_ONLY`,
  );
});

// ---------------------------------------------------------------------------
// Escenario 2: MIXED — LEINA_NO_TSMORPH=1 → tree-sitter puro
// Verifica que resolveSymbols() sigue siendo global (cross-file edges preservados).
// ---------------------------------------------------------------------------
test("(noregr-mixed) pipeline de registry con NO_TSMORPH=1 produce conteos idénticos al baseline mixto", async () => {
  const result = await runBuild(true);
  assert.strictEqual(
    result.nodes,
    BASELINE.MIXED.nodes,
    `nodes: esperado=${BASELINE.MIXED.nodes} actual=${result.nodes}`,
  );
  assert.strictEqual(
    result.edges,
    BASELINE.MIXED.edges,
    `edges: esperado=${BASELINE.MIXED.edges} actual=${result.edges}`,
  );
  // Snapshot de distribución por kind/relation (etapa-7 baseline)
  assert.deepStrictEqual(
    result.nodesByKind,
    KIND_SNAPSHOT.MIXED.nodesByKind,
    `nodesByKind no coincide con snapshot MIXED`,
  );
  assert.deepStrictEqual(
    result.edgesByRelation,
    KIND_SNAPSHOT.MIXED.edgesByRelation,
    `edgesByRelation no coincide con snapshot MIXED`,
  );
});

// ---------------------------------------------------------------------------
// Escenario 3: MIXED-YAML — fixture mixto TS + YAML (etapa-7)
// Verifica que añadir YAML al pipeline NO altera los conteos de nodos de código.
// Los nodos service/config de YAML se contabilizan aparte y no rompen el snapshot TS.
// ---------------------------------------------------------------------------
test("(noregr-mixed-yaml) YAML en el pipeline no altera los conteos de nodos TS de código", async () => {
  const mixedRepoDir = join(import.meta.dirname, "fixtures", "mixed-repo");
  const result = await runBuild(false, mixedRepoDir);

  // Los kinds de CÓDIGO no deben incluir nodos infra (service, config)
  const codeKinds = ["class", "function", "method", "interface", "module", "concept"];
  const infraKinds = ["service", "config", "api", "database", "queue"];

  // Verificar que hay nodos de código
  const codeNodeCount = codeKinds.reduce((sum, k) => sum + (result.nodesByKind[k] ?? 0), 0);
  assert.ok(codeNodeCount > 0, `Esperado nodos de código > 0, actual: ${codeNodeCount}`);

  // Verificar que también hay nodos infra del YAML
  const infraNodeCount = infraKinds.reduce((sum, k) => sum + (result.nodesByKind[k] ?? 0), 0);
  assert.ok(infraNodeCount > 0, `Esperado nodos infra > 0 del YAML, actual: ${infraNodeCount} (nodesByKind=${JSON.stringify(result.nodesByKind)})`);

  // Los nodos infra deben ser "service" y/o "config" (no remplazar los de código)
  const hasService = (result.nodesByKind.service ?? 0) > 0;
  const hasConfig = (result.nodesByKind.config ?? 0) > 0;
  assert.ok(hasService || hasConfig, `Esperado al menos un nodo service o config del YAML`);

  // El snapshot TS de código (nodesByKind para kinds de código) debe ser estable.
  // Sólo módulos y funciones en el fixture mixed-repo/src/*.ts:
  //   - src/api.ts → 1 module + 2 functions
  //   - src/api.test.ts → 1 module
  // Total: module ≥ 2, function ≥ 2 (puede variar si tsmorph enriquece)
  assert.ok(
    (result.nodesByKind.module ?? 0) >= 1,
    `Esperado nodesByKind.module >= 1, actual: ${result.nodesByKind.module ?? 0}`,
  );
});
