// claude-hooks.test.ts — the host-neutral gate serving Claude Code: settings.json writer,
// tool-name aliasing (Bash→exec etc.), CLAUDE_PROJECT_DIR root resolution, and the
// init --claude-hooks / deinit lifecycle.
// Run: node --no-warnings --experimental-strip-types --test test/claude-hooks.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_PRE_TOOL_MATCHER, claudeHooksJson, removeClaudeHooks } from "../src/application/install/claude-hooks.ts";
import { HARNESS_BASH_TOOLS, HARNESS_EDIT_TOOLS, parseAgentHookArgs, resolveHookProjectRoot } from "../src/cli/agent-gate.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const cliBase = { command: "/usr/bin/node", args: ["/pkg/dist/cli/index.js"] };

test("(ch-1) writer registers the five managed events, idempotently, preserving foreign hooks", () => {
  const existing = JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other-tool warmup" }] }] },
    permissions: { allow: ["Bash(ls:*)"] },
  });
  const merged = claudeHooksJson(cliBase, existing)!;
  const cfg = JSON.parse(merged);

  for (const ev of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const entries = cfg.hooks[ev];
    assert.ok(Array.isArray(entries), `${ev} registered`);
    const ours = entries.flatMap((e: { hooks: { command: string }[] }) => e.hooks).filter((h: { command: string }) => h.command.includes(" agent-hook "));
    assert.equal(ours.length, 1, `${ev} has exactly one managed entry`);
    assert.match((ours[0] as { command: string }).command, new RegExp(`agent-hook ${ev} --host claude$`));
  }
  // PostToolUse scoped to the tools the gate reacts to, the leina MCP memory tools included.
  assert.equal(
    cfg.hooks.PostToolUse.at(-1).matcher,
    "Bash|Grep|Read|Glob|mcp__leina__memory_context|mcp__leina__memory_search|mcp__leina__memory_verified|mcp__leina__memory_add|mcp__leina__memory_update|mcp__leina__memory_session",
  );
  // Foreign content survives.
  assert.ok(cfg.hooks.SessionStart.some((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command === "other-tool warmup")));
  assert.deepEqual(cfg.permissions, { allow: ["Bash(ls:*)"] });

  // Idempotent + malformed input no-clobber.
  assert.equal(claudeHooksJson(cliBase, merged), null);
  assert.equal(claudeHooksJson(cliBase, "{ nope"), null);
});

test("(ch-2) removeClaudeHooks strips only ours; empty events and hooks key collapse", () => {
  const merged = claudeHooksJson(cliBase, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }] },
  }))!;
  const stripped = JSON.parse(removeClaudeHooks(merged)!);
  assert.deepEqual(Object.keys(stripped.hooks), ["Stop"], "only the foreign Stop entry remains");
  assert.equal(stripped.hooks.Stop[0].hooks[0].command, "keep-me");

  const fully = claudeHooksJson(cliBase, null)!;
  const emptied = JSON.parse(removeClaudeHooks(fully)!);
  assert.ok(!("hooks" in emptied), "hooks key dropped when nothing remains");
  assert.equal(removeClaudeHooks(JSON.stringify({ a: 1 })), null, "nothing to strip → null");
});

test("(ch-2b) user scope tags every entry --scope user and replaces older managed forms", () => {
  const legacy = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "/old/node /old/dist/cli/index.js agent-hook Stop" }] }] },
  });
  const cfg = JSON.parse(claudeHooksJson(cliBase, legacy, "user")!);
  const cmds: string[] = Object.values(cfg.hooks as Record<string, { hooks: { command: string }[] }[]>)
    .flat()
    .flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(cmds.length > 0);
  for (const c of cmds) assert.match(c, / --host claude --scope user$/);
  assert.ok(!cmds.some((c) => c.startsWith("/old/")), "the stale launch form was replaced, not duplicated");
});

test("(ch-2c) upgrading a pre-MCP install replaces the old PostToolUse matcher, keeps user hooks, and is idempotent", () => {
  const old = (command: string) => ({ matcher: "Bash|Grep|Read|Glob", hooks: [{ type: "command", command }] });
  const existing = JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] },
        old("/old/node /old/dist/cli/index.js agent-hook PostToolUse --host claude"),
      ],
    },
  });
  for (const scope of ["project", "user"] as const) {
    const next = claudeHooksJson(cliBase, existing, scope)!;
    const post = JSON.parse(next).hooks.PostToolUse as { matcher: string; hooks: { command: string }[] }[];
    const ours = post.filter((e) => e.hooks.some((h) => h.command.includes(" agent-hook ")));
    assert.equal(ours.length, 1, "exactly one managed PostToolUse entry");
    assert.match(ours[0]!.matcher, /^Bash\|Grep\|Read\|Glob\|mcp__leina__memory_context\|.*mcp__leina__memory_session$/);
    assert.ok(post.some((e) => e.hooks.some((h) => h.command === "my-linter")), "the user hook survives");
    assert.equal(claudeHooksJson(cliBase, next, scope), null, "second run changes nothing");
  }
});

