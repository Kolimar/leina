// hook-roots.test.ts — which project a hook acts on when the host hands it a
// subdirectory or a worktree: resolveHookRoots (consent root + harness root),
// resolveTrustRoot / isTrustedWorkspaceDir (trust inherited only within the same
// repository), and end-to-end `agent-hook` runs from those places.
// Run: node --no-warnings --experimental-strip-types --test test/hook-roots.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "hook-roots-home-"));
process.env.LEINA_HOME = join(SANDBOX_HOME, ".leina");
test.after(() => rmSync(SANDBOX_HOME, { recursive: true, force: true }));

const { findHarnessRoot, resolveTrustRoot } = await import("../src/application/project/root.ts");
const { isTrustedWorkspaceDir, trustWorkspace } = await import("../src/application/install/trust.ts");
const { resolveHookRoots } = await import("../src/cli/agent-gate.ts");

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function fresh(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "hook-roots-")));
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A trusted main repo at `root` with an enabled consent flag. */
function trustedRepo(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  write(join(root, ".leina", "consent"), "enabled");
  trustWorkspace(root);
}

/** A linked worktree at `wt` of the main repo at `main` (what `git worktree add` writes). */
function linkedWorktree(main: string, wt: string, name: string): void {
  const gitdir = join(main, ".git", "worktrees", name);
  write(join(gitdir, "commondir"), "../..\n");
  write(join(wt, ".git"), `gitdir: ${gitdir}\n`);
}

test("(hroot-1) a deep subdirectory resolves to the consent root and the repo's harness root", () => {
  const root = fresh();
  try {
    trustedRepo(root);
    const sub = join(root, "src", "deep", "er");
    mkdirSync(sub, { recursive: true });
    const roots = resolveHookRoots({ CLAUDE_PROJECT_DIR: sub }, "/elsewhere");
    assert.deepEqual(roots, { start: sub, root, harnessRoot: root });
    assert.equal(isTrustedWorkspaceDir(sub), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(hroot-2) a worktree nested under .claude/worktrees is its own harness root and inherits the repo's trust", () => {
  const root = fresh();
  try {
    trustedRepo(root);
    const wt = join(root, ".claude", "worktrees", "agent-1");
    linkedWorktree(root, wt, "agent-1");
    const roots = resolveHookRoots({ CLAUDE_PROJECT_DIR: wt }, "/elsewhere");
    assert.equal(roots.root, root, "consent/markers/context come from the main repo");
    assert.equal(roots.harnessRoot, wt, "the harness polices the worktree's own checkout");
    assert.equal(resolveTrustRoot(wt), root);
    assert.equal(isTrustedWorkspaceDir(wt), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(hroot-3) a linked worktree outside the repo inherits trust through its main worktree", () => {
  const main = fresh();
  const wt = fresh();
  try {
    trustedRepo(main);
    linkedWorktree(main, wt, "feature");
    const roots = resolveHookRoots({ DEVIN_PROJECT_DIR: join(wt) }, "/elsewhere");
    assert.equal(roots.root, main);
    assert.equal(roots.harnessRoot, wt);
    assert.equal(isTrustedWorkspaceDir(wt), true);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("(hroot-4) a nested independent clone or a submodule never inherits the parent's trust", () => {
  const root = fresh();
  try {
    trustedRepo(root);
    const clone = join(root, "vendor", "other");
    mkdirSync(join(clone, ".git"), { recursive: true });
    assert.equal(findHarnessRoot(join(clone, "lib")), clone);
    assert.equal(resolveTrustRoot(clone), clone);
    assert.equal(isTrustedWorkspaceDir(clone), false, "an independent clone is untrusted");

    const sub = join(root, "modules", "dep");
    write(join(root, ".git", "modules", "dep", "HEAD"), "ref: refs/heads/main\n");
    write(join(sub, ".git"), `gitdir: ${join(root, ".git", "modules", "dep")}\n`);
    assert.equal(isTrustedWorkspaceDir(sub), false, "a submodule (no commondir) is untrusted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(hroot-5) an opt-out in the subtree and an untrusted repo both stay untrusted", () => {
  const root = fresh();
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    write(join(root, ".leina", "consent"), "enabled");
    assert.equal(isTrustedWorkspaceDir(join(root, "src")), false, "no trust record");
    trustWorkspace(root);
    write(join(root, "pkg", ".leina", "consent"), "disabled");
    assert.equal(isTrustedWorkspaceDir(join(root, "pkg")), false, "a nearer disabled flag wins");
    assert.equal(isTrustedWorkspaceDir(join(root, "src")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(hroot-6) e2e: agent-hook fired from a subdirectory and from a nested worktree acts on the project", () => {
  const home = fresh();
  const dir = fresh();
  // No detached self-heal build: it would outlive the test holding the temp dir (Windows EBUSY).
  const env = { ...process.env, LEINA_HOME: join(home, ".leina"), HOME: home, USERPROFILE: home, LEINA_DISABLE_AUTOBUILD: "1" };
  const run = (args: string[], projectDir: string, input?: string) =>
    spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
      encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: projectDir }, cwd: projectDir, input,
    });
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    assert.equal(run(["init", "--project", dir, "--hosts", "claude", "--profile", "devin"], dir).status, 0);
    const sub = join(dir, "src", "feature");
    mkdirSync(sub, { recursive: true });

    const start = run(["agent-hook", "SessionStart", "--host", "claude"], sub, JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }));
    assert.equal(start.status, 0);
    assert.match(start.stdout, /"additionalContext"/, "a subdirectory still gets the project context");
    assert.ok(!existsSync(join(sub, ".leina")), "no stray per-subdir state");

    const wt = join(dir, ".claude", "worktrees", "agent-x");
    linkedWorktree(dir, wt, "agent-x");
    const edit = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(wt, ".harness", "config.json"), old_string: "a", new_string: "b" },
    });
    const sealed = run(["agent-hook", "PreToolUse", "--host", "claude"], wt, edit);
    assert.equal(sealed.status, 2, "the worktree's own harness config is sealed");
    assert.match(sealed.stderr, /BLOCKED/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
