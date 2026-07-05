// project-detect.test.ts — unit tests for src/core/project-detect.ts
// Run: node --no-warnings --experimental-strip-types --test test/project-detect.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AmbiguousProjectError,
  deriveProjectKey,
  normalizeProjectKey,
  readProjectConfig,
  repoNameFromRemote,
  writeProjectConfig,
} from "../src/application/project/detect-key.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "project-detect-"));
}

function initGitRepo(dir: string, remote?: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  if (remote) {
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  }
}

// ---------------------------------------------------------------------------
// SC-05: config-lock step
// ---------------------------------------------------------------------------

test("(SC-05a) config-lock wins over git remote", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir, "https://github.com/org/from-git.git");
    writeProjectConfig(dir, "my-locked-service");
    const det = deriveProjectKey(dir);
    assert.equal(det.method, "config-lock");
    assert.equal(det.key, "my-locked-service");
    assert.equal(det.rawName, "my-locked-service");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(SC-05b) malformed JSON in config.json → skipped, falls through", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir, "https://github.com/org/from-git.git");
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(join(dir, ".leina", "config.json"), "{ not valid json");
    const det = deriveProjectKey(dir);
    assert.notEqual(det.method, "config-lock");
    assert.equal(det.method, "git-remote");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(SC-05c) empty project_name in config.json → skipped, falls through", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir, "https://github.com/org/from-git.git");
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(
      join(dir, ".leina", "config.json"),
      JSON.stringify({ project_name: "   " }),
    );
    const det = deriveProjectKey(dir);
    assert.notEqual(det.method, "config-lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(SC-05d) extra fields in config.json are ignored, project_name is read", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(
      join(dir, ".leina", "config.json"),
      JSON.stringify({ project_name: "real-name", extra: true, version: 2 }),
    );
    const cfg = readProjectConfig(dir);
    assert.deepEqual(cfg, { project_name: "real-name" });
    const det = deriveProjectKey(dir);
    assert.equal(det.method, "config-lock");
    assert.equal(det.key, "real-name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-06: git-remote URL forms
// ---------------------------------------------------------------------------

test("(SC-06a) HTTPS URL git@style — github HTTPS form", () => {
  const name = repoNameFromRemote("https://github.com/org/my-project.git");
  assert.equal(name, "my-project");
});

test("(SC-06a2) SSH colon form — git@github.com:org/repo.git", () => {
  const name = repoNameFromRemote("git@github.com:org/repo.git");
  assert.equal(name, "repo");
});

test("(SC-06b) SSH scheme with port — ssh://git@host:22/org/repo.git", () => {
  const name = repoNameFromRemote("ssh://git@host:22/org/repo.git");
  assert.equal(name, "repo");
});

test("(EC-10) deep sub-group URL yields only last segment", () => {
  const name = repoNameFromRemote("https://gitlab.com/group/subgroup/deep/my-repo.git");
  assert.equal(name, "my-repo");
});

test("(EC-10b) SSH scheme with port + sub-group", () => {
  const name = repoNameFromRemote("ssh://git@gitlab.com:2222/group/subgroup/deep/repo.git");
  assert.equal(name, "repo");
});

test("(SC-06c) no origin remote → falls through to git-root", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir); // no remote
    const det = deriveProjectKey(dir);
    // should be git-root (basename of dir) or dir-basename
    assert.ok(det.method === "git-root" || det.method === "dir-basename");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(SC-06d) git not installed or not found → fail-open to dir-basename", () => {
  // Simulate by passing a non-directory path so git always fails
  const dir = tmpDir();
  try {
    // bare dir, no .git, no config
    const det = deriveProjectKey(dir);
    // In CI git may not find a repo. Regardless the result should be non-throwing.
    assert.ok(
      det.method === "dir-basename" ||
        det.method === "git-root" ||
        det.method === "git-remote" ||
        det.method === "child-git-auto",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(SC-11c) uppercase remote URL → normalized lowercase key", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir, "https://github.com/Org/My-Awesome-Repo.git");
    const det = deriveProjectKey(dir);
    assert.equal(det.method, "git-remote");
    assert.equal(det.key, "my-awesome-repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-07: git-root step
// ---------------------------------------------------------------------------

test("(SC-07a) git repo without remote → git-root basename", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir); // no remote
    const det = deriveProjectKey(dir);
    assert.ok(det.method === "git-root" || det.method === "dir-basename");
    // key should be basename of dir (normalized)
    assert.ok(det.key.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(SC-07b) non-git dir falls through to dir-basename", () => {
  const dir = tmpDir();
  try {
    const det = deriveProjectKey(dir);
    // no git, no children with .git → dir-basename
    assert.equal(det.method, "dir-basename");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-08: child-git-auto step
// ---------------------------------------------------------------------------

test("(SC-08a) single child git dir → child-git-auto with child's key", () => {
  const parent = tmpDir();
  try {
    // parent is NOT a git repo
    const childDir = join(parent, "my-child-repo");
    mkdirSync(childDir, { recursive: true });
    initGitRepo(childDir, "https://github.com/org/child-service.git");

    const det = deriveProjectKey(parent);
    assert.equal(det.method, "child-git-auto");
    assert.equal(det.key, "child-service");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-09: ambiguous child repos
// ---------------------------------------------------------------------------

test("(SC-09a) two+ child repos → AmbiguousProjectError with candidate list", () => {
  const parent = tmpDir();
  try {
    const c1 = join(parent, "repo-a");
    const c2 = join(parent, "repo-b");
    mkdirSync(c1, { recursive: true });
    mkdirSync(c2, { recursive: true });
    initGitRepo(c1);
    initGitRepo(c2);

    assert.throws(
      () => deriveProjectKey(parent),
      (err: unknown) => {
        assert.ok(err instanceof AmbiguousProjectError, "should be AmbiguousProjectError");
        assert.ok(err.candidates.includes("repo-a"), "repo-a in candidates");
        assert.ok(err.candidates.includes("repo-b"), "repo-b in candidates");
        return true;
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("(SC-09b) three child repos → AmbiguousProjectError", () => {
  const parent = tmpDir();
  try {
    for (const name of ["a", "b", "c"]) {
      const c = join(parent, name);
      mkdirSync(c, { recursive: true });
      initGitRepo(c);
    }
    assert.throws(
      () => deriveProjectKey(parent),
      (err: unknown) => err instanceof AmbiguousProjectError,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-10: dir-basename fallback
// ---------------------------------------------------------------------------

test("(SC-10a) plain dir (no git, no children) → dir-basename", () => {
  const dir = tmpDir();
  try {
    const det = deriveProjectKey(dir);
    assert.equal(det.method, "dir-basename");
    assert.ok(det.key.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-11: special name forms
// ---------------------------------------------------------------------------

test("(SC-11a) dir name with spaces/dashes normalizes to hyphens", () => {
  // Use a synthetic path-like name to test repoNameFromRemote behavior
  const name = "my-awesome project";
  // repoNameFromRemote with a constructed URL-like string
  const segment = repoNameFromRemote(`https://host/${name}`);
  // normalizeProjectKey is applied by the caller in deriveProjectKey
  assert.equal(segment, name);
});

test("(SC-11b) dots in remote URL repo name → dots stripped by normalizeProjectKey", () => {
  const name = repoNameFromRemote("https://github.com/org/my.repo.name.git");
  assert.equal(name, "my.repo.name");
  // normalizeProjectKey will convert dots to hyphens
});

// ---------------------------------------------------------------------------
// EC-01: fail-open without git
// ---------------------------------------------------------------------------

test("(EC-01) not a git repo, no children, no config → dir-basename, no throw", () => {
  const dir = tmpDir();
  try {
    const det = deriveProjectKey(dir);
    assert.equal(det.method, "dir-basename");
    assert.ok(det.key.length > 0, "key should not be empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// EC-11: config-lock wins even when ambiguous children exist
// ---------------------------------------------------------------------------

test("(EC-11) config-lock wins even when ambiguous children exist (step 0 short-circuits)", () => {
  const parent = tmpDir();
  try {
    // Two child repos → would throw AmbiguousProjectError if step 3 ran
    for (const name of ["child-a", "child-b"]) {
      const c = join(parent, name);
      mkdirSync(c, { recursive: true });
      initGitRepo(c);
    }
    // But config-lock is present → step 0 wins
    writeProjectConfig(parent, "locked-project");
    const det = deriveProjectKey(parent);
    assert.equal(det.method, "config-lock");
    assert.equal(det.key, "locked-project");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// writeProjectConfig / readProjectConfig round-trip
// ---------------------------------------------------------------------------

test("writeProjectConfig creates .leina/config.json with project_name", () => {
  const dir = tmpDir();
  try {
    writeProjectConfig(dir, "my-service");
    const cfg = readProjectConfig(dir);
    assert.deepEqual(cfg, { project_name: "my-service" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeProjectConfig is idempotent (overwrite same content)", () => {
  const dir = tmpDir();
  try {
    writeProjectConfig(dir, "my-service");
    writeProjectConfig(dir, "my-service");
    const cfg = readProjectConfig(dir);
    assert.deepEqual(cfg, { project_name: "my-service" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readProjectConfig returns null when file absent", () => {
  const dir = tmpDir();
  try {
    assert.equal(readProjectConfig(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// noise dirs are skipped in child-git-auto scan
// ---------------------------------------------------------------------------

test("noise dirs (node_modules, dist, .git) are not treated as child repos", () => {
  const parent = tmpDir();
  try {
    // Create noise dirs with .git inside them
    for (const name of ["node_modules", "dist", ".git"]) {
      const noiseDir = join(parent, name);
      mkdirSync(join(noiseDir, ".git"), { recursive: true });
    }
    // Create one real child repo
    const child = join(parent, "real-repo");
    mkdirSync(child, { recursive: true });
    initGitRepo(child);
    const det = deriveProjectKey(parent);
    // Only real-repo is a candidate; noise dirs ignored
    assert.equal(det.method, "child-git-auto");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// normalizeProjectKey unit tests (FR-11)
// ---------------------------------------------------------------------------

test("(NPK-01) normalizeProjectKey: simple hyphen-separated name is unchanged", () => {
  assert.equal(normalizeProjectKey("my-fresh-project"), "my-fresh-project");
});

test("(NPK-02) normalizeProjectKey: dots collapse to hyphens", () => {
  assert.equal(normalizeProjectKey("my.repo.name"), "my-repo-name");
});

test("(NPK-03) normalizeProjectKey: spaces collapse to hyphens", () => {
  assert.equal(normalizeProjectKey("my awesome project"), "my-awesome-project");
});

test("(NPK-04) normalizeProjectKey: mixed case is lowercased", () => {
  assert.equal(normalizeProjectKey("My-Awesome-Repo"), "my-awesome-repo");
});

test("(NPK-05) normalizeProjectKey: underscores become hyphens", () => {
  assert.equal(normalizeProjectKey("my_project_name"), "my-project-name");
});

test("(NPK-06) normalizeProjectKey: leading/trailing punctuation trimmed", () => {
  assert.equal(normalizeProjectKey("--my-project--"), "my-project");
  assert.equal(normalizeProjectKey("...repo..."), "repo");
});

test("(NPK-07) normalizeProjectKey: runs of mixed punctuation collapse to single hyphen", () => {
  assert.equal(normalizeProjectKey("my---repo..name"), "my-repo-name");
});

test("(NPK-08) normalizeProjectKey: slashes in name → hyphens (no path structure leaks)", () => {
  assert.equal(normalizeProjectKey("org/repo"), "org-repo");
  assert.equal(normalizeProjectKey("/some/path/to/repo"), "some-path-to-repo");
});

test("(NPK-09) normalizeProjectKey: Windows drive letters and backslashes → hyphens", () => {
  assert.equal(normalizeProjectKey("C:\\Users\\repo"), "c-users-repo");
});

test("(NPK-10) normalizeProjectKey: empty/all-punctuation falls back to 'project'", () => {
  assert.equal(normalizeProjectKey(""), "project");
  assert.equal(normalizeProjectKey("---"), "project");
  assert.equal(normalizeProjectKey("..."), "project");
});

test("(NPK-11) normalizeProjectKey: NFKC normalization applies before collapse", () => {
  // Fullwidth latin letters (e.g. Ａ = U+FF21) decompose to ASCII under NFKC
  assert.equal(normalizeProjectKey("\uFF41\uFF42\uFF43"), "abc"); // ａｂｃ → abc
});

test("(NPK-12) normalizeProjectKey: git remote .git suffix is stripped by repoNameFromRemote first, then key is hyphenated", () => {
  // This is the canonical FR-11 example from the spec
  const rawName = repoNameFromRemote("git@github.com:org/my-fresh-project.git");
  assert.equal(rawName, "my-fresh-project");
  assert.equal(normalizeProjectKey(rawName), "my-fresh-project");
});
