// workspace-detect.test.ts — unit tests for detectWorkspaceMode and findChildRepos
// Covers: SC-01/02/03/06/07 (mode detection), findChildRepos max advisory,
// and workspace.json exclude integration (SC-04/05).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectWorkspaceMode,
  findChildRepos,
} from "../src/application/project/detect-key.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ws-detect-"));
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
}

function makeChildRepo(parent: string, name: string): string {
  const dir = join(parent, name);
  initGitRepo(dir);
  return dir;
}

function writeWsJson(dir: string, content: object): void {
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(content), "utf8");
}

// ---------------------------------------------------------------------------
// SC-01: exactly 1 child repo → single
// ---------------------------------------------------------------------------

test("(SC-01) 1 child repo without workspace.json → single-repo mode", () => {
  const root = tmpDir();
  try {
    makeChildRepo(root, "my-service");
    const det = detectWorkspaceMode(root, {});
    assert.equal(det.mode, "single");
    assert.deepEqual(det.members, []);
    assert.equal(det.source, "git-root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-02: ≥2 child repos → workspace
// ---------------------------------------------------------------------------

test("(SC-02) 3 child repos without workspace.json → workspace mode (child-git-auto)", () => {
  const root = tmpDir();
  try {
    makeChildRepo(root, "service-a");
    makeChildRepo(root, "service-b");
    makeChildRepo(root, "service-c");
    const det = detectWorkspaceMode(root, {});
    assert.equal(det.mode, "workspace");
    assert.equal(det.source, "child-git-auto");
    assert.equal(det.members.length, 3);
    const names = det.members.map((m) => m.dir.split("/").pop());
    assert.ok(names.includes("service-a"));
    assert.ok(names.includes("service-b"));
    assert.ok(names.includes("service-c"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-03: .git in root → single
// ---------------------------------------------------------------------------

test("(SC-03) .git in root (monorepo) → single-repo mode", () => {
  const root = tmpDir();
  try {
    initGitRepo(root); // .git at root
    mkdirSync(join(root, "packages/lib-a"), { recursive: true }); // no .git
    const det = detectWorkspaceMode(root, {});
    assert.equal(det.mode, "single");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-04: workspace.json {} forces workspace mode even with only 1 child repo
// ---------------------------------------------------------------------------

test("(SC-04) workspace.json {} with 1 child repo → workspace mode (workspace.json source)", () => {
  const root = tmpDir();
  try {
    makeChildRepo(root, "my-service");
    writeWsJson(root, {});
    const det = detectWorkspaceMode(root, {});
    assert.equal(det.mode, "workspace");
    assert.equal(det.source, "workspace.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-05: workspace.json exclude
// ---------------------------------------------------------------------------

test("(SC-05) workspace.json exclude omits the listed repo", () => {
  const root = tmpDir();
  try {
    makeChildRepo(root, "service-a");
    makeChildRepo(root, "service-b");
    makeChildRepo(root, "legacy-repo");
    writeWsJson(root, { exclude: ["legacy-repo"] });
    const det = detectWorkspaceMode(root, {});
    assert.equal(det.mode, "workspace");
    assert.equal(det.members.length, 2);
    const names = det.members.map((m) => m.dir.split("/").pop());
    assert.ok(!names.includes("legacy-repo"), "legacy-repo must be excluded");
    assert.ok(names.includes("service-a"));
    assert.ok(names.includes("service-b"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-06: --single overrides workspace.json
// ---------------------------------------------------------------------------

test("(SC-06) --single flag overrides workspace.json → single mode", () => {
  const root = tmpDir();
  try {
    makeChildRepo(root, "service-a");
    makeChildRepo(root, "service-b");
    writeWsJson(root, {});
    const det = detectWorkspaceMode(root, { single: true });
    assert.equal(det.mode, "single");
    assert.equal(det.source, "flag");
    assert.deepEqual(det.members, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-07: --workspace forces workspace with 1 child repo
// ---------------------------------------------------------------------------

test("(SC-07) --workspace flag with 1 child repo → workspace mode", () => {
  const root = tmpDir();
  try {
    makeChildRepo(root, "my-service");
    const det = detectWorkspaceMode(root, { workspace: true });
    assert.equal(det.mode, "workspace");
    assert.equal(det.source, "flag");
    assert.equal(det.members.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// findChildRepos — max advisory
// ---------------------------------------------------------------------------

test("(findChildRepos-max) advisory emitted and list truncated when repos > max", () => {
  const root = tmpDir();
  const stderrMsgs: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as NodeJS.WriteStream & { write: typeof process.stderr.write }).write =
    (msg: Parameters<typeof process.stderr.write>[0]) => { stderrMsgs.push(String(msg)); return true; };
  try {
    // Create 5 child repos, use max=3
    for (let i = 0; i < 5; i++) makeChildRepo(root, `repo-${i}`);
    const found = findChildRepos(root, 3);
    assert.equal(found.length, 3, "should be truncated to max=3");
    assert.ok(stderrMsgs.some((m) => m.includes("truncating")), "advisory must mention truncating");
  } finally {
    (process.stderr as NodeJS.WriteStream & { write: typeof process.stderr.write }).write = origWrite;
    rmSync(root, { recursive: true, force: true });
  }
});

test("(findChildRepos-no-trunc) no advisory when repos <= max", () => {
  const root = tmpDir();
  const stderrMsgs: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as NodeJS.WriteStream & { write: typeof process.stderr.write }).write =
    (msg: Parameters<typeof process.stderr.write>[0]) => { stderrMsgs.push(String(msg)); return true; };
  try {
    makeChildRepo(root, "repo-a");
    makeChildRepo(root, "repo-b");
    const found = findChildRepos(root, 10);
    assert.equal(found.length, 2);
    assert.ok(!stderrMsgs.some((m) => m.includes("truncating")), "no truncation advisory expected");
  } finally {
    (process.stderr as NodeJS.WriteStream & { write: typeof process.stderr.write }).write = origWrite;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// workspace members have repoKey populated
// ---------------------------------------------------------------------------

test("(ws-members-key) each member has a non-empty repoKey", () => {
  const root = tmpDir();
  try {
    makeChildRepo(root, "payments-svc");
    makeChildRepo(root, "auth-svc");
    const det = detectWorkspaceMode(root, {});
    assert.equal(det.mode, "workspace");
    for (const m of det.members) {
      assert.ok(m.repoKey.length > 0, `member ${m.dir} must have a non-empty repoKey`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
