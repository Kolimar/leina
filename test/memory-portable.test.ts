// memory-portable.test.ts — export/import/sync: project memory that travels with the repo.
// Contract: exports are deterministic JSONL; imports merge by (revision, updatedAt) with
// ids/timestamps preserved; live topic_key collisions resolve toward the newer side; the
// sync snapshot round-trips two machines without a server.
// Run: node --no-warnings --experimental-strip-types --test test/memory-portable.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";
import {
  MAX_IMPORT_CONTENT_CHARS,
  MAX_IMPORT_TITLE_CHARS,
  parseExportedObservation,
} from "../src/domain/memory/portable.ts";

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

// ---------------------------------------------------------------------------
// Untrusted snapshots: a `.leina/memory-export.jsonl` committed in a forked or hostile repo
// is input from a stranger. It must stay confined to the importing project and be validated.
// ---------------------------------------------------------------------------

test("(port-5) import never rewrites another project's observation that shares the id", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-portable-foreign-"));
  const p = new SQLiteMemoryRepository(join(dir, "memory.db"), "p");
  const q = new SQLiteMemoryRepository(join(dir, "memory.db"), "q");
  try {
    const victim = p.save({ title: "Deploy policy", content: "run migrations first", type: "decision", topicKey: "decision/deploy" }).observation;
    // Hostile export shipped by repo Q: P's id, a bumped revision and attacker content.
    const hostile = p.exportAll().map((o) => ({ ...o, content: "skip migrations", revision: 99 }));

    const r = q.importObservations(hostile);
    assert.equal(r.skippedForeign, 1, "the foreign id is skipped and reported");
    assert.deepEqual({ inserted: r.inserted, updated: r.updated }, { inserted: 0, updated: 0 });

    const after = p.exportAll();
    assert.equal(after.length, 1);
    assert.equal(after[0]!.content, "run migrations first", "P's content untouched");
    assert.equal(after[0]!.revision, victim.revision, "P's revision untouched");
    assert.equal(q.exportAll().length, 0, "nothing landed in Q either");
  } finally {
    p.close(); q.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(port-6) import clamps future timestamps so an entry cannot pin itself on top forever", () => {
  const a = tmpRepo("a6");
  const b = tmpRepo("b6");
  try {
    a.repo.save({ title: "pinned", content: "c", type: "decision", anchors: ["Sym"] });
    const year2286 = 9_999_999_999_999;
    const tampered = a.repo.exportAll().map((o) => ({
      ...o,
      createdAt: year2286,
      updatedAt: year2286,
      anchors: o.anchors.map((x) => ({ ...x, createdAt: year2286 })),
    }));
    const before = Date.now();
    b.repo.importObservations(tampered);
    const [stored] = b.repo.exportAll();
    const after = Date.now();
    assert.ok(stored!.updatedAt >= before && stored!.updatedAt <= after, `updatedAt clamped to now (got ${stored!.updatedAt})`);
    assert.ok(stored!.createdAt <= stored!.updatedAt, "createdAt never after updatedAt");
    assert.ok(stored!.anchors[0]!.createdAt <= after, "anchor createdAt clamped too");
  } finally {
    a.repo.close(); b.repo.close();
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("(port-7) parseExportedObservation accepts a real export line and rejects malformed ones", () => {
  const a = tmpRepo("a7");
  try {
    a.repo.save({ title: "t", content: "c", type: "decision", topicKey: "t/k" });
    const good = JSON.parse(JSON.stringify(a.repo.exportAll()[0])) as Record<string, unknown>;
    const ok = parseExportedObservation(good);
    assert.equal(ok.ok, true, ok.ok ? "" : ok.error);

    const bad: [string, Record<string, unknown>, RegExp][] = [
      ["unknown scope", { ...good, scope: "everything" }, /scope/],
      ["unknown type", { ...good, type: "exploit" }, /type/],
      ["non-string supersededBy", { ...good, supersededBy: 42 }, /supersededBy/],
      ["self-supersede", { ...good, supersededBy: good.id }, /supersededBy/],
      ["oversized title", { ...good, title: "x".repeat(MAX_IMPORT_TITLE_CHARS + 1) }, /title/],
      ["oversized content", { ...good, content: "x".repeat(MAX_IMPORT_CONTENT_CHARS + 1) }, /content/],
      ["non-numeric updatedAt", { ...good, updatedAt: "tomorrow" }, /updatedAt/],
      ["negative createdAt", { ...good, createdAt: -1 }, /createdAt/],
      ["fractional revision", { ...good, revision: 1.5 }, /revision/],
      ["unsupported schemaVersion", { ...good, schemaVersion: 2 }, /schemaVersion/],
      ["anchor without nodeId", { ...good, anchors: [{ role: "about", createdAt: 1 }] }, /anchors\[0\]/],
    ];
    for (const [label, raw, re] of bad) {
      const r = parseExportedObservation(raw);
      assert.equal(r.ok, false, `${label} must be rejected`);
      if (!r.ok) assert.match(r.error, re, label);
    }
  } finally {
    a.repo.close();
    rmSync(a.dir, { recursive: true, force: true });
  }
});

test("(port-8) CLI: sync of a hostile snapshot leaves the other project's memory intact; import rejects invalid lines", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-portable-hostile-"));
  const projP = join(home, "P");
  const projQ = join(home, "Q");
  mkdirSync(join(projQ, ".leina"), { recursive: true });
  mkdirSync(projP, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, LEINA_HOME: join(home, ".leina"), HOME: home, USERPROFILE: home };
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, "memory", ...args], {
      encoding: "utf8", env,
    });
  try {
    assert.equal(run(["save", projP, "--title", "Deploy policy", "--content", "run migrations first"]).status, 0);
    const exported = run(["export", projP]);
    const hostile = exported.stdout.trim().split("\n").map((l) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      return JSON.stringify({ ...o, content: "skip migrations", revision: 99 });
    });
    writeFileSync(join(projQ, ".leina", "memory-export.jsonl"), `${hostile.join("\n")}\n`);

    const sync = run(["sync", projQ]);
    assert.equal(sync.status, 0, sync.stderr);
    assert.match(sync.stdout, /1 skipped \(id belongs to another project\)/);
    const p = run(["export", projP]);
    assert.match(p.stdout, /run migrations first/, "P's memory is untouched");
    assert.doesNotMatch(p.stdout, /skip migrations/);

    const invalid = join(home, "invalid.jsonl");
    writeFileSync(invalid, `${hostile[0]!.replace(/"type":"[a-z]+"/, '"type":"exploit"')}\n`);
    const imp = run(["import", projQ, "--in", invalid]);
    assert.notEqual(imp.status, 0, "invalid entry fails the import");
    assert.match(imp.stderr, /line 1: .*type/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
