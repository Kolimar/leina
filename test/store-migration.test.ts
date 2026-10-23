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
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import type { GraphNode, GraphEdge, Signature } from "../src/domain/graph/model.ts";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";
import { ensureMemorySchema, MEMORY_SCHEMA_VERSION, LIKE_DDL } from "../src/infrastructure/sqlite/schema.ts";

const REPOSITORY_MODULE = fileURLToPath(new URL("../src/infrastructure/sqlite/memory-repository.ts", import.meta.url));

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

test("(mem-mig-v4tov5) DB en v4 migra hasta la versión actual al abrir y conserva los datos", () => {
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

    // Abrir con ensureMemorySchema → recorre la escalera completa (v4 → … → actual)
    {
      const db = new DatabaseSync(dbPath);
      ensureMemorySchema(db);
      db.close();
    }

    // Post: user_version=actual, datos preservados
    {
      const probe = new DatabaseSync(dbPath);
      assert.equal(getUserVersion(probe), MEMORY_SCHEMA_VERSION, "debe quedar en la versión actual");
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

function memoryBackups(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("memory.db.bak-"));
}

test("(mem-mig-backup) an outdated memory.db is copied before the ladder upgrades it", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "memory.db");
    makeMemoryV4Db(dbPath);
    const db = new DatabaseSync(dbPath);
    ensureMemorySchema(db);
    db.close();

    const backups = memoryBackups(dir);
    assert.equal(backups.length, 1, "one copy before migrating");
    assert.match(backups[0]!, /^memory\.db\.bak-v4-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
    const copy = new DatabaseSync(join(dir, backups[0]!));
    assert.equal(getUserVersion(copy), 4, "the copy keeps the old version");
    const n = (copy.prepare("SELECT COUNT(*) AS n FROM observations").get() as unknown as { n: number }).n;
    assert.equal(n, 1, "the copy keeps the rows");
    copy.close();

    // The db is current now: reopening it takes no second copy.
    const again = new DatabaseSync(dbPath);
    ensureMemorySchema(again);
    again.close();
    assert.equal(memoryBackups(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mem-mig-backup-fresh) a brand-new or in-memory db gets no backup", () => {
  const dir = makeTmpDir();
  try {
    const db = new DatabaseSync(join(dir, "memory.db"));
    ensureMemorySchema(db);
    db.close();
    assert.deepEqual(memoryBackups(dir), []);
    // An in-memory db has no file to copy, even when it holds outdated tables.
    const mem = new DatabaseSync(":memory:");
    mem.exec(LIKE_DDL);
    mem.exec("PRAGMA user_version = 4");
    ensureMemorySchema(mem);
    assert.equal(getUserVersion(mem), MEMORY_SCHEMA_VERSION);
    mem.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mem-mig-backup-race) processes opening an outdated db at once: all succeed, one backup", async () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "memory.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(LIKE_DDL);
    db.exec("PRAGMA user_version = 4");
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO observations (id, project_key, scope, type, title, content, created_at, updated_at, revision)
       VALUES (?, 'p', 'project', 'architecture', 't', ?, ?, ?, 1)`,
    );
    for (let i = 0; i < 500; i++) insert.run(`o${i}`, "c".repeat(500), now, now);
    db.close();

    // All children open at the same instant; the lead covers a slow process start.
    const startAt = Date.now() + 4000;
    const script =
      `const m = await import(${JSON.stringify(pathToFileURL(REPOSITORY_MODULE).href)});` +
      `while (Date.now() < ${startAt}) {}` +
      `new m.SQLiteMemoryRepository(${JSON.stringify(dbPath)}, "p");`;
    const runs = Array.from({ length: 6 }, () =>
      new Promise<void>((ok, ko) => {
        const child = spawn(
          process.execPath,
          ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let err = "";
        child.stderr.on("data", (c: Buffer) => (err += c.toString()));
        child.on("error", ko);
        child.on("close", (code) => (code === 0 ? ok() : ko(new Error(`child exit ${code}: ${err}`))));
      }),
    );
    await Promise.all(runs);

    const backups = memoryBackups(dir).filter((f) => !/-(wal|shm)$/.test(f));
    assert.equal(backups.length, 1, `one backup: ${backups.join(", ")}`);
    const copy = new DatabaseSync(join(dir, backups[0]!));
    assert.equal(getUserVersion(copy), 4, "the copy is the untouched db");
    copy.close();
    const probe = new DatabaseSync(dbPath);
    assert.equal(getUserVersion(probe), MEMORY_SCHEMA_VERSION);
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A read-only directory refuses the copy (POSIX permissions; root bypasses them).
const cannotDenyWrites = process.platform === "win32" || process.getuid?.() === 0;

test("(mem-mig-backup-fails-closed) a failed backup migrates nothing", { skip: cannotDenyWrites }, () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "memory.db");
    makeMemoryV4Db(dbPath);
    chmodSync(dir, 0o500);
    try {
      const db = new DatabaseSync(dbPath);
      assert.throws(
        () => ensureMemorySchema(db),
        new RegExp(`migration from v4 to v${MEMORY_SCHEMA_VERSION}, but its backup .* failed .*nothing was changed`),
      );
      db.close();
    } finally {
      chmodSync(dir, 0o700);
    }
    const probe = new DatabaseSync(dbPath);
    assert.equal(getUserVersion(probe), 4, "nothing migrated");
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mem-mig-v4tov5-idempotent) abrir dos veces la misma DB migrada es idempotente", () => {
  const dir = makeTmpDir();
  try {
    const dbPath = join(dir, "memory.db");
    makeMemoryV4Db(dbPath);

    // Primera apertura: v4 → actual
    {
      const db = new DatabaseSync(dbPath);
      ensureMemorySchema(db);
      db.close();
    }
    // Segunda apertura: sigue en la versión actual
    {
      const db = new DatabaseSync(dbPath);
      ensureMemorySchema(db);
      assert.equal(getUserVersion(db), MEMORY_SCHEMA_VERSION, "segunda apertura no debe cambiar la versión");
      db.close();
    }
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