test("(ch-3) CLAUDE_PROJECT_DIR wins root resolution; Devin var and cwd still work", () => {
  assert.equal(resolveHookProjectRoot({ CLAUDE_PROJECT_DIR: "/from/claude" }, "/cwd"), "/from/claude");
  assert.equal(resolveHookProjectRoot({ DEVIN_PROJECT_DIR: "/from/devin" }, "/cwd"), "/from/devin");
  assert.equal(
    resolveHookProjectRoot({ CLAUDE_PROJECT_DIR: "/c", DEVIN_PROJECT_DIR: "/d" }, "/cwd"),
    "/c",
    "claude var takes precedence",
  );
  assert.equal(resolveHookProjectRoot({ CLAUDE_PROJECT_DIR: "  " }, "/cwd"), "/cwd", "blank falls through");
});

test("(ch-3b) agent-hook args: explicit --host/--scope win; a flagless entry falls back on CLAUDE_PROJECT_DIR", () => {
  assert.deepEqual(parseAgentHookArgs(["Stop", "--host", "devin", "--scope", "user"], { CLAUDE_PROJECT_DIR: "/p" }), {
    event: "Stop",
    host: "devin",
    scope: "user",
    flagged: true,
  });
  assert.deepEqual(parseAgentHookArgs(["Stop"], { CLAUDE_PROJECT_DIR: "/p" }), { event: "Stop", host: "claude", scope: "project", flagged: false });
  assert.deepEqual(parseAgentHookArgs(["Stop"], { CLAUDE_PROJECT_DIR: " " }), { event: "Stop", host: "devin", scope: "project", flagged: false });
  assert.equal(parseAgentHookArgs(["--host", "claude"], {}).event, undefined);
  assert.equal(parseAgentHookArgs(["Stop", "--host", "cursor"], {}).host, "devin", "unknown host value → fallback");
});

test("(ch-4) e2e: init --claude-hooks wires the repo; a Claude-shaped Bash payload flips the save marker", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-ch-home-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-ch-proj-"));
  const env = { ...process.env, LEINA_HOME: join(home, ".leina"), HOME: home, USERPROFILE: home };
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
      encoding: "utf8", env, cwd: dir, input,
    });
  try {
    const r = run(["init", "--project", dir, "--claude-hooks", "--hosts", "claude", "--profile", "devin"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\.claude\/settings\.json \(agent-hook entries/);
    const cfg = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    assert.ok(cfg.hooks.SessionStart, "SessionStart hook written");

    // Claude Code payload: tool_name "Bash" (not Devin's "exec") running a memory save.
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: `leina memory save ${dir} --title t --content c` },
      cwd: dir,
    });
    const hook = run(["agent-hook", "PostToolUse"], payload);
    assert.equal(hook.status, 0, hook.stderr);
    assert.ok(
      existsSync(join(dir, ".leina", "session.memory-saved")),
      "save marker flipped from a Claude-shaped payload (Bash → exec aliasing)",
    );

    // deinit strips the managed entries.
    assert.equal(run(["deinit", "--project", dir]).status, 0);
    const after = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    assert.ok(!after.includes("agent-hook"), "managed entries stripped");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ch-5) PreToolUse is wired for every tool the harness enforcement branch acts on", () => {
  const cfg = JSON.parse(claudeHooksJson(cliBase, null)!);
  const pre = cfg.hooks.PreToolUse.at(-1) as { matcher: string; hooks: { command: string }[] };
  assert.equal(pre.matcher, CLAUDE_PRE_TOOL_MATCHER);
  assert.match(pre.hooks[0]!.command, / agent-hook PreToolUse --host claude$/);
  const listed = new Set(pre.matcher.split("|"));
  // Claude Code tool names are capitalized; Devin's lowercase names never reach this file.
  for (const tool of [...HARNESS_EDIT_TOOLS, ...HARNESS_BASH_TOOLS].filter((t) => /^[A-Z]/.test(t))) {
    assert.ok(listed.has(tool), `${tool} reaches the harness gate`);
  }
});

test("(ch-6) e2e: in a trusted Claude-wired repo the PreToolUse hook refuses an Edit of the harness config", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-ch-home-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-ch-proj-"));
  const env = { ...process.env, LEINA_HOME: join(home, ".leina"), HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: dir };
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
      encoding: "utf8", env, cwd: dir, input,
    });
  try {
    assert.equal(run(["init", "--project", dir, "--hosts", "claude", "--profile", "devin"]).status, 0);
    const payload = (file: string) => JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(dir, file), old_string: "a", new_string: "b" },
    });
    const sealed = run(["agent-hook", "PreToolUse", "--host", "claude"], payload(".harness/config.json"));
    assert.equal(sealed.status, 2, "the integrity seal blocks (exit 2)");
    assert.match(sealed.stderr, /BLOCKED/);
    const plain = run(["agent-hook", "PreToolUse", "--host", "claude"], payload("src/a.ts"));
    assert.equal(plain.status, 0, "an ordinary edit passes");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
