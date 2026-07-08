// multi-host-cli.test.ts — linking the share into multiple AI hosts (Devin + Claude Code)
// via `activate --hosts`. Contract: Devin-only by default (back-compat); Claude Code gets
// dir symlinks for skills and flat .md symlinks for agents (its native format, which is
// what assets/agents/*.md already are); deselecting a host unlinks it; deactivate sweeps
// every host in the table.
// Run: node --no-warnings --experimental-strip-types --test test/multi-host-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function makeSandbox(): { env: NodeJS.ProcessEnv; home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "leina-hosts-cli-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEINA_HOME: join(home, ".leina"),
    HOME: home,
    USERPROFILE: home,
  };
  // Point APPDATA into the sandbox so devinConfigRoot() resolves to <home>/.config/devin
  // on Windows too — the exact path these tests assert on every platform.
  env.APPDATA = join(home, ".config");
  return { env, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  // Host-requiring subcommands now need an explicit --hosts; default to the
  // historical devin wiring when a caller doesn't specify one.
  const hostCmds = new Set(["setup", "activate", "init", "install-global"]);
  const finalArgs =
    hostCmds.has(args[0] ?? "") && !args.includes("--hosts")
      ? [...args, "--hosts", "devin"]
      : args;
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...finalArgs],
    { encoding: "utf8", env },
  );
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("(mh-a) bare activate without --hosts fails — leina never picks a host", () => {
  const { env, cleanup } = makeSandbox();
  try {
    // Invoke the CLI directly (not via `run`, which would inject --hosts): a bare
    // activate in a fresh sandbox with no persisted selection must be rejected —
    // leina no longer silently defaults to any host.
    const r = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "activate"],
      { encoding: "utf8", env },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--hosts is required/);
  } finally {
    cleanup();
  }
});

test("(mh-b) --hosts devin,claude links both; Claude agents are flat .md symlinks", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const r = run(env, "activate", "--hosts", "devin,claude");
    assert.equal(r.status, 0, r.stderr);

    // Skills: dir symlink in both hosts.
    assert.ok(existsSync(join(home, ".config", "devin", "skills", "graph-viz")));
    const claudeSkill = join(home, ".claude", "skills", "graph-viz");
    assert.ok(existsSync(claudeSkill), "claude skill linked");
    // On Windows without the symlink privilege linkOrCopy falls back to a copy by design.
    if (process.platform !== "win32") assert.ok(lstatSync(claudeSkill).isSymbolicLink());

    // Agents: Devin dir shape vs Claude flat .md file.
    assert.ok(existsSync(join(home, ".config", "devin", "agents", "sdd-explore", "AGENT.md")));
    const claudeAgent = join(home, ".claude", "agents", "sdd-explore.md");
    assert.ok(existsSync(claudeAgent), "claude agent .md linked");
    if (process.platform !== "win32") assert.ok(lstatSync(claudeAgent).isSymbolicLink());

    // The flat copies live in the share (single source of truth both hosts point into).
    assert.ok(existsSync(join(home, ".leina", "share", "claude-agents", "sdd-explore.md")));
  } finally {
    cleanup();
  }
});

test("(mh-c) deselecting a host on re-activate unlinks it; assets stay for the kept host", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    assert.equal(run(env, "activate", "--hosts", "devin,claude").status, 0);
    assert.ok(existsSync(join(home, ".claude", "skills", "graph-viz")));

    const r = run(env, "activate", "--hosts", "devin");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /swept \d+ stale host link/);
    assert.equal(
      readdirSync(join(home, ".claude", "skills")).length, 0,
      "claude skills unlinked after host deselection",
    );
    assert.ok(existsSync(join(home, ".config", "devin", "skills", "graph-viz")), "devin untouched");
  } finally {
    cleanup();
  }
});

test("(mh-d) --hosts alone changes WHERE, not WHAT (persisted asset choice kept)", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    assert.equal(run(env, "activate", "--preset", "minimal").status, 0);
    const r = run(env, "activate", "--hosts", "devin,claude");
    assert.equal(r.status, 0, r.stderr);
    // Still the minimal set — in BOTH hosts.
    const claudeSkills = readdirSync(join(home, ".claude", "skills")).sort();
    assert.deepEqual(claudeSkills, ["_shared", "leina-setup"]);
    // Minimal has zero agents, so the agents dir is never even created.
    assert.ok(!existsSync(join(home, ".claude", "agents")), "minimal links no agents");
  } finally {
    cleanup();
  }
});

test("(mh-e) deactivate cleans every host in the table", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    assert.equal(run(env, "activate", "--hosts", "devin,claude").status, 0);
    assert.equal(run(env, "deactivate").status, 0);
    assert.equal(readdirSync(join(home, ".claude", "skills")).length, 0, "claude skills gone");
    assert.equal(readdirSync(join(home, ".claude", "agents")).length, 0, "claude agents gone");
    assert.equal(readdirSync(join(home, ".config", "devin", "skills")).length, 0, "devin skills gone");
  } finally {
    cleanup();
  }
});

test("(mh-f) unknown host is a hard error", () => {
  const { env, cleanup } = makeSandbox();
  try {
    const r = run(env, "activate", "--hosts", "cursor");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown host "cursor".*devin, claude/);
  } finally {
    cleanup();
  }
});
