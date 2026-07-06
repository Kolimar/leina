// memory-manage-cli.test.ts — CLI tests for memory current-project, merge-projects, migrate
// Run: node --no-warnings --experimental-strip-types --test test/memory-manage-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeId } from "../src/domain/shared/id.ts";
import { deriveProjectKey, normalizeProjectKey } from "../src/application/project/detect-key.ts";
import { SQLiteMemoryRepository as MemoryStore } from "../src/infrastructure/sqlite/memory-repository.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): RunResult {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", env: opts.env ?? process.env },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "leina-mmcli-home-"));
}

function tmpGitRepo(remote?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "leina-mmcli-repo-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore" });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return dir;
}

// ---------------------------------------------------------------------------
// memory current-project
// ---------------------------------------------------------------------------

test("(WU-07a) current-project: plain dir prints dir-basename key and method", () => {
  const home = tmpHome();
  const dir = mkdtempSync(join(tmpdir(), "leina-mmcli-plain-"));
  try {
    const env = { ...process.env, LEINA_HOME: home };
    const r = runCli(["memory", "current-project", dir], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /project_key:/);
    assert.match(r.stdout, /method:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(WU-07b) current-project: git repo with remote prints git-remote key", () => {
  const home = tmpHome();
  const dir = tmpGitRepo("https://github.com/org/my-service.git");
  try {
    const env = { ...process.env, LEINA_HOME: home };
    const r = runCli(["memory", "current-project", dir], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /project_key: my-service/);
    assert.match(r.stdout, /method: git-remote/);
    assert.match(r.stdout, /raw_name: my-service/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(WU-07c) current-project: config-lock wins", () => {
  const home = tmpHome();
  const dir = mkdtempSync(join(tmpdir(), "leina-mmcli-locked-"));
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(
      join(dir, ".leina", "config.json"),
      JSON.stringify({ project_name: "locked-service" }),
    );
    const env = { ...process.env, LEINA_HOME: home };
    const r = runCli(["memory", "current-project", dir], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /project_key: locked-service/);
    assert.match(r.stdout, /method: config-lock/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// orphan-key hint — memories stored under a key this repo no longer resolves to
// (e.g. a git remote added AFTER memories were saved under the dir-basename key)
// ---------------------------------------------------------------------------

test("(OK-1) current-project: hints when memories live under a discarded fallback key", () => {
  const home = tmpHome();
  const dir = tmpGitRepo("https://github.com/acme/renamed-svc.git");
  try {
    const env = { ...process.env, LEINA_HOME: home };
    // Simulate memories saved BEFORE the remote existed: stored under the
    // git-root/dir-basename key, which the remote now shadows.
    const oldKey = normalizeProjectKey(basename(dir));
    const store = new MemoryStore(join(home, "memory.db"), oldKey);
    store.save({ title: "Old1", content: "C1", type: "manual" });
    store.save({ title: "Old2", content: "C2", type: "manual" });
    store.close();

    const r = runCli(["memory", "current-project", dir], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /project_key: renamed-svc/);
    assert.match(r.stderr, /hint: project key 'renamed-svc' \(via git-remote\) has no memories, but 2 live under/);
    assert.match(r.stderr, new RegExp(`--from ${oldKey} --to renamed-svc`));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(OK-2) search with zero hits: emits the orphan-key hint on stderr", () => {
  const home = tmpHome();
  const dir = tmpGitRepo("https://github.com/acme/renamed-svc.git");
  try {
    const env = { ...process.env, LEINA_HOME: home };
    const oldKey = normalizeProjectKey(basename(dir));
    const store = new MemoryStore(join(home, "memory.db"), oldKey);
    store.save({ title: "Lost", content: "orphaned content", type: "manual" });
    store.close();

    const r = runCli(["memory", "search", dir, "orphaned"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /No results/);
    assert.match(r.stderr, /hint: project key 'renamed-svc'/);
    assert.match(r.stderr, /leina memory merge-projects/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(OK-3) no hint when the resolved key has live memories", () => {
  const home = tmpHome();
  const dir = tmpGitRepo("https://github.com/acme/renamed-svc.git");
  try {
    const env = { ...process.env, LEINA_HOME: home };
    // Both keys have rows — the resolved key wins, no hint.
    const globalPath = join(home, "memory.db");
    const oldStore = new MemoryStore(globalPath, normalizeProjectKey(basename(dir)));
    oldStore.save({ title: "Old", content: "C", type: "manual" });
    oldStore.close();
    const curStore = new MemoryStore(globalPath, "renamed-svc");
    curStore.save({ title: "Current", content: "C", type: "manual" });
    curStore.close();

    const r = runCli(["memory", "current-project", dir], { env });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /hint: project key/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// memory merge-projects
// ---------------------------------------------------------------------------

test("(WU-07d) merge-projects: moves rows from src to dst, exits 0", () => {
  const home = tmpHome();
  const dir = tmpGitRepo();
  try {
    const env = { ...process.env, LEINA_HOME: home };

    // Pre-populate src in global DB
    const globalPath = join(home, "memory.db");
    const src = new MemoryStore(globalPath, "src-key");
    src.save({ title: "T1", content: "C1", type: "manual" });
    src.save({ title: "T2", content: "C2", type: "manual" });
    src.close();

    const r = runCli(
      ["memory", "merge-projects", dir, "--from", "src-key", "--to", "dst-key"],
      { env },
    );
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /moved 2 row\(s\) from src-key => dst-key/);

    // Verify dst has the rows
    const verify = new MemoryStore(globalPath, "dst-key");
    const ctx = verify.recentContext({ limit: 10 });
    assert.equal(ctx.observations.length, 2, "dst now has 2 obs");
    verify.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(WU-07e) merge-projects --dry-run: prints moved count, DB unchanged", () => {
  const home = tmpHome();
  const dir = tmpGitRepo();
  try {
    const env = { ...process.env, LEINA_HOME: home };

    const globalPath = join(home, "memory.db");
    const src = new MemoryStore(globalPath, "from-dry");
    src.save({ title: "DryT", content: "DryC", type: "manual" });
    src.close();

    const r = runCli(
      ["memory", "merge-projects", dir, "--from", "from-dry", "--to", "to-dry", "--dry-run"],
      { env },
    );
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /\[dry-run\] would move 1 row\(s\)/);

    // DB unchanged
    const check = new MemoryStore(globalPath, "from-dry");
    const ctx = check.recentContext({ limit: 5 });
    assert.equal(ctx.observations.length, 1, "from-dry still has row after dry-run");
    check.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(WU-07f) merge-projects --from missing → exit 1", () => {
  const home = tmpHome();
  const dir = mkdtempSync(join(tmpdir(), "leina-mmcli-missing-"));
  try {
    const env = { ...process.env, LEINA_HOME: home };
    const r = runCli(["memory", "merge-projects", dir, "--to", "dst"], { env });
    assert.notEqual(r.code, 0, "should fail with no --from");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// memory migrate
// ---------------------------------------------------------------------------

test("(WU-07g) migrate: imports legacy per-repo memory.db into global, exits 0", () => {
  const home = tmpHome();
  const dir = tmpGitRepo("https://github.com/org/migrate-test.git");
  try {
    const env = { ...process.env, LEINA_HOME: home };

    // The migrate command derives fromKey as makeId(basename(dir)) — the OLD
    // underscore-form key that was used before FR-11 switched to hyphens.
    const fromKey = makeId(basename(dir));

    // Create legacy per-repo memory.db seeded under the ACTUAL old key.
    const legacyDir = join(dir, ".leina");
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, "memory.db");
    const legacy = new MemoryStore(legacyPath, fromKey);
    legacy.save({ title: "Old note", content: "Legacy content", type: "manual" });
    legacy.save({ title: "Old note 2", content: "Legacy content 2", type: "manual" });
    legacy.close();

    const r = runCli(["memory", "migrate", dir], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    // Output mentions moved counts
    assert.match(r.stdout, /migrated:/);
    assert.ok(existsSync(join(home, "memory.db")), "global DB created");

    // After migration, rows must be queryable under the NEW hyphen key (FR-20 remap).
    // deriveProjectKey(dir) returns "migrate-test" via git-remote detection.
    const newKey = deriveProjectKey(dir).key;
    assert.equal(newKey, "migrate-test", "new key should be hyphenated");
    const globalPath = join(home, "memory.db");
    const verify = new MemoryStore(globalPath, newKey);
    const ctx = verify.recentContext({ limit: 10 });
    verify.close();
    assert.ok(
      ctx.observations.length > 0,
      `global DB must have rows under new key "${newKey}" after migrate (got ${ctx.observations.length})`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(WU-07h) migrate: no legacy memory.db → friendly message, exit 0", () => {
  const home = tmpHome();
  const dir = mkdtempSync(join(tmpdir(), "leina-mmcli-nomigrate-"));
  try {
    const env = { ...process.env, LEINA_HOME: home };
    const r = runCli(["memory", "migrate", dir], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /nothing to migrate/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
