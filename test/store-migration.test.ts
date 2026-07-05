// Graph store schema migration test — v1 -> v2, v2 -> v3.
//
// Validates that:
//   - A DB stamped at user_version=1 with the legacy `nodes` shape (no
//     `signature` column) is migrated forward to v2 idempotently.
//   - The `signature` column is added by ALTER TABLE, not by reissuing the
//     CREATE TABLE (which is a no-op when the table already exists).
//   - Re-instantiating the store on the migrated DB is a no-op (idempotent).
//   - Fresh DBs (user_version=0) also end up with the column, via the
//     CREATE TABLE in SCHEMA (without going through migrateV1toV2).
//   - Round-trip: a node with a signature can be written and read back, and
//     a node without one comes back with signature=undefined.
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
import { GraphStore, migrateV2toV3 } from "../src/infrastructure/sqlite/graph-store.ts";
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

// Build a "legacy" v1 DB by hand: CREATE TABLE without `signature`, stamp version 1.
function makeV1Db(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      file_type TEXT NOT NULL,
      kind TEXT,
      source_file TEXT NOT NULL,
      source_location TEXT,
      community INTEGER
    );
    CREATE TABLE edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      source_file TEXT NOT NULL,
      source_location TEXT,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (source, target, relation, context)
    );
    PRAGMA user_version = 1;
  `);
  // Insert a legacy node (no signature column to write to — pre-migration shape).
  db.prepare(
    `INSERT INTO nodes (id, label, file_type, kind, source_file, source_location, community)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("legacy:node", "legacyNode()", "code", "function", "legacy.ts", "L1", null);
  db.close();
}

// ---------------------------------------------------------------------------

test("(store-mig-v1tov2) v1 db migrated forward: signature column added, version bumped", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    makeV1Db(dbPath);

    // Sanity: pre-migration shape has no signature column and is stamped at v1.
    {
      const probe = new DatabaseSync(dbPath);
      assert.equal(hasColumn(probe, "nodes", "signature"), false, "pre-migration: signature col should NOT exist");
      assert.equal(getUserVersion(probe), 1, "pre-migration: user_version should be 1");
      probe.close();
    }

    // Run the migration by instantiating the store.
    const store = new GraphStore(dbPath);
    store.close();

    // Post-migration: column exists and version bumped.
    const probe = new DatabaseSync(dbPath);
    assert.equal(hasColumn(probe, "nodes", "signature"), true, "post-migration: signature col should exist");
    assert.equal(getUserVersion(probe), 4, "post-migration: user_version should be 4");
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(store-mig-idempotent) running migration twice is a no-op", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    makeV1Db(dbPath);

    // First instantiation: migrates v1 -> v2 -> v3.
    new GraphStore(dbPath).close();
    // Second instantiation: should be a no-op (v3 == v3).
    new GraphStore(dbPath).close();

    const probe = new DatabaseSync(dbPath);
    assert.equal(getUserVersion(probe), 4);
    // Migration's ALTER TABLE is column-guarded, so re-running it does NOT
    // produce duplicate columns. PRAGMA table_info should report `signature`
    // exactly once.
    const sigCols = (
      probe.prepare("PRAGMA table_info(nodes)").all() as unknown as { name: string }[]
    ).filter((c) => c.name === "signature");
    assert.equal(sigCols.length, 1, "signature column must appear exactly once");
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

// Build a "legacy pre-versioning" DB: old-shape tables (no signature/repo) but
// user_version=0 — the state of any graph.db created before schema versioning was
// introduced. This is the regression case: a plain "v===0 → stamp latest" path
// left the new columns missing and the next INSERT failed with a SQL logic error.
function makeLegacyUnversionedDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      file_type TEXT NOT NULL,
      kind TEXT,
      source_file TEXT NOT NULL,
      source_location TEXT,
      community INTEGER
    );
    CREATE TABLE edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      source_file TEXT NOT NULL,
      source_location TEXT,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (source, target, relation, context)
    );
  `); // NOTE: user_version intentionally left at its default of 0.
  db.close();
}

test("(store-mig-legacy-unversioned) old-shape db with user_version=0 is migrated, not falsely stamped", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    makeLegacyUnversionedDb(dbPath);

    // Sanity: pre-existing tables, old shape, version 0.
    {
      const probe = new DatabaseSync(dbPath);
      assert.equal(getUserVersion(probe), 0, "pre: user_version should be 0");
      assert.equal(hasColumn(probe, "nodes", "signature"), false, "pre: no signature col");
      assert.equal(hasColumn(probe, "nodes", "repo"), false, "pre: no repo col");
      assert.equal(hasColumn(probe, "edges", "repo"), false, "pre: no edges.repo col");
      probe.close();
    }

    // Construct the store: must migrate the existing tables, not just stamp v3.
    const store = new GraphStore(dbPath);
    try {
      // The regression: this INSERT used to fail with "table nodes has no column
      // named signature" (SQL logic error) because columns were never added.
      store.addNodes([
        { id: "n:1", label: "fn", fileType: "code", kind: "function", sourceFile: "a.ts" },
      ]);
      store.addEdges([
        { source: "n:1", target: "n:1", relation: "calls", confidence: "EXTRACTED", sourceFile: "a.ts", weight: 1 },
      ]);
      assert.ok(store.getNode("n:1"), "node must round-trip after migration");
    } finally {
      store.close();
    }

    const probe = new DatabaseSync(dbPath);
    assert.equal(hasColumn(probe, "nodes", "signature"), true, "post: signature col added");
    assert.equal(hasColumn(probe, "nodes", "repo"), true, "post: nodes.repo col added");
    assert.equal(hasColumn(probe, "edges", "repo"), true, "post: edges.repo col added");
    assert.equal(getUserVersion(probe), 4, "post: user_version bumped to 4");
    probe.close();
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

// ---------------------------------------------------------------------------
// v2 -> v3 migration tests
// ---------------------------------------------------------------------------

// Build a "legacy" v2 DB by hand: CREATE TABLE with `signature` but no `repo`.
function makeV2Db(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      file_type TEXT NOT NULL,
      kind TEXT,
      source_file TEXT NOT NULL,
      source_location TEXT,
      community INTEGER,
      signature TEXT
    );
    CREATE TABLE edges (
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      source_file TEXT NOT NULL,
      source_location TEXT,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (source, target, relation, context)
    );
    PRAGMA user_version = 2;
  `);
  // Insert a legacy node and edge (no repo column yet — pre-migration shape).
  db.prepare(
    `INSERT INTO nodes (id, label, file_type, kind, source_file, source_location, community, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("legacy:node2", "legacyNode2()", "code", "function", "legacy2.ts", "L1", null, null);
  db.prepare(
    `INSERT INTO edges (source, target, relation, confidence, context, source_file, weight)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("legacy:node2", "legacy:node2", "calls", "EXTRACTED", "", "legacy2.ts", 1.0);
  db.close();
}

