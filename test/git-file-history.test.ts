// git-file-history.test.ts — committed-version lookup by content hash
// (src/infrastructure/git/file-history.ts), used by `memory reanchor` upgrades.
// Run: node --no-warnings --experimental-strip-types --test test/git-file-history.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGitFileHistory } from "../src/infrastructure/git/file-history.ts";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function commit(dir: string, rel: string, content: string, msg: string): void {
  writeFileSync(join(dir, rel), content);
  git(dir, "add", rel);
  git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", msg);
}

test("(ghist-1) finds the committed version whose sha256 matches, from a subdirectory root too", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-ghist-"));
  try {
    git(dir, "init", "-q");
    mkdirSync(join(dir, "pkg"));
    commit(dir, "pkg/a.ts", "v1 ñ\n", "v1");
    commit(dir, "pkg/a.ts", "v2\n", "v2");
    commit(dir, "pkg/a.ts", "v3\n", "v3");

    const history = makeGitFileHistory(dir);
    assert.equal(history("pkg/a.ts", sha("v1 ñ\n")), "v1 ñ\n", "older version, non-ASCII content");
    assert.equal(history("pkg/a.ts", sha("v2\n")), "v2\n", "served from the per-path cache");
    assert.equal(history("pkg/a.ts", sha("never committed\n")), null);
    assert.equal(history("pkg/missing.ts", sha("v1\n")), null);

    // Paths are relative to the root it was made for, even below the repo toplevel.
    assert.equal(makeGitFileHistory(join(dir, "pkg"))("a.ts", sha("v2\n")), "v2\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ghist-2) outside a git repo every lookup is null (fail-soft)", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-ghist-"));
  try {
    writeFileSync(join(dir, "a.ts"), "x\n");
    assert.equal(makeGitFileHistory(dir)("a.ts", sha("x\n")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
