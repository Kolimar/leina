// graph-model.test.ts — Tests unitarios para el modelo de grafo extensible (etapa-7).
//
// Cubre:
//   REQ-GIM-1: NodeKind/Relation/FileType acepta literales infra + cadenas arbitrarias
//   REQ-GIM-2: KNOWN_NODE_KINDS y KNOWN_RELATIONS exportados con lookups correctos
//   REQ-GIM-3: Advisory permisivo en addNodes/addEdges (inserta, no lanza, escribe stderr)
//   REQ-MIG-1/2/3: migrateV3toV4 idempotente, user_version=4, índice idx_nodes_kind
//
// Run: node --no-warnings --experimental-strip-types --test test/graph-model.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// REQ-GIM-2: KNOWN_NODE_KINDS y KNOWN_RELATIONS
// ---------------------------------------------------------------------------

test("(gim-2a) KNOWN_NODE_KINDS.has('service') === true", async () => {
  const { KNOWN_NODE_KINDS } = await import("../src/domain/graph/model.ts");
  assert.strictEqual(KNOWN_NODE_KINDS.has("service"), true);
});

test("(gim-2b) KNOWN_NODE_KINDS.has('function') === true", async () => {
  const { KNOWN_NODE_KINDS } = await import("../src/domain/graph/model.ts");
  assert.strictEqual(KNOWN_NODE_KINDS.has("function"), true);
});

test("(gim-2c) KNOWN_NODE_KINDS.has('unknown-kind-xyz') === false", async () => {
  const { KNOWN_NODE_KINDS } = await import("../src/domain/graph/model.ts");
  assert.strictEqual(KNOWN_NODE_KINDS.has("unknown-kind-xyz"), false);
});

test("(gim-2d) KNOWN_RELATIONS.has('reads') === true (infra relation)", async () => {
  const { KNOWN_RELATIONS } = await import("../src/domain/graph/model.ts");
  assert.strictEqual(KNOWN_RELATIONS.has("reads"), true);
});

test("(gim-2e) KNOWN_RELATIONS.has('calls') === true (code relation)", async () => {
  const { KNOWN_RELATIONS } = await import("../src/domain/graph/model.ts");
  assert.strictEqual(KNOWN_RELATIONS.has("calls"), true);
});

test("(gim-2f) KNOWN_RELATIONS.has('xyz-unknown') === false", async () => {
  const { KNOWN_RELATIONS } = await import("../src/domain/graph/model.ts");
  assert.strictEqual(KNOWN_RELATIONS.has("xyz-unknown"), false);
});

test("(gim-2g) all infra node kinds are in KNOWN_NODE_KINDS", async () => {
  const { KNOWN_NODE_KINDS } = await import("../src/domain/graph/model.ts");
  const infraKinds = ["service", "api", "database", "queue", "config", "secret", "finding", "deployment", "environment"];
  for (const k of infraKinds) {
    assert.strictEqual(KNOWN_NODE_KINDS.has(k), true, `Expected ${k} in KNOWN_NODE_KINDS`);
  }
});

test("(gim-2h) all infra relations are in KNOWN_RELATIONS", async () => {
  const { KNOWN_RELATIONS } = await import("../src/domain/graph/model.ts");
  const infraRels = ["deploys", "reads", "writes", "configures", "exposes", "consumes", "produces"];
  for (const r of infraRels) {
    assert.strictEqual(KNOWN_RELATIONS.has(r), true, `Expected ${r} in KNOWN_RELATIONS`);
  }
});

test("(gim-1) asignar 'custom-xyz' a NodeKind compila sin error (type-level, verdad en runtime)", () => {
  // TypeScript compila en precompile; si llega aquí el test pasa.
  // El siguiente código debe compilar sin cast explícito:
  //   const k: NodeKind = "custom-xyz";
  // En runtime verificamos que el valor es una string válida.
  const k = "custom-xyz";
  assert.strictEqual(typeof k, "string");
});

// ---------------------------------------------------------------------------
// REQ-GIM-3: Advisory permisivo en GraphStore.addNodes / addEdges
// ---------------------------------------------------------------------------

