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
import { claudeHooksJson, removeClaudeHooks } from "../src/application/install/claude-hooks.ts";
import { resolveHookProjectRoot } from "../src/cli/agent-gate.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const cliBase = { command: "/usr/bin/node", args: ["/pkg/dist/cli/index.js"] };

test("(ch-1) writer registers the four managed events, idempotently, preserving foreign hooks", () => {
  const existing = JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other-tool warmup" }] }] },
    permissions: { allow: ["Bash(ls:*)"] },
  });
  const merged = claudeHooksJson(cliBase, existing)!;
  const cfg = JSON.parse(merged);

  for (const ev of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const entries = cfg.hooks[ev];
    assert.ok(Array.isArray(entries), `${ev} registered`);
    const ours = entries.flatMap((e: { hooks: { command: string }[] }) => e.hooks).filter((h: { command: string }) => h.command.includes(" agent-hook "));
    assert.equal(ours.length, 1, `${ev} has exactly one managed entry`);
    assert.match((ours[0] as { command: string }).command, new RegExp(`agent-hook ${ev}$`));
  }
  // PostToolUse scoped to the tools the gate reacts to.
  assert.equal(cfg.hooks.PostToolUse.at(-1).matcher, "Bash|Grep|Read|Glob");
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

test("(ch-4) e2e: init --claude-hooks wires the repo; a Claude-shaped Bash payload flips the save marker", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-ch-home-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-ch-proj-"));
  const env = { ...process.env, LEINA_HOME: join(home, ".leina"), HOME: home, USERPROFILE: home };
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
      encoding: "utf8", env, cwd: dir, input,
    });
  try {
    const r = run(["init", "--project", dir, "--claude-hooks", "--hosts", "claude"]);
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
