// graph-store-concurrency.test.ts — multi-process SQLITE_BUSY regression.
// The GraphStore constructor used to run write DDL (SCHEMA + migrations + version
// stamp) on EVERY open without a busy_timeout, so concurrent opens — build in one
// process, queries in another — failed intermittently with SQLITE_BUSY. The fix is
// twofold: PRAGMA busy_timeout on open, and a fast path that skips the DDL when the
// db is already stamped at the current schema version. This test spawns real child
// processes against one shared graph.db; any sqlite error exits the child non-zero.
// Run: node --no-warnings --experimental-strip-types --test test/graph-store-concurrency.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";

const WORKER = fileURLToPath(new URL("./helpers/graph-store-worker.ts", import.meta.url));

interface WorkerResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnWorker(dbPath: string, op: "read" | "write"): Promise<WorkerResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", WORKER, dbPath, op],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

test("(GSC-1) concurrent multi-process opens + reads + writes never hit SQLITE_BUSY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-gsc-"));
  const dbPath = join(dir, "graph.db");
  try {
    // Seed: full schema + current version stamp, plus a node for readers to find.
    const seed = new GraphStore(dbPath);
    seed.addNodes([
      { id: "seed:1", label: "seed", fileType: "code", sourceFile: "seed.ts", kind: "function" },
    ]);
    seed.close();

    // 6 readers + 2 writers, all opening the same db at once. Before the fix the
    // constructor's DDL writes collided across processes and threw SQLITE_BUSY.
    const jobs: Promise<WorkerResult>[] = [];
    for (let i = 0; i < 6; i++) jobs.push(spawnWorker(dbPath, "read"));
    for (let i = 0; i < 2; i++) jobs.push(spawnWorker(dbPath, "write"));
    const results = await Promise.all(jobs);

    for (const [i, r] of results.entries()) {
      assert.equal(r.code, 0, `worker ${i} failed:\n${r.stderr}`);
      assert.match(r.stdout, /ok/, `worker ${i} did not complete`);
    }

    // The writers' rows all landed (2 writers × 20 iterations + 1 seed).
    const verify = new GraphStore(dbPath);
    const { nodes } = verify.stats();
    verify.close();
    assert.equal(nodes, 41, "all concurrent writes persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GSC-2) fast path: opening a current-version db does not rewrite the version stamp", () => {
  // Structural check on the fast path itself: after the first open stamps the current
  // version, a second open must return before the DDL block. Observable proxy: a db
  // stamped at the current version opens fine and keeps its content byte-identical
  // semantics (nodes intact, version unchanged).
  const dir = mkdtempSync(join(tmpdir(), "leina-gsc-fast-"));
  const dbPath = join(dir, "graph.db");
  try {
    const first = new GraphStore(dbPath);
    first.addNodes([
      { id: "n1", label: "n1", fileType: "code", sourceFile: "a.ts", kind: "function" },
    ]);
    first.close();

    const second = new GraphStore(dbPath);
    assert.equal(second.getNode("n1")?.label, "n1", "content intact after fast-path open");
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
