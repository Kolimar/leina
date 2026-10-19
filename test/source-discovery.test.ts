// source-discovery.test.ts — which files a graph is built from (application/graph/sources.ts).
//
// Discovery used to walk everything except a fixed ignore list: it indexed gitignored output
// (coverage/) and full checkouts under hidden dirs (.claude/worktrees/<name>/src/* — every
// symbol duplicated). Inside git it now asks `git ls-files` (tracked + untracked-not-ignored),
// outside git it walks; both skip hidden dirs (except CI config dirs) and nested repos.
// Run: node --no-warnings --experimental-strip-types --test test/source-discovery.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import {
  isResolutionConfig,
  listConfigFiles,
  listProjectFiles,
  listSourceFiles,
  withSourceListMemo,
} from "../src/application/graph/sources.ts";

// git reads the user's global excludes file through HOME; pin it to an empty sandbox so the
// developer's own ~/.config/git/ignore can never change what these tests see.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "leina-disc-home-"));
process.env.HOME = SANDBOX_HOME;
process.env.XDG_CONFIG_HOME = join(SANDBOX_HOME, ".config");
test.after(() => rmSync(SANDBOX_HOME, { recursive: true, force: true }));

function write(root: string, rel: string, content = "export const x = 1;\n"): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

function rels(root: string, files: string[]): string[] {
  return files.map((f) => relative(root, f).split(sep).join("/")).sort();
}

/** A layout exercising every discovery rule, shared by the git and the walk variants. */
function seedLayout(root: string): void {
  write(root, "src/app.ts");
  write(root, "src/util.py", "def f():\n    pass\n");
  write(root, ".github/workflows/ci.yml", "jobs:\n  build:\n    runs-on: x\n");
  write(root, ".devcontainer/docker-compose.yml", "services:\n  app:\n    image: x\n");
  write(root, ".claude/worktrees/agent-1/src/app.ts"); // agent checkout under a hidden dir
  write(root, ".idea/tool.js");
  write(root, "node_modules/dep/index.js");
  write(root, "node_modules/dep/package.json", "{}\n");
  write(root, "dist/bundle.js");
  write(root, "public/lib.min.js");
  write(root, "tsconfig.json", "{}\n");
  write(root, "tsconfig.build.json", "{}\n");
  write(root, "package.json", "{}\n");
  write(root, "packages/a/package.json", "{}\n");
  write(root, "packages/a/index.ts");
}

const EXPECTED_SOURCES = [
  ".devcontainer/docker-compose.yml",
  ".github/workflows/ci.yml",
  "packages/a/index.ts",
  "src/app.ts",
  "src/util.py",
];
const EXPECTED_CONFIGS = ["package.json", "packages/a/package.json", "tsconfig.build.json", "tsconfig.json"];

