// `leina devin-hook <event>` end-to-end — spawns the real CLI, pipes a Devin hook
// payload on stdin, asserts the exit code (always 0 — advisory only), the stderr advisory text,
// and the per-project session marker. Sibling of test/hook-cli.test.ts for the Cascade (`hook`)
// subcommand.
// Run: node --no-warnings --experimental-strip-types --test test/devin-hook-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const MARKER_REL = ".leina/session.memory-loaded";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Seed a tmp dir to BE a leina project (consent flag = "enabled"). The
// runAgentGate scope guard reads the consent flag; any dir without consent=enabled is
// silently ignored. Tests that exercise the scope guard itself use mkdtempSync directly.
function freshProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cg-devin-hook-"));
  // Write consent=enabled — scope sentinel for PR5+ (replaces .devin/hooks.v1.json).
  mkdirSync(join(dir, ".leina"), { recursive: true });
  writeFileSync(join(dir, ".leina", "consent"), "enabled");
  return dir;
}

function runDevinHook(
  cwd: string,
  event: string,
  payload: object | string,
  extraEnv?: Record<string, string>,
): RunResult {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  // Strip DEVIN_PROJECT_DIR from the inherited env so the hook resolves its project root from
  // `cwd` (the layout this helper sets up), never from a value leaked by the surrounding shell.
  // resolveHookProjectRoot prefers DEVIN_PROJECT_DIR over cwd, so an ambient var pointing at a
  // real leina project would make SessionStart read the developer's global memory.db and
  // break these assertions — a contaminated environment must not change the outcome.
  const baseEnv = { ...process.env };
  delete baseEnv.DEVIN_PROJECT_DIR;
  // spawnSync (not execFileSync) so stderr is captured on BOTH exit 0 and non-zero. The
  // advisory path always exits 0 with the nudge on stderr — execFileSync's "success" branch
  // discards stderr, which silently broke these assertions during the hard→soft migration.
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "devin-hook", event],
    {
      cwd,
      input,
      encoding: "utf8",
      env: extraEnv ? { ...baseEnv, ...extraEnv } : baseEnv,
    },
  );
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("(devin-hook-cli-1) PreToolUse+edit emits advisory (exit 0, stderr names mem_context, NO stdout block envelope)", () => {
  const dir = freshProjectDir();
  try {
    const r = runDevinHook(dir, "PreToolUse", {
      hook_event_name: "PreToolUse",
      tool_name: "edit",
    });
    assert.equal(r.code, 0, "advisory never blocks");
    assert.equal(r.stdout, "", "no stdout block envelope — that was the hard-block protocol");
    assert.match(r.stderr, /memory context/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(devin-hook-cli-2) PostToolUse exec `leina memory context` writes the per-project marker; afterwards PreToolUse+edit emits no advisory", () => {
  const dir = freshProjectDir();
  try {
    const mark = runDevinHook(dir, "PostToolUse", {
      hook_event_name: "PostToolUse",
      tool_name: "exec",
      tool_input: { command: "leina memory context ." },
    });
    assert.equal(mark.code, 0);
    assert.ok(existsSync(join(dir, MARKER_REL)), "session marker written");

    const silent = runDevinHook(dir, "PreToolUse", {
      hook_event_name: "PreToolUse",
      tool_name: "edit",
    });
    assert.equal(silent.code, 0);
    assert.equal(silent.stdout, "");
    assert.equal(silent.stderr, "", "no advisory once marker exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(devin-hook-cli-3) SessionStart injects context and re-arms marker; PreToolUse is silent when marker present", () => {
  const dir = freshProjectDir();
  // Isolated memory home so the test controls what buildActiveContext sees
  const tmpHome = mkdtempSync(join(tmpdir(), "cg-devin-hook-home-"));
  try {
    // PostToolUse writes marker via memory-context detection
    runDevinHook(dir, "PostToolUse", {
      hook_event_name: "PostToolUse",
      tool_name: "exec",
      tool_input: { command: "leina memory context ." },
    }, { LEINA_HOME: tmpHome });
    assert.ok(existsSync(join(dir, MARKER_REL)), "marker written by PostToolUse");

    // SessionStart: deletes marker, injects context, re-arms marker (delivered=true with empty DB)
    const reset = runDevinHook(dir, "SessionStart", { hook_event_name: "SessionStart" }, { LEINA_HOME: tmpHome });
    assert.equal(reset.code, 0);
    // Marker is re-written (injection succeeded with empty DB → delivered=true)
    assert.ok(existsSync(join(dir, MARKER_REL)), "marker re-armed after successful SessionStart injection");
    // additionalContext is emitted on stdout
    assert.ok(reset.stdout.trim().length > 0, "SessionStart emits additionalContext on stdout");
    const parsed = JSON.parse(reset.stdout.trim());
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");

    // Subsequent PreToolUse+edit is SILENT because marker is present (injection loaded context)
    const silent = runDevinHook(dir, "PreToolUse", {
      hook_event_name: "PreToolUse",
      tool_name: "edit",
    }, { LEINA_HOME: tmpHome });
    assert.equal(silent.code, 0);
    assert.equal(silent.stderr, "", "no advisory when marker is present (context was injected)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("(devin-hook-cli-4) PreToolUse+exec `rg foo` emits the GREP advisory (exit 0, stderr names query_graph)", () => {
  const dir = freshProjectDir();
  try {
    const r = runDevinHook(dir, "PreToolUse", {
      hook_event_name: "PreToolUse",
      tool_name: "exec",
      tool_input: { command: "rg foo src" },
    });
    assert.equal(r.code, 0, "advisory never blocks");
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /leina query|leina affected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(devin-hook-cli-5) malformed stdin fails OPEN (exit 0) — never blocks Devin", () => {
  const dir = freshProjectDir();
  try {
    const r = runDevinHook(dir, "PreToolUse", "{ not json");
    assert.equal(r.code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(devin-hook-cli-6) UserPromptSubmit: marker absent → stdout additionalContext JSON + stderr empty; marker present → total silence", () => {
  const dir = freshProjectDir();
  // Isolated memory home so buildActiveContext works with a controlled empty DB
  const tmpHome = mkdtempSync(join(tmpdir(), "cg-devin-hook-home-"));
  try {
    // First call — marker absent → injects additionalContext on stdout, stderr empty
    const injected = runDevinHook(dir, "UserPromptSubmit", { hook_event_name: "UserPromptSubmit" }, { LEINA_HOME: tmpHome });
    assert.equal(injected.code, 0, "user prompts are NEVER blocked");
    assert.equal(injected.stderr, "", "no stderr advisory — injection replaces it");
    assert.ok(injected.stdout.trim().length > 0, "additionalContext emitted on stdout");
    const parsed = JSON.parse(injected.stdout.trim());
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.ok(existsSync(join(dir, MARKER_REL)), "marker written after successful UPS injection");

    // Second call — marker present → total silence
    const silent = runDevinHook(dir, "UserPromptSubmit", { hook_event_name: "UserPromptSubmit" }, { LEINA_HOME: tmpHome });
    assert.equal(silent.code, 0);
    assert.equal(silent.stdout, "", "no stdout when marker already present");
    assert.equal(silent.stderr, "", "no stderr when marker already present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("(devin-hook-cli-scope) silent no-op in a project WITHOUT consent=enabled (user-global hook in unrelated repo)", () => {
  // No freshProjectDir() — bare tmp dir with no consent flag. This is the real-world
  // case that motivated this work: a user-global Devin hook firing in an unrelated repo MUST NOT
  // print advisory text the user doesn't understand.
  const dir = mkdtempSync(join(tmpdir(), "cg-devin-hook-bare-"));
  try {
    const r = runDevinHook(dir, "PreToolUse", { hook_event_name: "PreToolUse", tool_name: "edit" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    const ss = runDevinHook(dir, "SessionStart", { hook_event_name: "SessionStart" });
    assert.equal(ss.code, 0);
    assert.equal(ss.stdout, "", "no SessionStart additionalContext leaks into unrelated repos");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
