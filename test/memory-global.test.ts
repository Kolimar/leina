// memory-global.test.ts — integration tests for always-on global memory.
// Verifies that memory commands work in repos that have never been init'd, that the DB
// lands in the global home (honoring LEINA_HOME), and that observations are scoped
// by the derived project key (cross-project isolation).
//
// Run: node --no-warnings --experimental-strip-types --test test/memory-global.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): RunResult {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    {
      encoding: "utf8",
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? 1,
  };
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "leina-global-home-"));
}

function tmpGitRepo(remote?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "leina-global-repo-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  if (remote) {
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// SC-01a — default global path
// ---------------------------------------------------------------------------

test("(SC-01a) memory save goes to global DB, no memory.db inside repo", () => {
  const home = tmpHome();
  const repo = tmpGitRepo("https://github.com/org/my-project.git");
  try {
    const env = { ...process.env, LEINA_HOME: home };
    const result = runCli(
      ["memory", "save", repo, "--title", "Test save", "--content", "Hello world"],
      { env },
    );
    assert.equal(result.code, 0, `exit 0. stderr: ${result.stderr}`);
    // Global DB exists
    assert.ok(existsSync(join(home, "memory.db")), "global memory.db created");
    // No per-repo memory.db
    assert.ok(!existsSync(join(repo, ".leina", "memory.db")), "no per-repo memory.db");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-01b — LEINA_HOME env override
// ---------------------------------------------------------------------------

test("(SC-01b) LEINA_HOME env override — DB at custom path", () => {
  const customHome = tmpHome();
  const repo = tmpGitRepo("https://github.com/org/env-test.git");
  try {
    const env = { ...process.env, LEINA_HOME: customHome };
    const result = runCli(
      ["memory", "save", repo, "--title", "Env test", "--content", "Custom home"],
      { env },
    );
    assert.equal(result.code, 0, `exit 0. stderr: ${result.stderr}`);
    assert.ok(existsSync(join(customHome, "memory.db")), "DB at custom home");
  } finally {
    rmSync(customHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-02a — fresh repo, never inited → memory save works
// ---------------------------------------------------------------------------

test("(SC-02a) fresh repo never inited → memory save exits 0, no .leina/memory.db in repo", () => {
  const home = tmpHome();
  const repo = tmpGitRepo("https://github.com/org/fresh-repo.git");
  try {
    // Confirm no .leina/ in the repo (never inited)
    assert.ok(!existsSync(join(repo, ".leina")), "no .leina/ before save");
    const env = { ...process.env, LEINA_HOME: home };
    const result = runCli(
      ["memory", "save", repo, "--title", "Decision", "--content", "We chose X"],
      { env },
    );
    assert.equal(result.code, 0, `exit 0. stderr: ${result.stderr}`);
    // No per-repo memory.db
    assert.ok(!existsSync(join(repo, ".leina", "memory.db")), "no per-repo memory.db");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-02b — memory context in fresh repo → exits 0
// ---------------------------------------------------------------------------

test("(SC-02b) memory context in fresh repo → exits 0", () => {
  const home = tmpHome();
  const repo = tmpGitRepo("https://github.com/org/ctx-repo.git");
  try {
    const env = { ...process.env, LEINA_HOME: home };
    const result = runCli(["memory", "context", repo], { env });
    assert.equal(result.code, 0, `exit 0. stderr: ${result.stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-03a — cross-project isolation
// ---------------------------------------------------------------------------

test("(SC-03a) two repos with different keys — search is scoped to calling repo", () => {
  const home = tmpHome();
  const repoAlpha = tmpGitRepo("https://github.com/org/alpha.git");
  const repoBeta = tmpGitRepo("https://github.com/org/beta.git");
  try {
    const env = { ...process.env, LEINA_HOME: home };

    // Save to alpha
    const r1 = runCli(
      ["memory", "save", repoAlpha, "--title", "Alpha note", "--content", "alpha content only"],
      { env },
    );
    assert.equal(r1.code, 0);

    // Save to beta
    const r2 = runCli(
      ["memory", "save", repoBeta, "--title", "Beta note", "--content", "beta content only"],
      { env },
    );
    assert.equal(r2.code, 0);

    // Search in alpha — should only see alpha note
    const searchAlpha = runCli(["memory", "search", repoAlpha, "content"], { env });
    assert.equal(searchAlpha.code, 0);
    assert.ok(searchAlpha.stdout.includes("Alpha note"), "alpha search sees alpha");
    assert.ok(!searchAlpha.stdout.includes("Beta note"), "alpha search does not see beta");

    // Search in beta — should only see beta note
    const searchBeta = runCli(["memory", "search", repoBeta, "content"], { env });
    assert.equal(searchBeta.code, 0);
    assert.ok(searchBeta.stdout.includes("Beta note"), "beta search sees beta");
    assert.ok(!searchBeta.stdout.includes("Alpha note"), "beta search does not see alpha");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoAlpha, { recursive: true, force: true });
    rmSync(repoBeta, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Plain dir (no git) — falls back to dir-basename key
// ---------------------------------------------------------------------------

test("plain dir (no git) → memory save works via dir-basename key", () => {
  const home = tmpHome();
  const plainDir = mkdtempSync(join(tmpdir(), "leina-plain-"));
  try {
    const env = { ...process.env, LEINA_HOME: home };
    const result = runCli(
      ["memory", "save", plainDir, "--title", "Plain dir save", "--content", "works without git"],
      { env },
    );
    assert.equal(result.code, 0, `exit 0. stderr: ${result.stderr}`);
    assert.ok(existsSync(join(home, "memory.db")), "global DB created for plain dir");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  }
});
