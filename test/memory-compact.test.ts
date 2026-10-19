// memory-compact.test.ts — `memory compact` GC: superseded snapshots, anchors cascade,
// FTS consistency across the VACUUM rowid renumbering, sessions purge, CLI surface.
// Run: node --no-warnings --experimental-strip-types --test test/memory-compact.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMemoryRepository as MemoryStore } from "../src/infrastructure/sqlite/memory-repository.ts";
import { compactMemory } from "../src/application/memory/compact.ts";
import { __setFts5ProbeForTests } from "../src/infrastructure/sqlite/schema.ts";
import type { ExportedObservation } from "../src/domain/memory/model.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function tmpStore(suffix: string): { store: MemoryStore; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `leina-compact-${suffix}-`));
  const path = join(dir, "memory.db");
  const store = new MemoryStore(path, "test-project");
  return { store, path, dir };
}

// Raw row counts straight from the file — the assertions must not trust the API under test.
function counts(path: string): { live: number; superseded: number; anchors: number; sessions: number; fts: number | null } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const one = (sql: string): number =>
      (db.prepare(sql).get() as unknown as { n: number }).n;
    const hasFts = db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='obs_fts'")
      .get() !== undefined;
    return {
      live: one("SELECT COUNT(*) n FROM observations WHERE superseded_by IS NULL"),
      superseded: one("SELECT COUNT(*) n FROM observations WHERE superseded_by IS NOT NULL"),
      anchors: one("SELECT COUNT(*) n FROM memory_anchors"),
      sessions: one("SELECT COUNT(*) n FROM sessions"),
      fts: hasFts ? one("SELECT COUNT(*) n FROM obs_fts") : null,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// GC of superseded snapshots
// ---------------------------------------------------------------------------

test("(compact-1) removes all superseded snapshots, preserves the live row per topic", () => {
  const { store, path, dir } = tmpStore("basic");
  try {
    for (let i = 1; i <= 4; i++) {
      store.save({ title: `Rev ${i}`, content: `content v${i}`, type: "decision", topicKey: "auth/jwt" });
    }
    const liveBefore = store.search("content", { limit: 10 });
    assert.equal(counts(path).superseded, 3, "3 snapshots before compact");

    const report = store.compact();
    assert.equal(report.supersededRemoved, 3, "reported count matches the snapshots");
    assert.equal(report.dryRun, false);

    const after = counts(path);
    assert.equal(after.superseded, 0, "all snapshots gone");
    assert.equal(after.live, 1, "live row preserved");
    const live = store.search("content", { limit: 10 });
    assert.equal(live.length, 1);
    assert.equal(live[0]!.id, liveBefore[0]!.id, "live id stable across compact");
    const obs = store.get(live[0]!.id);
    assert.equal(obs?.revision, 4, "live row is the latest revision");
    assert.equal(obs?.title, "Rev 4");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(compact-2) keepPerTopic retains the N newest snapshots per topic", () => {
  const { store, path, dir } = tmpStore("keep");
  try {
    for (let i = 1; i <= 5; i++) {
      store.save({ title: `Rev ${i}`, content: `v${i}`, type: "manual", topicKey: "t/one" });
    }
    for (let i = 1; i <= 3; i++) {
      store.save({ title: `Other ${i}`, content: `o${i}`, type: "manual", topicKey: "t/two" });
    }
    // t/one: 4 snapshots (rev 1-4) + live rev 5; t/two: 2 snapshots + live rev 3.
    const report = store.compact({ keepPerTopic: 2 });
    assert.equal(report.supersededRemoved, 2, "only t/one exceeds keep=2 (4-2=2 removed)");

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const revs = (db
        .prepare(
          `SELECT topic_key, revision FROM observations
            WHERE superseded_by IS NOT NULL ORDER BY topic_key, revision`,
        )
        .all() as unknown as { topic_key: string; revision: number }[])
        .map((r) => `${r.topic_key}:${r.revision}`);
      assert.deepEqual(
        revs,
        ["t/one:3", "t/one:4", "t/two:1", "t/two:2"],
        "the two NEWEST snapshots of each topic survive",
      );
    } finally {
      db.close();
    }
    assert.equal(counts(path).live, 2, "both live rows intact");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(compact-3) idempotent: second run removes nothing", () => {
  const { store, dir } = tmpStore("idem");
  try {
    for (let i = 1; i <= 3; i++) {
      store.save({ title: `R${i}`, content: `c${i}`, type: "manual", topicKey: "x/y" });
    }
    const first = store.compact();
    assert.equal(first.supersededRemoved, 2);
    const second = store.compact();
    assert.equal(second.supersededRemoved, 0, "nothing left to remove");
    assert.equal(second.anchorsRemoved, 0);
    assert.equal(second.sessionsRemoved, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(compact-4) dryRun reports counts but writes nothing and skips VACUUM", () => {
  const { store, path, dir } = tmpStore("dry");
  try {
    for (let i = 1; i <= 4; i++) {
      store.save({ title: `R${i}`, content: `c${i}`, type: "manual", topicKey: "d/t" });
    }
    const report = store.compact({ dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.supersededRemoved, 3, "dry-run reports what WOULD be removed");
    assert.equal(report.dbBytesAfter, report.dbBytesBefore, "no size change on dry-run");
    assert.equal(counts(path).superseded, 3, "snapshots untouched after dry-run");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Anchors cascade
// ---------------------------------------------------------------------------

test("(compact-5) anchors of deleted snapshots are cascade-deleted; live anchors survive", () => {
  const { store, path, dir } = tmpStore("anchors");
  try {
    // Live observation with an (unresolved) anchor — must survive.
    store.save({ title: "Live", content: "live content", type: "manual", topicKey: "a/live", anchors: ["keepMe"] });
    // A superseded snapshot WITH anchors can only enter via import/merge (the upsert
    // path keeps anchors on the live id) — import one verbatim.
    const snap: ExportedObservation = {
      schemaVersion: 1,
      id: "test-project:manual:old:1:snap",
      projectKey: "test-project",
      scope: "project",
      type: "manual",
      title: "Old snap",
      content: "old",
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      supersededBy: "test-project:whatever",
      anchors: [
        { nodeId: "n1", role: "about", createdAt: 1 },
        { nodeId: "n2", role: "about", createdAt: 1 },
      ],
    };
    store.importObservations([snap]);
    assert.equal(counts(path).anchors, 3, "1 live + 2 snapshot anchors before");

    const report = store.compact();
    assert.equal(report.supersededRemoved, 1);
    assert.equal(report.anchorsRemoved, 2, "both snapshot anchors cascade-deleted");
    const after = counts(path);
    assert.equal(after.anchors, 1, "live anchor untouched");
    assert.equal(after.superseded, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FTS consistency across VACUUM (rowid renumbering)
// ---------------------------------------------------------------------------

test("(compact-6) search stays correct after VACUUM renumbers rowids", () => {
  const { store, path, dir } = tmpStore("fts");
  try {
    // Layout designed to force renumbering: topic A's snapshots occupy rowids BETWEEN
    // A's live row and B's live row, so deleting them + VACUUM shifts B's rowid.
    store.save({ title: "Alpha", content: "alpha anchor point", type: "manual", topicKey: "f/a" });
    store.save({ title: "Alpha v2", content: "alpha evolved once", type: "manual", topicKey: "f/a" });
    store.save({ title: "Alpha v3", content: "alpha evolved twice", type: "manual", topicKey: "f/a" });
    const saved = store.save({ title: "Zebra topic", content: "zebra migration notes", type: "manual", topicKey: "f/z" });

    const report = store.compact();
    assert.equal(report.supersededRemoved, 2);

    // The rowid-JOINed search must still resolve the RIGHT rows after renumbering.
    const zebra = store.search("zebra", { limit: 5 });
    assert.equal(zebra.length, 1, "zebra found after compact");
    assert.equal(zebra[0]!.id, saved.observation.id, "search maps to the correct id");
    assert.equal(zebra[0]!.title, "Zebra topic", "search maps to the correct title");

    const alpha = store.search("alpha", { limit: 5 });
    assert.equal(alpha.length, 1, "only the live alpha revision is searchable");
    assert.equal(alpha[0]!.title, "Alpha v3");

    // FTS index cardinality equals live rows (only meaningful when FTS5 exists).
    if (!store.usingLike) {
      const after = counts(path);
      assert.equal(after.fts, after.live, "obs_fts holds exactly the live rows");
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sessions purge
// ---------------------------------------------------------------------------

test("(compact-7) sessions untouched by default; purged only via sessionsOlderThanDays", () => {
  const { store, path, dir } = tmpStore("sessions");
  try {
    store.startSession("work session");
    const obs = store.save({ title: "In session", content: "made during session", type: "manual" });
    assert.ok(obs.observation.sessionId, "observation linked to the session");
    store.saveSession("did things"); // closes it (ended_at = now)

    // Default: sessions never touched.
    const r1 = store.compact();
    assert.equal(r1.sessionsRemoved, 0);
    assert.equal(counts(path).sessions, 1, "session survives a plain compact");

    // Cutoff in the future (fake now = +40 days) but window 60 days → survives.
    const fortyDays = 40 * 86_400_000;
    const r2 = store.compact({ sessionsOlderThanDays: 60, now: Date.now() + fortyDays });
    assert.equal(r2.sessionsRemoved, 0, "younger than the window — kept");

    // Window 30 days with fake now = +40 days → purged, reference severed.
    const r3 = store.compact({ sessionsOlderThanDays: 30, now: Date.now() + fortyDays });
    assert.equal(r3.sessionsRemoved, 1, "idle session purged");
    assert.equal(counts(path).sessions, 0);
    const reread = store.get(obs.observation.id);
    assert.ok(reread, "observation itself survives the session purge");
    assert.equal(reread?.sessionId, undefined, "dangling session reference severed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Project isolation + disk reclaim
// ---------------------------------------------------------------------------

test("(compact-8) only the repo's own project is compacted; VACUUM shrinks the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-compact-iso-"));
  const path = join(dir, "memory.db");
  try {
    const other = new MemoryStore(path, "other-project");
    for (let i = 1; i <= 3; i++) {
      other.save({ title: `O${i}`, content: `oc${i}`, type: "manual", topicKey: "o/t" });
    }
    other.close();

    const mine = new MemoryStore(path, "my-project");
    const chunk = "x".repeat(2048);
    for (let i = 1; i <= 120; i++) {
      mine.save({ title: `M${i}`, content: `${chunk} ${i}`, type: "manual", topicKey: "m/t" });
    }
    const before = counts(path);
    assert.equal(before.superseded, 2 + 119, "both projects piled up snapshots");

    const report = mine.compact();
    mine.close();
    assert.equal(report.supersededRemoved, 119, "only my-project's snapshots removed");
    const after = counts(path);
    assert.equal(after.superseded, 2, "other-project's snapshots untouched");
    assert.ok(
      report.dbBytesAfter < report.dbBytesBefore,
      `VACUUM reclaimed space (${report.dbBytesBefore} -> ${report.dbBytesAfter})`,
    );

    // The other project still searches fine after MY vacuum+reindex.
    const otherAgain = new MemoryStore(path, "other-project");
    const hits = otherAgain.search("oc3", { limit: 5 });
    otherAgain.close();
    assert.equal(hits.length, 1, "other project's live row still searchable");
    assert.equal(hits[0]!.title, "O3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Use-case validation
// ---------------------------------------------------------------------------

test("(compact-9) compactMemory validates options and capability", () => {
  const { store, dir } = tmpStore("usecase");
  try {
    assert.throws(() => compactMemory({}), /does not support compact/);
    assert.throws(() => compactMemory(store, { keepPerTopic: -1 }), /non-negative integer/);
    assert.throws(() => compactMemory(store, { keepPerTopic: 1.5 }), /non-negative integer/);
    assert.throws(() => compactMemory(store, { sessionsOlderThanDays: 0 }), /positive number of days/);
    const report = compactMemory(store, {});
    assert.equal(report.supersededRemoved, 0, "empty project compacts to zeros");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// LIKE mode (Node builds without FTS5)
// ---------------------------------------------------------------------------

test("(compact-11) LIKE mode: compact works with no obs_fts to rebuild", () => {
  __setFts5ProbeForTests(() => false);
  const dir = mkdtempSync(join(tmpdir(), "leina-compact-like-"));
  const path = join(dir, "memory.db");
  try {
    const store = new MemoryStore(path, "test-project");
    assert.equal(store.usingLike, true, "seam forced LIKE mode");
    for (let i = 1; i <= 3; i++) {
      store.save({ title: `L${i}`, content: `like body ${i}`, type: "manual", topicKey: "l/t" });
    }
    const report = store.compact();
    assert.equal(report.supersededRemoved, 2);
    const hits = store.search("like body", { limit: 5 });
    assert.equal(hits.length, 1, "LIKE search still finds the live row after compact");
    assert.equal(hits[0]!.title, "L3");
    store.close();
    assert.equal(counts(path).fts, null, "no obs_fts table in LIKE mode");
  } finally {
    __setFts5ProbeForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

function runCli(args: string[], env: NodeJS.ProcessEnv): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", env },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

test("(compact-10) CLI: memory compact reports removals and sizes; bad --keep fails", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-compact-home-"));
  const repoDir = mkdtempSync(join(tmpdir(), "leina-compact-cli-"));
  try {
    const env = { ...process.env, LEINA_HOME: home };
    // Seed 3 revisions of one topic through the real CLI path.
    for (let i = 1; i <= 3; i++) {
      const s = runCli(
        ["memory", "save", repoDir, "--title", `T${i}`, "--content", `body ${i}`, "--topic", "cli/topic"],
        env,
      );
      assert.equal(s.code, 0, `save ${i} ok. stderr: ${s.stderr}`);
    }

    const dry = runCli(["memory", "compact", repoDir, "--dry-run"], env);
    assert.equal(dry.code, 0, `dry-run exit 0. stderr: ${dry.stderr}`);
    assert.match(dry.stdout, /\[dry-run\] would remove 2 superseded snapshot\(s\)/);

    const real = runCli(["memory", "compact", repoDir], env);
    assert.equal(real.code, 0, `compact exit 0. stderr: ${real.stderr}`);
    assert.match(real.stdout, /removed 2 superseded snapshot\(s\)/);
    assert.match(real.stdout, /db size: .+ -> .+/);

    const again = runCli(["memory", "compact", repoDir], env);
    assert.match(again.stdout, /removed 0 superseded snapshot\(s\)/, "idempotent via CLI too");

    const bad = runCli(["memory", "compact", repoDir, "--keep", "nope"], env);
    assert.equal(bad.code, 1, "invalid --keep exits non-zero");
    assert.match(bad.stderr, /--keep must be a non-negative integer/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});