test("(disc-1) walk (no git): hidden dirs except CI config, ignore dirs and minified bundles are skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "leina-disc-walk-"));
  try {
    seedLayout(root);
    assert.deepEqual(rels(root, listSourceFiles(root)), EXPECTED_SOURCES);
    assert.deepEqual(rels(root, listConfigFiles(root)), EXPECTED_CONFIGS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(disc-2) walk (no git): a subdirectory with its own .git is another repo and is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "leina-disc-nested-"));
  try {
    write(root, "main.ts");
    write(root, "checkout/src/dup.ts");
    mkdirSync(join(root, "checkout", ".git")); // nested repository
    write(root, "wt/src/dup.ts");
    writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n"); // linked worktree
    assert.deepEqual(rels(root, listSourceFiles(root)), ["main.ts"]);
    // The root itself may be a repo — its own .git never hides it.
    mkdirSync(join(root, ".git"));
    assert.deepEqual(rels(root, listSourceFiles(root)), ["main.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(disc-3) git: .gitignore'd files are not sources; untracked-not-ignored ones are", () => {
  const root = mkdtempSync(join(tmpdir(), "leina-disc-git-"));
  try {
    git(root, "init", "-q");
    seedLayout(root);
    write(root, ".gitignore", "coverage/\ngenerated/\n");
    write(root, "coverage/lcov-report/prettify.js");
    write(root, "generated/client.ts");
    write(root, "src/tracked-then-deleted.ts");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    unlinkSync(join(root, "src", "tracked-then-deleted.ts")); // still in the index
    write(root, "src/new-untracked.ts");
    assert.deepEqual(rels(root, listSourceFiles(root)), [...EXPECTED_SOURCES, "src/new-untracked.ts"].sort());
    assert.deepEqual(rels(root, listConfigFiles(root)), EXPECTED_CONFIGS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(disc-4) git: nested repos and linked worktrees (even non-hidden ones) are never descended into", () => {
  const root = mkdtempSync(join(tmpdir(), "leina-disc-wt-"));
  try {
    git(root, "init", "-q");
    write(root, "src/app.ts");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    git(root, "worktree", "add", "-q", join(root, "worktrees", "feature"), "-b", "feature");
    git(root, "worktree", "add", "-q", join(root, ".claude", "worktrees", "agent-1"), "-b", "agent-1");
    mkdirSync(join(root, "vendored-repo"));
    git(join(root, "vendored-repo"), "init", "-q");
    write(root, "vendored-repo/lib.ts");
    assert.deepEqual(rels(root, listSourceFiles(root)), ["src/app.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(disc-5) git: a root that the enclosing repo ignores falls back to the walk", () => {
  const root = mkdtempSync(join(tmpdir(), "leina-disc-ignored-root-"));
  try {
    git(root, "init", "-q");
    write(root, ".gitignore", "scratch/\n");
    write(root, "scratch/tool.ts");
    assert.deepEqual(rels(join(root, "scratch"), listSourceFiles(join(root, "scratch"))), ["tool.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Windows without Developer Mode / admin cannot create symlinks: skip, don't fail.
const SYMLINKS_OK = (() => {
  const d = mkdtempSync(join(tmpdir(), "leina-disc-symprobe-"));
  try {
    writeFileSync(join(d, "t"), "");
    symlinkSync(join(d, "t"), join(d, "l"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();

test("(disc-6) symlinks are not sources in either mode (the walk never followed them)", { skip: !SYMLINKS_OK && "symlink privilege unavailable" }, () => {
  const root = mkdtempSync(join(tmpdir(), "leina-disc-link-"));
  const outside = mkdtempSync(join(tmpdir(), "leina-disc-outside-"));
  try {
    write(outside, "secret.ts");
    write(root, "app.ts");
    symlinkSync(join(outside, "secret.ts"), join(root, "linked.ts"));
    assert.deepEqual(rels(root, listSourceFiles(root)), ["app.ts"]);
    git(root, "init", "-q");
    git(root, "add", "-A");
    assert.deepEqual(rels(root, listSourceFiles(root)), ["app.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("(disc-7) one discovery pass per root inside a memo scope; copies never alias the memo", async () => {
  const root = mkdtempSync(join(tmpdir(), "leina-disc-memo-"));
  try {
    write(root, "a.ts");
    await withSourceListMemo(async () => {
      const first = listProjectFiles(root);
      first.sources.push("poison");
      write(root, "b.ts"); // not seen: the memo holds the operation's single listing
      assert.deepEqual(rels(root, listSourceFiles(root)), ["a.ts"]);
    });
    assert.deepEqual(rels(root, listSourceFiles(root)), ["a.ts", "b.ts"], "a new operation re-lists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(disc-8) isResolutionConfig matches tsconfig variants, jsconfig and package.json only", () => {
  for (const n of ["tsconfig.json", "tsconfig.base.json", "tsconfig-build.json", "jsconfig.json", "package.json"]) {
    assert.equal(isResolutionConfig(n), true, n);
  }
  for (const n of ["tsconfig.ts", "mytsconfig.json", "package-lock.json", "tsconfigs.json", "composer.json"]) {
    assert.equal(isResolutionConfig(n), false, n);
  }
});