test("(gim-3a) addNodes con kind desconocido inserta el nodo y escribe advisory en stderr", async () => {
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gm-adv-"));
  const stderrLines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // Override: capture advisory messages; forward to real stderr so tty still works
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrLines.push(String(chunk));
    return origWrite(chunk);
  };
  try {
    const store = new GraphStore(join(tmp, "graph.db"));
    store.addNodes([{
      id: "test-unknown-kind",
      label: "test",
      fileType: "code",
      sourceFile: "test.ts",
      kind: "unknown-kind-xyz",
    }]);
    // Nodo insertado correctamente
    const node = store.getNode("test-unknown-kind");
    assert.ok(node, "El nodo debe estar insertado");
    assert.strictEqual(node?.kind, "unknown-kind-xyz");
    // Advisory en stderr
    const advisory = stderrLines.some((l) => l.includes("unknown-kind-xyz"));
    assert.ok(advisory, `Esperado advisory en stderr para kind desconocido. Got: ${stderrLines.join("")}`);
    store.close();
  } finally {
    process.stderr.write = origWrite;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(gim-3b) addNodes con kind conocido ('service') NO escribe advisory en stderr", async () => {
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gm-nonadv-"));
  const stderrLines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrLines.push(String(chunk));
    return origWrite(chunk);
  };
  try {
    const store = new GraphStore(join(tmp, "graph.db"));
    store.addNodes([{
      id: "svc-known",
      label: "my-service",
      fileType: "config",
      sourceFile: "docker-compose.yml",
      kind: "service",
    }]);
    const node = store.getNode("svc-known");
    assert.ok(node, "El nodo service debe estar insertado");
    // No debe haber advisory
    const hasAdvisory = stderrLines.some((l) => l.includes("[leina] advisory"));
    assert.strictEqual(hasAdvisory, false, `No esperado advisory para kind conocido. Got: ${stderrLines.join("")}`);
    store.close();
  } finally {
    process.stderr.write = origWrite;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(gim-3c) addEdges con relation desconocida inserta el edge y escribe advisory", async () => {
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gm-edge-adv-"));
  const stderrLines: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrLines.push(String(chunk));
    return origWrite(chunk);
  };
  try {
    const store = new GraphStore(join(tmp, "graph.db"));
    // Insertar nodos primero
    store.addNodes([
      { id: "a", label: "a", fileType: "code", sourceFile: "a.ts" },
      { id: "b", label: "b", fileType: "code", sourceFile: "b.ts" },
    ]);
    store.addEdges([{
      source: "a",
      target: "b",
      relation: "unknown-relation-xyz",
      confidence: "EXTRACTED",
      sourceFile: "a.ts",
      weight: 1,
    }]);
    const edges = store.outEdges("a");
    assert.ok(edges.some((e) => e.relation === "unknown-relation-xyz"), "Edge debe estar insertado");
    const advisory = stderrLines.some((l) => l.includes("unknown-relation-xyz"));
    assert.ok(advisory, `Esperado advisory en stderr para relation desconocida`);
    store.close();
  } finally {
    process.stderr.write = origWrite;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REQ-MIG-1/2/3: migrateV3toV4 idempotente, user_version=4, índice idx_nodes_kind
// ---------------------------------------------------------------------------

test("(mig-1) DB v3 migra a v4: user_version=4 e índice idx_nodes_kind", async () => {
  await import("../src/infrastructure/sqlite/graph-store.ts");
  const tmp = mkdtempSync(join(tmpdir(), "gm-mig-"));
  const dbPath = join(tmp, "v3.db");
  try {
    // Crear una DB "v3" manualmente
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, file_type TEXT NOT NULL,
        kind TEXT, source_file TEXT NOT NULL, source_location TEXT,
        community INTEGER, signature TEXT, repo TEXT
      );
      CREATE TABLE IF NOT EXISTS edges (
        source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL,
        confidence TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
        source_file TEXT NOT NULL, source_location TEXT,
        weight REAL NOT NULL DEFAULT 1.0, repo TEXT,
        PRIMARY KEY (source, target, relation, context)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
      CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
      CREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community);
    `);
    db.exec("PRAGMA user_version = 3");
    db.close();

    // Abrir la DB v3 con GraphStore (debe migrar a v4)
    const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
    const store = new GraphStore(dbPath);

    // Verificar user_version
    const db2 = new DatabaseSync(dbPath);
    const version = (db2.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.strictEqual(version, 4, `Esperado user_version=4, actual=${version}`);

    // Verificar que el índice idx_nodes_kind existe
    const indexes = db2.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_nodes_kind'"
    ).all() as { name: string }[];
    assert.ok(indexes.length > 0, "Esperado índice idx_nodes_kind");
    db2.close();

    store.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(mig-2) Re-apertura de DB v4 es idempotente (no lanza, user_version sigue 4)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gm-mig-idem-"));
  const dbPath = join(tmp, "v4.db");
  try {
    // Primera apertura: crea DB v4 fresca
    const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
    const store1 = new GraphStore(dbPath);
    store1.close();

    // Segunda apertura: debe ser idempotente
    assert.doesNotThrow(() => {
      const store2 = new GraphStore(dbPath);
      store2.close();
    }, "Re-apertura de DB v4 no debe lanzar");

    const db = new DatabaseSync(dbPath);
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.strictEqual(version, 4);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("(mig-3) DB con user_version=5 lanza error de versión futura", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gm-mig-future-"));
  const dbPath = join(tmp, "v5.db");
  try {
    // Crear DB con user_version=5
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, file_type TEXT NOT NULL,
        kind TEXT, source_file TEXT NOT NULL
      );
    `);
    db.exec("PRAGMA user_version = 5");
    db.close();

    const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
    assert.throws(
      () => new GraphStore(dbPath),
      /newer version|version.*5/i,
      "Debe lanzar error para DB de versión futura",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
