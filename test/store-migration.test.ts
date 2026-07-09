// Graph store schema test — current (v4) behavior.
//
// graph.db is a derived artifact: a fresh DB gets the full v4 shape straight
// from SCHEMA (no in-place migration of pre-1.0 partial DBs). Validates that:
//   - A fresh DB (user_version=0) ends up stamped at v4 with the `signature`
//     and `repo` columns present, via the CREATE TABLE in SCHEMA.
//   - Round-trip: nodes/edges with and without signature/repo write and read
//     back intact (absent fields come back as undefined).
//   - A DB stamped at a version newer than the binary is rejected.
//
// Also covers memory DB schema migration v4 → v5 (T10 etapa-3-identity-scopes):
//   - DB en v4 → abre y sube a v5, datos preservados
//   - Re-apertura idempotente (v5 → sigue en v5)
//   - Los 9 scopes se guardan y recuperan correctamente
//   - uq_obs_topic con scope incluido en la clave única

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import type { GraphNode, GraphEdge, Signature } from "../src/domain/graph/model.ts";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";
import { ensureMemorySchema, MEMORY_SCHEMA_VERSION, LIKE_DDL } from "../src/infrastructure/sqlite/schema.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "leina-store-mig-"));
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as { name: string }[];
  return cols.some((c) => c.name === column);
}

function getUserVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number })
    .user_version;
}

// ---------------------------------------------------------------------------

