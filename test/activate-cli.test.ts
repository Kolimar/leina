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
  // The CLI is now vendor-neutral: `activate` requires an explicit --hosts (it never picks
  // a host on its own). These legacy tests assert the historical devin wiring, so default
  // them to `--hosts devin`; callers passing their own --hosts are left untouched.
  const args = extraArgs.includes("--hosts") ? extraArgs : [...extraArgs, "--hosts", "devin"];
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "activate", ...args],
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

// ---------------------------------------------------------------------------
// Claude Code user-global hooks (~/.claude/settings.json) follow the host selection
// ---------------------------------------------------------------------------

function claudeSettings(home: string): { path: string; read: () => Record<string, unknown> } {
  const path = join(home, ".claude", "settings.json");
  return { path, read: () => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> };
}

function managedCommands(cfg: Record<string, unknown>): string[] {
  const hooks = (cfg.hooks ?? {}) as Record<string, { hooks?: { command?: string }[] }[]>;
  return Object.values(hooks)
    .flat()
    .flatMap((e) => e.hooks ?? [])
    .map((h) => h.command ?? "")
    .filter((c) => c.includes(" agent-hook "));
}

test("(act-claude-1) --hosts claude merges user-scoped hooks into ~/.claude/settings.json, keeping other keys, with one backup", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const settings = claudeSettings(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings.path, JSON.stringify({ theme: "dark", permissions: { allow: ["Bash(ls:*)"] } }, null, 2));

    assert.equal(runActivate(env, "--hosts", "claude").status, 0);
    const cfg = settings.read();
    assert.equal(cfg.theme, "dark", "foreign keys preserved");
    assert.deepEqual(cfg.permissions, { allow: ["Bash(ls:*)"] });
    const cmds = managedCommands(cfg);
    assert.equal(cmds.length, 5, "SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop");
    for (const c of cmds) assert.match(c, / agent-hook \w+ --host claude --scope user$/);
    const backups = () => readdirSync(join(home, ".claude")).filter((f) => f.startsWith("settings.json.bak-"));
    assert.equal(backups().length, 1, "first content-changing write leaves a backup");

    const before = readFileSync(settings.path, "utf8");
    assert.equal(runActivate(env, "--hosts", "claude").status, 0);
    assert.equal(readFileSync(settings.path, "utf8"), before, "idempotent re-run");
    assert.equal(backups().length, 1, "no backup churn on an idempotent re-run");
  } finally {
    cleanup();
  }
});

test("(act-claude-2) --no-user-hooks and deselecting a host strip the managed hooks; the Exec grant stays", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    assert.equal(runActivate(env, "--hosts", "devin,claude").status, 0);
    const devinCfg = () => JSON.parse(readFileSync(join(home, ".config", "devin", "config.json"), "utf8"));
    assert.ok(devinCfg().hooks, "Devin user hooks written");
    assert.equal(managedCommands(claudeSettings(home).read()).length, 5, "Claude user hooks written");

    assert.equal(runActivate(env, "--hosts", "claude").status, 0);
    assert.ok(!devinCfg().hooks, "Devin deselected → its user hooks stripped");
    assert.ok(devinCfg().permissions.allow.includes("Exec(leina)"), "grant kept");
    assert.equal(managedCommands(claudeSettings(home).read()).length, 5, "Claude still selected");

    assert.equal(runActivate(env, "--hosts", "claude", "--no-user-hooks").status, 0);
    assert.equal(managedCommands(claudeSettings(home).read()).length, 0, "--no-user-hooks strips ours");
  } finally {
    cleanup();
  }
});

test("(act-claude-3) deactivate strips the Claude Code user hooks and keeps the rest of the file", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const settings = claudeSettings(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings.path, JSON.stringify({ theme: "dark" }));
    assert.equal(runActivate(env, "--hosts", "claude").status, 0);
    const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, "deactivate"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Claude Code hooks removed/);
    assert.deepEqual(settings.read(), { theme: "dark" });
  } finally {
    cleanup();
  }
});

test("(act-claude-4) a malformed ~/.claude/settings.json is never clobbered: ✖ + exit 1", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const settings = claudeSettings(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings.path, "{ nope");
    const { status, stderr } = runActivate(env, "--hosts", "claude");
    assert.equal(status, 1);
    assert.match(stderr, /✖ activate: Claude Code user settings .*hooks NOT installed/);
    assert.equal(readFileSync(settings.path, "utf8"), "{ nope");
  } finally {
    cleanup();
  }
});
