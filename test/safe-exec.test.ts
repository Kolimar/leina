// safe-exec.test.ts — unit tests for src/core/safe-exec.ts
// Run: node --no-warnings --experimental-strip-types --test test/safe-exec.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { SAFE_PATH, safeGitOutput } from "../src/infrastructure/install/safe-exec.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "safe-exec-"));
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

test("SAFE_PATH contains only fixed system directories (no cwd/relative entries)", () => {
  const entries = SAFE_PATH.split(delimiter);
  assert.ok(entries.length > 0, "SAFE_PATH must not be empty");
  for (const e of entries) {
    assert.notEqual(e, "", "no empty PATH entry (would mean cwd on POSIX)");
    assert.notEqual(e, ".", "no current-directory entry");
    // Every entry must be an absolute path (no relative/writable lookups).
    const absolute = e.startsWith("/") || /^[A-Za-z]:\\/.test(e);
    assert.ok(absolute, `PATH entry must be absolute: ${e}`);
  }
});

test("safeGitOutput returns trimmed stdout for a valid git command", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir);
    const head = safeGitOutput(["rev-parse", "HEAD"], dir);
    assert.ok(head, "expected a commit sha");
    assert.match(head, /^[0-9a-f]{40}$/, "40-char hex sha, trimmed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeGitOutput returns null on git failure (not a repo)", () => {
  const dir = tmpDir();
  try {
    const out = safeGitOutput(["rev-parse", "HEAD"], dir);
    assert.equal(out, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeGitOutput returns null for an unknown git subcommand", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir);
    const out = safeGitOutput(["this-is-not-a-git-command"], dir);
    assert.equal(out, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeGitOutput ignores a poisoned inherited PATH (uses SAFE_PATH)", () => {
  const dir = tmpDir();
  const prev = process.env.PATH;
  try {
    initGitRepo(dir);
    // Poison the inherited PATH to a writable, useless dir. safeGitOutput must
    // still find git via SAFE_PATH and succeed.
    process.env.PATH = dir;
    const head = safeGitOutput(["rev-parse", "HEAD"], dir);
    assert.ok(head, "git resolved via SAFE_PATH despite poisoned process PATH");
    assert.match(head, /^[0-9a-f]{40}$/);
  } finally {
    if (prev !== undefined) process.env.PATH = prev;
    else delete process.env.PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});
