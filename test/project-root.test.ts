// Unit tests for src/application/project/root.ts — project-root resolution from
// subdirectories and worktrees. Pure fs fixtures (no git spawn): a linked
// worktree is modelled by its `.git` file + `commondir`, exactly what git writes.
// Run: node --no-warnings --experimental-strip-types --test test/project-root.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findConsentRoot,
  findGitToplevel,
  linkedWorktreeMainRoot,
  resolveGraphRoot,
} from "../src/application/project/root.ts";

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "project-root-home-"));
process.env.LEINA_HOME = join(SANDBOX_HOME, ".leina");
test.after(() => rmSync(SANDBOX_HOME, { recursive: true, force: true }));

function fresh(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "project-root-")));
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A main repo at `root` with an enabled consent flag. */
function repo(root: string, consent = "enabled"): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  write(join(root, ".leina", "consent"), consent);
}

/** A linked worktree at `wt` of the main repo at `main` (what `git worktree add` writes). */
function linkedWorktree(main: string, wt: string, name: string): void {
  const gitdir = join(main, ".git", "worktrees", name);
  write(join(gitdir, "commondir"), "../..\n");
  write(join(wt, ".git"), `gitdir: ${gitdir}\n`);
}

test("(proot-1) consent root resolves from the root itself and from a deep subdirectory", () => {
  const root = fresh();
  try {
    repo(root);
    mkdirSync(join(root, "src", "a", "b"), { recursive: true });
    assert.equal(findConsentRoot(root), root);
    assert.equal(findConsentRoot(join(root, "src", "a", "b")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(proot-2) a nearer 'disabled' flag wins over an enabled parent (opt-out is respected)", () => {
  const root = fresh();
  try {
    repo(root);
    const inner = join(root, "vendor", "lib");
    repo(inner, "disabled");
    assert.equal(findConsentRoot(join(inner, "src")), inner);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(proot-3) a Claude Code worktree nested under .claude/worktrees resolves to the enclosing project", () => {
  const root = fresh();
  try {
    repo(root);
    const wt = join(root, ".claude", "worktrees", "agent-1");
    linkedWorktree(root, wt, "agent-1");
    assert.equal(findConsentRoot(join(wt, "src")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(proot-4) a linked worktree outside the repo falls back to the main worktree's flag", () => {
  const base = fresh();
  try {
    const main = join(base, "main");
    const wt = join(base, "wt");
    repo(main);
    linkedWorktree(main, wt, "wt");
    mkdirSync(join(wt, "src"), { recursive: true });
    assert.equal(linkedWorktreeMainRoot(wt), main);
    assert.equal(findConsentRoot(join(wt, "src")), main);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("(proot-5) a submodule-style .git file (no commondir) is not a linked worktree", () => {
  const base = fresh();
  try {
    const sub = join(base, "sub");
    write(join(base, ".git", "modules", "sub", "HEAD"), "ref: refs/heads/main\n");
    write(join(sub, ".git"), `gitdir: ${join(base, ".git", "modules", "sub")}\n`);
    assert.equal(linkedWorktreeMainRoot(sub), undefined);
    assert.equal(findGitToplevel(join(sub)), sub);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("(proot-6) no project anywhere above → undefined; the leina home's parent is never a project", () => {
  const base = fresh();
  const savedHome = process.env.LEINA_HOME;
  try {
    // A directory whose `.leina` IS the leina home must not read as a project root.
    process.env.LEINA_HOME = join(base, ".leina");
    write(join(base, ".leina", "consent"), "enabled");
    mkdirSync(join(base, "plain"), { recursive: true });
    assert.equal(findConsentRoot(join(base, "plain")), undefined);
  } finally {
    process.env.LEINA_HOME = savedHome;
    rmSync(base, { recursive: true, force: true });
  }
});

test("(proot-7) graph root: nearest graph.db up to the git toplevel; else the toplevel", () => {
  const root = fresh();
  try {
    repo(root);
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    // No graph yet → the toplevel, never the subdirectory.
    assert.equal(resolveGraphRoot(join(root, "src", "deep")), root);
    write(join(root, ".leina", "graph.db"), "");
    assert.equal(resolveGraphRoot(join(root, "src", "deep")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(proot-8) graph root never crosses into the enclosing repo from a nested worktree", () => {
  const root = fresh();
  try {
    repo(root);
    write(join(root, ".leina", "graph.db"), "");
    const wt = join(root, ".claude", "worktrees", "agent-2");
    linkedWorktree(root, wt, "agent-2");
    mkdirSync(join(wt, "src"), { recursive: true });
    assert.equal(resolveGraphRoot(join(wt, "src")), wt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(proot-10) project root: a package with its own consent or name lock stays its own project", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    write(join(root, ".leina", "graph.db"), "");
    mkdirSync(join(root, "pkg-a", "src"), { recursive: true });
    mkdirSync(join(root, "pkg-b", "src"), { recursive: true });
    mkdirSync(join(root, "pkg-c", "src"), { recursive: true });
    write(join(root, "pkg-a", ".leina", "consent"), "enabled");
    write(join(root, "pkg-b", ".leina", "config.json"), '{"project_name":"b"}');
    // Runtime leftovers (session markers, a memory snapshot) do not make a project.
    write(join(root, "pkg-c", ".leina", "session.memory-loaded"), "");
    assert.equal(resolveGraphRoot(join(root, "pkg-a", "src")), join(root, "pkg-a"));
    assert.equal(resolveGraphRoot(join(root, "pkg-b", "src")), join(root, "pkg-b"));
    assert.equal(resolveGraphRoot(join(root, "pkg-c", "src")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(proot-9) outside git: an ancestor workspace graph serves; otherwise the start dir itself", () => {
  const ws = fresh();
  try {
    mkdirSync(join(ws, "docs"), { recursive: true });
    assert.equal(resolveGraphRoot(join(ws, "docs")), join(ws, "docs"));
    write(join(ws, ".leina", "graph.db"), "");
    assert.equal(resolveGraphRoot(join(ws, "docs")), ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
