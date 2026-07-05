// `leina activate` end-to-end — spawns the real CLI against sandboxed HOME dirs.
// Tests: fresh activation, idempotent re-run, --no-user-hooks, and the CLI grant.
// Run: node --no-warnings --experimental-strip-types --test test/activate-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

// Build a sandboxed environment: LEINA_HOME + HOME both redirected to a fresh temp dir.
function makeSandbox(): { env: NodeJS.ProcessEnv; home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "leina-activate-cli-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEINA_HOME: join(home, ".leina"),
    HOME: home,
    USERPROFILE: home,
  };
  // Point APPDATA into the sandbox so devinConfigRoot() resolves to <home>/.config/devin
  // on Windows too — the exact path these tests assert on every platform.
  env.APPDATA = join(home, ".config");
  return {
    env,
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function runActivate(
  env: NodeJS.ProcessEnv,
  ...extraArgs: string[]
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "activate", ...extraArgs],
    { encoding: "utf8", env },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Fresh activation
// ---------------------------------------------------------------------------

test("(act-a) fresh activation populates the share, creates symlinks, and writes user-global config", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const { status, stdout } = runActivate(env);
    assert.equal(status, 0, "exit code 0");
    // Share populated
    assert.ok(
      existsSync(join(home, ".leina", "share", ".version")),
      ".version sentinel written after activation",
    );
    assert.ok(existsSync(join(home, ".leina", "share", "skills")), "share/skills directory present");
    // Devin symlinks created
    assert.ok(existsSync(join(home, ".config", "devin", "skills")), "devin skills root present");
    // User-global config written with Exec grant
    const userCfg = join(home, ".config", "devin", "config.json");
    assert.ok(existsSync(userCfg), "user-global config.json written");
    const cfg = JSON.parse(readFileSync(userCfg, "utf8"));
    assert.ok(
      Array.isArray(cfg.permissions?.allow) && cfg.permissions.allow.includes("Exec(leina)"),
      "Exec(leina) grant in user-global config",
    );
    // User-global hooks written by default (activate defaults to userHooks=true)
    assert.ok(cfg.hooks, "user-global hooks written by default");
    assert.ok(Array.isArray(cfg.hooks.PreToolUse), "PreToolUse hooks present globally");
    // Structured report on stdout
    assert.match(stdout, /leina activate — share at/, "stdout has activate report header");
    assert.ok(stdout.trim().split("\n").length > 2, "report has multiple lines");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Idempotent re-run
// ---------------------------------------------------------------------------

test("(act-b) idempotent re-run: second activation produces same on-disk state with no backup churn", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    runActivate(env);
    const cfgPath = join(home, ".config", "devin", "config.json");
    const versionAfterFirst = readFileSync(join(home, ".leina", "share", ".version"), "utf8");
    const cfgAfterFirst = readFileSync(cfgPath, "utf8");

    runActivate(env);
    const versionAfterSecond = readFileSync(join(home, ".leina", "share", ".version"), "utf8");
    const cfgAfterSecond = readFileSync(cfgPath, "utf8");

    assert.equal(versionAfterFirst, versionAfterSecond, ".version sentinel unchanged on re-run");
    assert.equal(cfgAfterFirst, cfgAfterSecond, "user-global config byte-identical on re-run");
    // No backup files created by an idempotent re-run
    const devinCfgDir = join(home, ".config", "devin");
    const baks = readdirSync(devinCfgDir).filter((f: string) => f.includes(".bak-"));
    assert.equal(baks.length, 0, "no backup files on idempotent re-run");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// --no-user-hooks
// ---------------------------------------------------------------------------

test("(act-c) --no-user-hooks skips merging user-global hooks; Exec grant still written", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const { status } = runActivate(env, "--no-user-hooks");
    assert.equal(status, 0, "exit code 0");
    const cfgPath = join(home, ".config", "devin", "config.json");
    assert.ok(existsSync(cfgPath), "user-global config.json still written");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    // Grant is always written
    assert.ok(
      Array.isArray(cfg.permissions?.allow) && cfg.permissions.allow.includes("Exec(leina)"),
      "Exec(leina) grant present even with --no-user-hooks",
    );
    // Hooks NOT written
    assert.ok(!cfg.hooks, "user-global hooks absent when --no-user-hooks passed");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// stdout machine-readable; stderr clean on clean run
// ---------------------------------------------------------------------------

test("(act-d) activate does not emit 'deprecated' on stderr (only install-global alias does)", () => {
  const { env, cleanup } = makeSandbox();
  try {
    const { status, stderr } = runActivate(env);
    assert.equal(status, 0, "exit code 0");
    assert.doesNotMatch(stderr, /deprecated/, "activate does not emit deprecation notice on stderr");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Uniform error contract (F1.4): partial failure → ✖ on stderr + exit 1
// ---------------------------------------------------------------------------

test("(act-err-1) malformed user-global config: share/symlinks still installed, ✖ + exit 1", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    // Pre-plant an invalid JSON user-global config so writeUserGlobalConfig throws.
    const cfgDir = join(home, ".config", "devin");
    const cfgPath = join(cfgDir, "config.json");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, "{ this is not json");

    const { status, stdout, stderr } = runActivate(env);

    assert.equal(status, 1, "exit code 1 on partial failure");
    assert.match(stderr, /✖ activate: user-global config/);
    assert.match(stderr, /grant\/hooks NOT installed/);
    // Best-effort: the share was still populated and symlinked.
    assert.match(stdout, /populated v/);
    assert.ok(existsSync(join(home, ".leina", "share", "skills")), "share still populated");
    // The malformed file was NOT clobbered (no-clobber contract of the pure writers).
    assert.equal(readFileSync(cfgPath, "utf8"), "{ this is not json", "user file untouched");
  } finally {
    cleanup();
  }
});
