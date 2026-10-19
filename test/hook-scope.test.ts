// hook-scope.test.ts — one answer per hook event: a lower-priority copy of the managed
// wiring (the user-global one, or under Devin the borrowed Claude Code one) stands down when
// a higher-priority copy wires the same event. Pure matrix + fs-backed decision + e2e.
// Run: node --no-warnings --experimental-strip-types --test test/hook-scope.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type HookSource, runningHookHost, shouldDeferHook } from "../src/application/install/hook-scope.ts";
import { claudeHooksJson } from "../src/application/install/claude-hooks.ts";
import { buildUserGlobalHooks, devinHooksJson, devinUserConfigWithHooks } from "../src/application/install/devin-hooks.ts";
import { type AgentHookInvocation, shouldDeferInvocation } from "../src/cli/agent-gate.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const cli = { command: "/usr/bin/node", args: ["/pkg/dist/cli/index.js"] };

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "hook-scope-home-")));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.APPDATA = join(SANDBOX, ".config");
process.env.LEINA_HOME = join(SANDBOX, ".leina");
test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

const wires = (...sources: HookSource[]) => (s: HookSource): boolean => sources.includes(s);

test("(hscope-1) Claude Code: the user copy stands down only when the project copy wires the event", () => {
  assert.equal(shouldDeferHook("claude", "claude-user", wires("claude-project")), true);
  assert.equal(shouldDeferHook("claude", "claude-user", wires()), false);
  assert.equal(shouldDeferHook("claude", "claude-project", wires("claude-project", "claude-user")), false, "project copy always answers");
});

test("(hscope-2) Devin: own project > Claude project > own user > Claude user", () => {
  assert.equal(shouldDeferHook("devin", "devin-project", wires("claude-project", "devin-user", "claude-user")), false);
  assert.equal(shouldDeferHook("devin", "claude-project", wires("devin-project")), true);
  assert.equal(shouldDeferHook("devin", "claude-project", wires("devin-user")), false, "a project copy beats any user copy");
  assert.equal(shouldDeferHook("devin", "devin-user", wires("claude-project")), true);
  assert.equal(shouldDeferHook("devin", "devin-user", wires("claude-user")), false);
  assert.equal(shouldDeferHook("devin", "claude-user", wires("devin-user")), true);
  assert.equal(shouldDeferHook("devin", "claude-user", wires()), false);
});

test("(hscope-3) the running host comes from the host's documented project-dir variable", () => {
  assert.equal(runningHookHost({ DEVIN_PROJECT_DIR: "/p" }, "claude"), "devin");
  assert.equal(runningHookHost({ CLAUDE_PROJECT_DIR: "/p" }, "devin"), "claude");
  assert.equal(runningHookHost({ DEVIN_PROJECT_DIR: " " }, "claude"), "claude", "blank → the entry's host");
});

const inv = (event: string, host: "claude" | "devin", scope: "project" | "user", flagged = true): AgentHookInvocation => ({
  event, host, scope, flagged,
});

test("(hscope-4) fs: Claude Code user copy defers to the project's .claude/settings.json, per event", () => {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "hook-scope-proj-")));
  try {
    mkdirSync(join(proj, ".claude"), { recursive: true });
    const env = { CLAUDE_PROJECT_DIR: proj };
    assert.equal(shouldDeferInvocation(inv("SessionStart", "claude", "user"), proj, env), false, "no project wiring");
    // A pre-3.0 project file: no PreToolUse entry, no flags.
    const legacy = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/n /pkg/dist/cli/index.js agent-hook SessionStart" }] }] } };
    writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify(legacy));
    assert.equal(shouldDeferInvocation(inv("SessionStart", "claude", "user"), proj, env), true);
    assert.equal(shouldDeferInvocation(inv("PreToolUse", "claude", "user"), proj, env), false, "the event the project lacks still runs");
    assert.equal(shouldDeferInvocation(inv("SessionStart", "claude", "user", false), proj, env), false, "unflagged entries never defer");
    writeFileSync(join(proj, ".claude", "settings.json"), claudeHooksJson(cli, null)!);
    assert.equal(shouldDeferInvocation(inv("PreToolUse", "claude", "user"), proj, env), true);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("(hscope-5) fs: under Devin, project files are found up to the repo root and Devin's own copy wins", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "hook-scope-repo-")));
  try {
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "packages", "a");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(repo, ".devin"), { recursive: true });
    writeFileSync(join(repo, ".devin", "hooks.v1.json"), devinHooksJson(cli, null).content);
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), claudeHooksJson(cli, null)!);
    const env = { DEVIN_PROJECT_DIR: sub };
    assert.equal(shouldDeferInvocation(inv("Stop", "devin", "user"), sub, env), true);
    assert.equal(shouldDeferInvocation(inv("Stop", "claude", "project"), sub, env), true, "Devin's own project copy answers");
    assert.equal(shouldDeferInvocation(inv("Stop", "devin", "project"), sub, env), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("(hscope-6) fs: under Devin without project wiring, the Claude Code user copy defers to Devin's user copy", () => {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "hook-scope-bare-")));
  const devinCfg = join(SANDBOX, ".config", "devin", "config.json");
  try {
    const env = { DEVIN_PROJECT_DIR: proj };
    assert.equal(shouldDeferInvocation(inv("SessionStart", "claude", "user"), proj, env), false);
    mkdirSync(join(SANDBOX, ".config", "devin"), { recursive: true });
    writeFileSync(devinCfg, devinUserConfigWithHooks(null, buildUserGlobalHooks(cli)));
    assert.equal(shouldDeferInvocation(inv("SessionStart", "claude", "user"), proj, env), true);
    assert.equal(shouldDeferInvocation(inv("SessionStart", "devin", "user"), proj, env), false);
  } finally {
    rmSync(devinCfg, { force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("(hscope-7) e2e: with project wiring the user-global entry is silent and the project entry answers", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hook-scope-e2e-home-")));
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "hook-scope-e2e-proj-")));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, ".config"), LEINA_HOME: join(home, ".leina"), CLAUDE_PROJECT_DIR: proj, LEINA_DISABLE_AUTOBUILD: "1" };
  delete env.DEVIN_PROJECT_DIR;
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], { encoding: "utf8", env, cwd: proj, input });
  try {
    assert.equal(run(["init", "--project", proj, "--hosts", "claude", "--profile", "devin"]).status, 0);
    const payload = JSON.stringify({ hook_event_name: "SessionStart", source: "startup" });
    const user = run(["agent-hook", "SessionStart", "--host", "claude", "--scope", "user"], payload);
    assert.equal(user.status, 0);
    assert.equal(user.stdout, "", "the user-global copy stands down");
    const project = run(["agent-hook", "SessionStart", "--host", "claude"], payload);
    assert.match(project.stdout, /"additionalContext"/, "the project copy answers");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