test("(store-mig-fresh) fresh db (user_version=0) gets the v3 shape via SCHEMA, not via migration", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    // Fresh DB — no setup. Construct the store directly; it runs SCHEMA's
    // CREATE TABLE IF NOT EXISTS which already declares `signature TEXT` and `repo TEXT`.
    new GraphStore(dbPath).close();

    const probe = new DatabaseSync(dbPath);
    assert.equal(hasColumn(probe, "nodes", "signature"), true, "fresh: signature col should exist");
    assert.equal(getUserVersion(probe), 4, "fresh: user_version should be 4");
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(store-mig-roundtrip) writing/reading nodes with and without signature works post-migration", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    const store = new GraphStore(dbPath);
    try {
      const sig: Signature = {
        returnType: { text: "string", nullable: false },
        parameters: [{ name: "x", type: "number", nullable: false, optional: false }],
        isAsync: false,
        isGenerator: false,
      };
      const withSig: GraphNode = {
        id: "rt:withSig",
        label: "withSig()",
        fileType: "code",
        kind: "function",
        sourceFile: "rt.ts",
        signature: sig,
      };
      const withoutSig: GraphNode = {
        id: "rt:plain",
        label: "plain()",
        fileType: "code",
        kind: "function",
        sourceFile: "rt.ts",
      };
      store.addNodes([withSig, withoutSig]);

      const readWith = store.getNode("rt:withSig");
      assert.ok(readWith, "node with signature must be retrievable");
      assert.deepEqual(readWith.signature, sig, "signature round-trips intact");

      const readPlain = store.getNode("rt:plain");
      assert.ok(readPlain, "node without signature must be retrievable");
      assert.equal(readPlain.signature, undefined, "missing signature reads back as undefined");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(store-mig-newer-db-rejected) a db stamped at a version newer than the binary throws", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    // Pre-stamp a DB at a future version > current GRAPH_SCHEMA_VERSION (3).
    {
      const raw = new DatabaseSync(dbPath);
      raw.exec("PRAGMA user_version = 999");
      raw.close();
    }
    assert.throws(
      () => new GraphStore(dbPath),
      /newer version of leina/,
      "should reject DBs from a newer binary",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(store-mig-v3-roundtrip-repo) node and edge with repo field round-trips correctly", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    const store = new GraphStore(dbPath);
    try {
      const nodeWithRepo: GraphNode = {
        id: "repo-a::src_auth_ts:build_token",
        label: "buildToken()",
        fileType: "code",
        kind: "function",
        sourceFile: "src/auth.ts",
        repo: "repo-a",
      };
      const nodeNoRepo: GraphNode = {
        id: "src_auth_ts:build_token",
        label: "buildToken()",
        fileType: "code",
        kind: "function",
        sourceFile: "src/auth.ts",
      };
      store.addNodes([nodeWithRepo, nodeNoRepo]);

      const readWith = store.getNode("repo-a::src_auth_ts:build_token");
      assert.ok(readWith, "node with repo must be retrievable");
      assert.equal(readWith.repo, "repo-a", "repo field must round-trip");

      const readWithout = store.getNode("src_auth_ts:build_token");
      assert.ok(readWithout, "node without repo must be retrievable");
      assert.equal(readWithout.repo, undefined, "absent repo reads back as undefined");

      // Edge round-trip
      const edgeWithRepo: GraphEdge = {
        source: "repo-a::src_auth_ts:build_token",
        target: "repo-a::src_auth_ts:build_token",
        relation: "calls",
        confidence: "EXTRACTED",
        sourceFile: "src/auth.ts",
        weight: 1,
        repo: "repo-a",
      };
      store.addEdges([edgeWithRepo]);
      const edges = store.outEdges("repo-a::src_auth_ts:build_token");
      assert.equal(edges.length, 1);
      assert.equal(edges[0]!.repo, "repo-a", "edge repo must round-trip");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Memory DB schema migration v4 → v5 (T10 etapa-3-identity-scopes)
// ---------------------------------------------------------------------------

/**
 * Crea una DB de memoria v4 de fixture: aplica el DDL base (LIKE_DDL) y estampa
 * user_version=4. En v4→v5 el esquema SQL no cambia (no-op), así que LIKE_DDL
 * es idéntico al de v4.
 */
function makeMemoryV4Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(LIKE_DDL);
  db.exec("PRAGMA user_version = 4");
  // Insertar una observación de prueba para verificar que los datos se preservan
  const now = Date.now();
  db.prepare(
    `INSERT INTO observations (id, project_key, scope, type, title, content, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("fixture-obs-1", "test-project", "project", "architecture", "Fixture Title", "Fixture Content", now, now, 1);
  db.close();
}

test("(mem-mig-v4tov5) DB en v4 migra a v5 al abrir: user_version=5 y datos preservados", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "memory.db");
    makeMemoryV4Db(dbPath);

    // Pre: user_version=4
    {
      const probe = new DatabaseSync(dbPath);
      assert.equal(getUserVersion(probe), 4, "fixture debe estar en v4");
      probe.close();
    }

    // Abrir con ensureMemorySchema → debe migrar a v5
    {
      const db = new DatabaseSync(dbPath);
      ensureMemorySchema(db);
      db.close();
    }

    // Post: user_version=5, datos preservados
    {
      const probe = new DatabaseSync(dbPath);
      assert.equal(getUserVersion(probe), 5, "debe estar en v5 tras la migración");
      const count = (
        probe.prepare("SELECT COUNT(*) AS n FROM observations").get() as unknown as { n: number }
      ).n;
      assert.equal(count, 1, "la observación de fixture debe preservarse");
      probe.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mem-mig-v4tov5-idempotent) abrir dos veces la misma DB v5 es idempotente", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "memory.db");
    makeMemoryV4Db(dbPath);

    // Primera apertura: v4 → v5
    {
      const db = new DatabaseSync(dbPath);
      ensureMemorySchema(db);
      db.close();
    }
    // Segunda apertura: v5 → sigue en v5 (no sube a v6)
    {
      const db = new DatabaseSync(dbPath);
      ensureMemorySchema(db);
      assert.equal(getUserVersion(db), 5, "segunda apertura no debe cambiar la versión");
      db.close();
    }
    // MEMORY_SCHEMA_VERSION debe ser exactamente 5
    assert.equal(MEMORY_SCHEMA_VERSION, 5, "MEMORY_SCHEMA_VERSION debe ser 5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mem-mig-9-scopes) los 9 scopes se guardan y buscan correctamente", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "memory.db");
    const scopes = [
      "project", "personal", "workspace", "path",
      "skill", "process", "technology", "security", "infra",
    ] as const;

    const store = new SQLiteMemoryRepository(dbPath, "test-project", () => []);
    try {
      for (const scope of scopes) {
        const { observation } = store.save({
          title: `Title for ${scope}`,
          content: `Content for ${scope}`,
          type: "architecture",
          scope,
        });
        assert.equal(observation.scope, scope, `scope '${scope}' debe persistirse correctamente`);
      }

      // Verificar que cada scope se recupera independientemente
      for (const scope of scopes) {
        const hits = store.search(`Title for ${scope}`, { scope, limit: 5 });
        assert.ok(hits.length > 0, `debe encontrarse la observación de scope '${scope}'`);
        assert.ok(hits.every((h) => h.scope === scope), `hits deben ser solo de scope '${scope}'`);
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mem-mig-uq-obs-topic) misma topic_key en distinto scope → sin conflicto de uq_obs_topic", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "memory.db");
    const store = new SQLiteMemoryRepository(dbPath, "test-project", () => []);
    try {
      // Guardar con scope=project y topic_key="foo"
      store.save({
        title: "Obs project",
        content: "content",
        type: "architecture",
        topicKey: "shared-topic",
        scope: "project",
      });
      // Guardar con scope=security y la misma topic_key → NO debe lanzar
      assert.doesNotThrow(() => {
        store.save({
          title: "Obs security",
          content: "content",
          type: "architecture",
          topicKey: "shared-topic",
          scope: "security",
        });
      }, "misma topic_key en distinto scope no debe violar uq_obs_topic");

      // Ambas deben ser recuperables
      const projectHits = store.search("Obs project", { scope: "project" });
      const securityHits = store.search("Obs security", { scope: "security" });
      assert.ok(projectHits.length > 0, "observación de scope=project recuperable");
      assert.ok(securityHits.length > 0, "observación de scope=security recuperable");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mem-mig-default-scope) save sin --scope guarda con scope='project'", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "memory.db");
    const store = new SQLiteMemoryRepository(dbPath, "test-project", () => []);
    try {
      // scope por defecto en ObservationInput es undefined → la store usa "project"
      const { observation } = store.save({
        title: "Default scope obs",
        content: "content",
        type: "manual",
        // scope: omitido → default project
      });
      assert.equal(observation.scope, "project", "scope por defecto debe ser 'project'");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
