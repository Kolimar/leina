// `leina repair` end-to-end — the write-side counterpart of the read-only doctor.
// Contract under test:
//   - scoped by evidence: never activates a machine that was never activated, never
//     initializes a repo that was never initialized, never overrides a deinit opt-out;
//   - re-runs the idempotent writers to restore broken global/project state;
//   - ends with a doctor pass whose failures drive a non-zero exit.
// Run: node --no-warnings --experimental-strip-types --test test/repair-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function makeSandbox(): { env: NodeJS.ProcessEnv; home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "leina-repair-cli-"));
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

function runCli(
  env: NodeJS.ProcessEnv,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
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

function tmpProject(): string {
  const dir = join(tmpdir(), `cg-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Bring a sandboxed project to full doctor health: activate + init + a built graph + an
// initialized global memory.db. repair's exit code deliberately mirrors doctor, so the
// "healthy" fixtures must clear the first-use states too (graph never built, memory absent).
function healthyBaseline(env: NodeJS.ProcessEnv, dir: string): void {
  writeFileSync(join(dir, "a.ts"), "export function hi(): number { return 1; }\n");
  assert.equal(runCli(env, "activate").status, 0, "activate ok");
  assert.equal(runCli(env, "init", "--project", dir).status, 0, "init ok");
  assert.equal(runCli(env, "build", dir).status, 0, "build ok");
  assert.equal(runCli(env, "memory", "save", dir, "--title", "t", "--content", "c").status, 0, "memory ok");
}

test("(rep-a) pristine machine: repair installs NOTHING, reports both skips, exits per doctor", () => {
  const { env, home, cleanup } = makeSandbox();
  const dir = tmpProject();
  try {
    const { status, stdout } = runCli(env, "repair", dir);
    assert.match(stdout, /global: never activated — skipped/);
    assert.match(stdout, /project: not initialized — skipped/);
    // Nothing was created by repair itself.
    assert.ok(!existsSync(join(home, ".leina", "share")), "share NOT created");
    assert.ok(!existsSync(join(dir, "AGENTS.md")), "AGENTS.md NOT created");
    assert.ok(!existsSync(join(dir, ".leina", "consent")), "consent NOT created");
    // Doctor still fails (share missing) — repair is honest about what it cannot fix.
    assert.equal(status, 1, "exit 1: unfixable failures remain");
    assert.match(stdout, /still failing/);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(rep-b) broken activated install: repair restores symlinks, share version and repo wiring; exit 0", () => {
  const { env, home, cleanup } = makeSandbox();
  const dir = tmpProject();
  try {
    healthyBaseline(env, dir);

    // Break three things: a host symlink, the share version sentinel, and AGENTS.md.
    const skillLink = join(home, ".config", "devin", "skills", "leina-setup");
    unlinkSync(skillLink);
    writeFileSync(join(home, ".leina", "share", ".version"), "0.0.1");
    unlinkSync(join(dir, "AGENTS.md"));

    const { status, stdout } = runCli(env, "repair", dir);
    assert.equal(status, 0, stdout);
    assert.ok(existsSync(skillLink), "host symlink restored");
    assert.notEqual(readFileSync(join(home, ".leina", "share", ".version"), "utf8"), "0.0.1", "share repopulated");
    assert.ok(existsSync(join(dir, "AGENTS.md")), "AGENTS.md re-written");
    assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /leina:protocol:start/);
    assert.match(stdout, /repair done — doctor reports no failing checks/);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(rep-c) deinit opt-out is respected: repair never re-wires a consent=disabled repo", () => {
  const { env, cleanup } = makeSandbox();
  const dir = tmpProject();
  try {
    assert.equal(runCli(env, "activate").status, 0, "activate ok");
    assert.equal(runCli(env, "init", "--project", dir).status, 0, "init ok");
    assert.equal(runCli(env, "deinit", "--project", dir).status, 0, "deinit ok");

    const { stdout } = runCli(env, "repair", dir);
    assert.match(stdout, /project: consent=disabled — skipped/);
    const agents = existsSync(join(dir, "AGENTS.md")) ? readFileSync(join(dir, "AGENTS.md"), "utf8") : "";
    assert.ok(!agents.includes("leina:protocol:start"), "protocol block NOT re-written");
    assert.ok(!existsSync(join(dir, ".devin", "hooks.v1.json")), "hooks NOT re-written");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(rep-d) repair is idempotent on a healthy install (no churn, exit 0)", () => {
  const { env, cleanup } = makeSandbox();
  const dir = tmpProject();
  try {
    healthyBaseline(env, dir);
    const agentsBefore = readFileSync(join(dir, "AGENTS.md"), "utf8");

    const first = runCli(env, "repair", dir);
    const second = runCli(env, "repair", dir);
    assert.equal(first.status, 0, first.stdout);
    assert.equal(second.status, 0, second.stdout);
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), agentsBefore, "AGENTS.md unchanged");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