test("(store-mig-v2tov3) v2 db migrated forward: repo columns added, version bumped to 3", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    makeV2Db(dbPath);

    // Sanity: pre-migration has no repo column.
    {
      const probe = new DatabaseSync(dbPath);
      assert.equal(hasColumn(probe, "nodes", "repo"), false, "pre-migration: nodes.repo should NOT exist");
      assert.equal(hasColumn(probe, "edges", "repo"), false, "pre-migration: edges.repo should NOT exist");
      assert.equal(getUserVersion(probe), 2, "pre-migration: user_version should be 2");
      probe.close();
    }

    // Run the migration by instantiating the store.
    const store = new GraphStore(dbPath);
    store.close();

    // Post-migration assertions.
    const probe = new DatabaseSync(dbPath);
    assert.equal(hasColumn(probe, "nodes", "repo"), true, "post-migration: nodes.repo should exist");
    assert.equal(hasColumn(probe, "edges", "repo"), true, "post-migration: edges.repo should exist");
    assert.equal(getUserVersion(probe), 4, "post-migration: user_version should be 4");
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(store-mig-v2tov3-idempotent) running v2->v3 migration twice is a no-op", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    makeV2Db(dbPath);

    new GraphStore(dbPath).close(); // first migration
    new GraphStore(dbPath).close(); // second — must be no-op

    const probe = new DatabaseSync(dbPath);
    assert.equal(getUserVersion(probe), 4);
    // repo column appears exactly once in nodes
    const nodeRepoCols = (
      probe.prepare("PRAGMA table_info(nodes)").all() as unknown as { name: string }[]
    ).filter((c) => c.name === "repo");
    assert.equal(nodeRepoCols.length, 1, "nodes.repo must appear exactly once");
    // repo column appears exactly once in edges
    const edgeRepoCols = (
      probe.prepare("PRAGMA table_info(edges)").all() as unknown as { name: string }[]
    ).filter((c) => c.name === "repo");
    assert.equal(edgeRepoCols.length, 1, "edges.repo must appear exactly once");
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(store-mig-v2tov3-existing-rows-null) pre-existing v2 rows get repo=NULL after migration", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    makeV2Db(dbPath);

    const store = new GraphStore(dbPath);
    const node = store.getNode("legacy:node2");
    assert.ok(node, "legacy node must be retrievable after migration");
    assert.equal(node.repo, undefined, "pre-existing node must have repo=undefined (NULL)");
    store.close();
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

test("(store-mig-v1tov3) v1 db migrates through v2 then v3 in one open", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    makeV1Db(dbPath);
    new GraphStore(dbPath).close();
    const probe = new DatabaseSync(dbPath);
    assert.equal(getUserVersion(probe), 4, "v1 must migrate all the way to v4");
    assert.equal(hasColumn(probe, "nodes", "signature"), true);
    assert.equal(hasColumn(probe, "nodes", "repo"), true);
    assert.equal(hasColumn(probe, "edges", "repo"), true);
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(store-mig-v3-fresh) fresh db gets v3 shape via SCHEMA", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    new GraphStore(dbPath).close();
    const probe = new DatabaseSync(dbPath);
    assert.equal(getUserVersion(probe), 4, "fresh db should be stamped v4");
    assert.equal(hasColumn(probe, "nodes", "repo"), true);
    assert.equal(hasColumn(probe, "edges", "repo"), true);
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(store-mig-v2tov3-exported-fn) migrateV2toV3 exported and callable directly", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "graph.db");
    makeV2Db(dbPath);
    const db = new DatabaseSync(dbPath);
    migrateV2toV3(db); // should not throw
    assert.equal(hasColumn(db, "nodes", "repo"), true);
    assert.equal(hasColumn(db, "edges", "repo"), true);
    migrateV2toV3(db); // idempotent second call
    db.close();
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
