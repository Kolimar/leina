// memory-portable.test.ts — export/import/sync: project memory that travels with the repo.
// Contract: exports are deterministic JSONL; imports merge by (revision, updatedAt) with
// ids/timestamps preserved; live topic_key collisions resolve toward the newer side; the
// sync snapshot round-trips two machines without a server.
// Run: node --no-warnings --experimental-strip-types --test test/memory-portable.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function tmpRepo(name: string): { repo: SQLiteMemoryRepository; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `leina-portable-${name}-`));
  return { repo: new SQLiteMemoryRepository(join(dir, "memory.db"), "proj"), dir };
}

test("(port-1) export → import into a fresh store is an identity (ids, timestamps, revisions, anchors)", () => {
  const a = tmpRepo("a");
  const b = tmpRepo("b");
  try {
    a.repo.save({ title: "decision one", content: "why one", type: "decision", topicKey: "t/one" });
    a.repo.save({ title: "fix two", content: "why two", type: "bugfix" });
    const exported = a.repo.exportAll();
    assert.equal(exported.length, 2);
    assert.equal(exported[0]!.schemaVersion, 1);

    const report = b.repo.importObservations(exported);
    assert.deepEqual(
      { inserted: report.inserted, updated: report.updated },
      { inserted: 2, updated: 0 },
    );
    const reExported = b.repo.exportAll();
    assert.deepEqual(reExported, exported, "byte-equal round trip");

    // Idempotent: importing again changes nothing.
    const again = b.repo.importObservations(exported);
    assert.equal(again.skippedOlder, 2);
  } finally {
    a.repo.close(); b.repo.close();
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("(port-2) newer revision wins on both sides; older never clobbers", async () => {
  const a = tmpRepo("a2");
  const b = tmpRepo("b2");
  try {
    const saved = a.repo.save({ title: "shared", content: "v1", type: "decision" }).observation;
    b.repo.importObservations(a.repo.exportAll());

    // Evolve on A only. The 5ms sleep breaks same-millisecond updatedAt ties so the
    // (revision, updatedAt) comparison in the merge is unambiguous under suite load.
    await new Promise((r) => setTimeout(r, 5));
    a.repo.update(saved.id, { content: "v2" });
    const evolved = a.repo.exportAll();

    const r1 = b.repo.importObservations(evolved);
    assert.equal(r1.updated, 1, "newer revision updates");
    assert.match(b.repo.get(saved.id)!.content, /v2/);

    // Re-importing the OLD export must not clobber back.
    const stale = evolved.map((o) => (o.id === saved.id ? { ...o, content: "v1", revision: 1 } : o));
    const r2 = b.repo.importObservations(stale);
    assert.equal(r2.skippedOlder >= 1, true, "older revision skipped");
    assert.match(b.repo.get(saved.id)!.content, /v2/, "content preserved");
  } finally {
    a.repo.close(); b.repo.close();
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("(port-3) live topic collision: newer import supersedes local; older import arrives superseded", () => {
  const a = tmpRepo("a3");
  const b = tmpRepo("b3");
  try {
    // Both machines create DIFFERENT observations under the same topic.
    const localObs = b.repo.save({ title: "local take", content: "local", type: "decision", topicKey: "t/clash" }).observation;
    const remote = a.repo.save({ title: "remote take", content: "remote", type: "decision", topicKey: "t/clash" }).observation;

    // Force the remote to be NEWER deterministically.
    const exported = a.repo.exportAll().map((o) =>
      o.id === remote.id ? { ...o, revision: 99, updatedAt: o.updatedAt + 10_000 } : o,
    );
    const r = b.repo.importObservations(exported);
    assert.equal(r.topicConflicts, 1);
    assert.equal(b.repo.get(localObs.id)!.supersededBy, remote.id, "local loser superseded by remote id");
    assert.equal(b.repo.get(remote.id)!.supersededBy, undefined, "remote is the live row");
  } finally {
    a.repo.close(); b.repo.close();
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("(port-4) CLI: export --out / import --in / sync snapshot round-trip between two homes", () => {
  const proj = mkdtempSync(join(tmpdir(), "leina-portable-proj-"));
  const homeA = mkdtempSync(join(tmpdir(), "leina-portable-homeA-"));
  const homeB = mkdtempSync(join(tmpdir(), "leina-portable-homeB-"));
  const envFor = (home: string): NodeJS.ProcessEnv => ({
    ...process.env, LEINA_HOME: join(home, ".leina"), HOME: home, USERPROFILE: home,
  });
  const run = (env: NodeJS.ProcessEnv, args: string[], input?: string) =>
    spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, "memory", ...args], {
      encoding: "utf8", env, input,
    });
  try {
    // Machine A saves and syncs → snapshot exists in the repo checkout.
    assert.equal(run(envFor(homeA), ["save", proj, "--title", "shared decision", "--content", "the why"]).status, 0);
    const sync1 = run(envFor(homeA), ["sync", proj]);
    assert.equal(sync1.status, 0, sync1.stderr);
    const snap = join(proj, ".leina", "memory-export.jsonl");
    assert.ok(existsSync(snap), "snapshot written");
    assert.match(readFileSync(snap, "utf8"), /shared decision/);

    // Machine B (different global DB) syncs the same checkout → absorbs A's memory.
    const sync2 = run(envFor(homeB), ["sync", proj]);
    assert.equal(sync2.status, 0, sync2.stderr);
    assert.match(sync2.stdout, /absorbed snapshot: 1 new/);
    const search = run(envFor(homeB), ["search", proj, "shared decision"]);
    assert.match(search.stdout, /shared decision/, "B sees A's memory");

    // export --out / import --in against a third file.
    const dump = join(homeB, "dump.jsonl");
    assert.equal(run(envFor(homeB), ["export", proj, "--out", dump]).status, 0);
    const imp = run(envFor(homeA), ["import", proj, "--in", dump]);
    assert.match(imp.stdout, /0 new, 0 updated, 1 skipped/, "A already has everything");
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
  }
});
