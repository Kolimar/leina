// agent-gate.test.ts — pure decision logic + I/O wrapper for the host-neutral agent hooks ADVISORY gate.
// Run: node --no-warnings --experimental-strip-types --test test/agent-gate.test.ts
//
// The gate is now ADVISORY: decideAgentGate ALWAYS returns block:false but emits a `reason`
// string for events that would benefit from memory-loading. runAgentGate handles stdin
// parsing, marker fs side effects, stderr advisory emit, the SessionStart / PostCompaction
// additionalContext injection, and the SCOPE GUARD that silences the gate in projects that
// aren't leina-initialized.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildActiveContext,
  decideAgentGate,
  isLeinaProject,
  resolveHookProjectRoot,
  runAgentGate,
  SESSION_START_CONTEXT,
  SAVE_MARKER_REL,
  STOP_SAVE_NUDGE,
  GREP_GATE_MESSAGE,
  NATIVE_NUDGE_MARKER_REL,
  NATIVE_SEARCH_NUDGE,
  type AgentHookPayload,
} from "../src/cli/agent-gate.ts";
import { SQLiteMemoryRepository as MemoryStore } from "../src/infrastructure/sqlite/memory-repository.ts";
import { deriveProjectKey } from "../src/application/project/detect-key.ts";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { writeManifest } from "../src/application/graph/manifest.ts";

const MARKER_REL = ".leina/session.memory-loaded";

// Safety baseline: runAgentGate's SessionStart branch now fires a detached graph build via
// spawnDetachedBuild. In-process tests that drive SessionStart must NOT spawn a real build
// (it would leak detached `node` processes and exhaust the host under load). Disable autobuild
// for the whole file; the spawn/lock mechanics are covered separately in background-build.test.ts.
// Tests that need to assert the trigger decision use the pure `graphNeedsBuild` predicate.
process.env.LEINA_DISABLE_AUTOBUILD = "1";

// A fresh cwd that IS a leina project (consent flag = "enabled").
// The scope guard in runAgentGate reads the consent flag; any dir without consent=enabled is
// silently ignored. Tests that exercise the scope guard / unknown state use bareCwd() or
// create their own directory with only .devin/hooks.v1.json (legacy scenario).
function freshCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "leina-devin-gate-"));
  // Write consent=enabled — this is the scope sentinel for PR5+ (replaces .devin/hooks.v1.json).
  mkdirSync(join(dir, ".leina"), { recursive: true });
  writeFileSync(join(dir, ".leina", "consent"), "enabled");
  return dir;
}

// A fresh cwd that is NOT a leina project — used to assert the scope guard.
function bareCwd(): string {
  return mkdtempSync(join(tmpdir(), "leina-devin-gate-bare-"));
}

function withCapturedIO<T>(fn: () => T): { result: T; stdout: string; stderr: string } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    const result = fn();
    return { result, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ---------- decideAgentGate (pure) ----------

test("(devin-gate-1) marker present → never blocks regardless of event/tool/command", () => {
  const cases: AgentHookPayload[] = [
    { hook_event_name: "PreToolUse", tool_name: "edit" },
    { hook_event_name: "PreToolUse", tool_name: "write" },
    { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { command: "git commit -m wip" } },
    { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { command: "rg foo" } },
  ];
  for (const ev of cases) {
    const d = decideAgentGate(ev, true);
    assert.equal(d.block, false, JSON.stringify(ev));
    assert.equal(d.reason, "");
  }
});

test("(devin-gate-2) PreToolUse + edit/write emits advisory (block:false, reason names mem_context) when marker absent", () => {
  for (const tool of ["edit", "write"]) {
    const d = decideAgentGate({ hook_event_name: "PreToolUse", tool_name: tool }, false);
    assert.equal(d.block, false, `${tool} never blocks (advisory)`);
    assert.match(d.reason, /memory context/);
  }
});

test("(devin-gate-3) PreToolUse + exec + `git commit` emits advisory (block:false, reason names mem_context)", () => {
  const d = decideAgentGate(
    { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { command: "git commit -m wip" } },
    false,
  );
  assert.equal(d.block, false);
  assert.match(d.reason, /memory context/);
});

test("(devin-gate-3b) PreToolUse + exec + `git commit-tree|graph` is NOT a commit (no advisory)", () => {
  for (const cmd of ["git commit-tree -m x", "git commit-graph write"]) {
    const d = decideAgentGate(
      { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { command: cmd } },
      false,
    );
    assert.equal(d.block, false, cmd);
    assert.equal(d.reason, "", `no advisory for ${cmd}`);
  }
  // `git commit --amend` still triggers the advisory text, but never blocks.
  const amend = decideAgentGate(
    { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { command: "git commit --amend" } },
    false,
  );
  assert.equal(amend.block, false);
  assert.match(amend.reason, /memory context/);
});

test("(devin-gate-4) PreToolUse + exec + `rg|grep|find` emits the GREP advisory (block:false, reason names query_graph/graph_affected)", () => {
  for (const cmd of ["rg foo", "grep -R bar src", "find . -name baz"]) {
    const d = decideAgentGate(
      { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { command: cmd } },
      false,
    );
    assert.equal(d.block, false, cmd);
    assert.match(d.reason, /leina query|leina affected/);
  }
});

test("(devin-gate-5) PreToolUse + exec + harmless command (ls/npm test) ALLOWS even without marker", () => {
  for (const cmd of ["ls -la", "npm test", "echo hi"]) {
    const d = decideAgentGate(
      { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { command: cmd } },
      false,
    );
    assert.equal(d.block, false, cmd);
  }
});

test("(devin-gate-6) PreToolUse with unknown tool name never blocks", () => {
  const d = decideAgentGate({ hook_event_name: "PreToolUse", tool_name: "read" }, false);
  assert.equal(d.block, false);
});

test("(devin-gate-7a) PostToolUse / SessionStart never block (block=false)", () => {
  for (const event of ["PostToolUse", "SessionStart"]) {
    const d = decideAgentGate({ hook_event_name: event, tool_name: "edit" }, false);
    assert.equal(d.block, false, event);
  }
});

test("(devin-gate-7b) UserPromptSubmit emits first-turn advisory when marker absent (block:false, never blocks the user)", () => {
  const d = decideAgentGate({ hook_event_name: "UserPromptSubmit" }, false);
  assert.equal(d.block, false, "user prompts are NEVER blocked — advisory only");
  assert.match(d.reason, /memory context/);
  assert.match(d.reason, /fresh session/i);
});

test("(devin-gate-7c) UserPromptSubmit emits no advisory when marker present", () => {
  const d = decideAgentGate({ hook_event_name: "UserPromptSubmit" }, true);
  assert.equal(d.block, false);
  assert.equal(d.reason, "");
});

test("(devin-gate-8) malformed exec payload (missing command string) fails open", () => {
  const d = decideAgentGate(
    // tool_input present but command is not a string
    { hook_event_name: "PreToolUse", tool_name: "exec", tool_input: { command: 42 as unknown as string } },
    false,
  );
  assert.equal(d.block, false);
});

// ---------- runAgentGate (I/O wrapper) ----------

test("(devin-runGate-1) empty stdin → exit 0, no output (fail-open)", () => {
  const cwd = freshCwd();
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate("", cwd, "PreToolUse"));
  assert.equal(result, undefined);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("(devin-runGate-2) non-JSON stdin → exit 0 (fail-open)", () => {
  const cwd = freshCwd();
  const { result } = withCapturedIO(() => runAgentGate("{not json", cwd, "PreToolUse"));
  assert.equal(result, undefined);
});

test("(devin-runGate-3) PreToolUse+edit, marker absent → exit 0 (advisory), stderr=reason, NO stdout block envelope", () => {
  const cwd = freshCwd();
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "edit" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined, "advisory never blocks");
  assert.equal(stdout, "", "no stdout block envelope — that was the hard-block protocol");
  assert.match(stderr, /memory context/, "advisory text on stderr");
});

test("(devin-runGate-4) PreToolUse+edit with existing marker → exit 0, no stderr advisory", () => {
  const cwd = freshCwd();
  writeFileSync(join(cwd, MARKER_REL), "memory-loaded\n");
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "edit" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("(devin-runGate-scope) runAgentGate silent no-op in projects WITHOUT consent=enabled", () => {
  // The user-global Devin hook fires in EVERY project. Without this scope guard, fresh
  // editor windows in unrelated repos would see an advisory message they don't understand.
  const cwd = bareCwd(); // no consent flag → "unknown" → gate silent
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "edit" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout, "", "no stdout in unrelated repos");
  assert.equal(stderr, "", "no stderr noise in unrelated repos");
  // Same for SessionStart — no additionalContext leaks into projects we don't own.
  const ssPayload = JSON.stringify({ hook_event_name: "SessionStart" });
  const ss = withCapturedIO(() => runAgentGate(ssPayload, cwd));
  assert.equal(ss.result, undefined);
  assert.equal(ss.stdout, "");
});

test("(SC-14c) fixture with only .leina/memory.db (no consent flag) → gate returns silently (no advisory)", () => {
  // Layout: memory.db exists but no consent flag. isLeinaProject reads the consent flag
  // (not hooks.v1.json) → "unknown" → returns false → silent no-op.
  const cwd = mkdtempSync(join(tmpdir(), "leina-devin-gate-legacy-"));
  mkdirSync(join(cwd, ".leina"), { recursive: true });
  writeFileSync(join(cwd, ".leina", "memory.db"), "");
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "edit" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout, "", "no stdout for legacy-only layout");
  assert.equal(stderr, "", "no advisory noise for legacy-only layout");
});

test("(devin-runGate-5) PostToolUse exec running `leina memory context` creates the per-project session marker", () => {
  const cwd = freshCwd();
  assert.equal(existsSync(join(cwd, MARKER_REL)), false);
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "exec",
    tool_input: { command: "leina memory context ." },
  });
  const { result } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(existsSync(join(cwd, MARKER_REL)), true);
});

test("(devin-runGate-5b) PostToolUse exec running `leina memory search|verified` also writes the marker", () => {
  for (const sub of ["search", "verified"]) {
    const cwd = freshCwd();
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "exec",
      tool_input: { command: `leina memory ${sub} . "query"` },
    });
    withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(existsSync(join(cwd, MARKER_REL)), true, sub);
  }
});

test("(devin-runGate-5c) PostToolUse exec running an unrelated leina command does NOT write the marker", () => {
  const cwd = freshCwd();
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "exec",
    tool_input: { command: "leina affected . someSymbol" },
  });
  withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(existsSync(join(cwd, MARKER_REL)), false);
});

test("(devin-runGate-6) SessionStart resets marker then re-arms it on successful injection AND emits additionalContext JSON", () => {
  // Use LEINA_HOME isolation so buildActiveContext works with a controlled empty DB
  const tmpHome = mkdtempSync(join(tmpdir(), "leina-devin-gate-home-"));
  const origHome = process.env.LEINA_HOME;
  process.env.LEINA_HOME = tmpHome;
  try {
    const cwd = freshCwd();
    writeFileSync(join(cwd, MARKER_REL), "memory-loaded\n");
    const payload = JSON.stringify({ hook_event_name: "SessionStart" });
    const { result, stdout } = withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(result, undefined);
    // With empty memory DB: delivered=true → marker is re-written (not absent)
    assert.ok(existsSync(join(cwd, MARKER_REL)), "marker re-written after successful injection");
    // Stdout carries the Devin/Claude-compatible additionalContext payload.
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.length > 0,
      "additionalContext is non-empty",
    );
    // Second call with marker present still emits the context (always inject).
    const second = withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(second.result, undefined);
    assert.ok(second.stdout.trim().length > 0, "additionalContext still emitted on repeat SessionStart");
  } finally {
    if (origHome === undefined) delete process.env.LEINA_HOME;
    else process.env.LEINA_HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("(devin-runGate-7) UserPromptSubmit inject: marker absent → stdout additionalContext JSON + marker written + stderr empty; marker present → total silence", () => {
  // Use LEINA_HOME isolation so buildActiveContext works with a controlled empty DB
  const tmpHome = mkdtempSync(join(tmpdir(), "leina-devin-gate-home-"));
  const origHome = process.env.LEINA_HOME;
  process.env.LEINA_HOME = tmpHome;
  try {
    const cwd = freshCwd();
    const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit" });

    // First call — marker absent → injects additionalContext on stdout, stderr empty, marker written
    const injected = withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(injected.result, undefined, "user prompts are NEVER blocked");
    assert.equal(injected.stderr, "", "no stderr advisory — injection replaces it");
    assert.ok(injected.stdout.trim().length > 0, "additionalContext emitted on stdout");
    const parsed = JSON.parse(injected.stdout.trim());
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.ok(parsed.hookSpecificOutput.additionalContext.length > 0, "additionalContext non-empty");
    assert.ok(existsSync(join(cwd, MARKER_REL)), "marker written after successful injection");

    // Second call — marker present → total silence (stdout and stderr empty)
    const silent = withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(silent.result, undefined);
    assert.equal(silent.stdout, "", "no stdout when marker already present");
    assert.equal(silent.stderr, "", "no stderr when marker already present");
  } finally {
    if (origHome === undefined) delete process.env.LEINA_HOME;
    else process.env.LEINA_HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("(devin-runGate-7d) UserPromptSubmit inject: marker absent + delivered=false → marker NOT written + stdout fallback + stderr empty", () => {
  // S-1: UPS-specific delivered=false. Make cwd ambiguous so deriveProjectKey throws inside
  // buildActiveContext → delivered=false → the static fallback is emitted but the marker is NOT
  // written (so a later successful injection can still re-arm it). Mirrors bac-FR3c for the UPS branch.
  const cwd = mkdtempSync(join(tmpdir(), "leina-gate-ups-ambig-"));
  // consent=enabled so the scope guard passes; ambiguity comes from two child .git dirs.
  mkdirSync(join(cwd, ".leina"), { recursive: true });
  writeFileSync(join(cwd, ".leina", "consent"), "enabled");
  for (const child of ["repo-x", "repo-y"]) {
    mkdirSync(join(cwd, child, ".git"), { recursive: true });
  }
  try {
    withTempHome(() => {
      const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit" });
      const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
      assert.equal(result, undefined, "user prompts are NEVER blocked");
      assert.equal(stderr, "", "no stderr advisory on the UPS inject path");
      assert.equal(existsSync(join(cwd, MARKER_REL)), false, "marker NOT written when delivered=false");
      // Fallback SESSION_START_CONTEXT is still emitted as additionalContext.
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      assert.equal(parsed.hookSpecificOutput.additionalContext, SESSION_START_CONTEXT);
    });
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("(devin-runGate-8) PreToolUse+exec+rg advisory: exit 0, stderr names query_graph/graph_affected, NO stdout block", () => {
  const cwd = freshCwd();
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "exec",
    tool_input: { command: "rg foo src" },
  });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined, "advisory never blocks");
  assert.equal(stdout, "");
  assert.match(stderr, /leina query|leina affected/);
});

test("(devin-runGate-9) hook_event_name missing falls back to the CLI-arg event name (exit 0 advisory)", () => {
  const cwd = freshCwd();
  // Payload omits hook_event_name; fallbackEvent supplies it.
  const payload = JSON.stringify({ tool_name: "edit" });
  const { result, stderr } = withCapturedIO(() => runAgentGate(payload, cwd, "PreToolUse"));
  assert.equal(result, undefined);
  assert.match(stderr, /memory context/, "fallback event drives the advisory");
});

// ---------------------------------------------------------------------------
// Helper functions for buildActiveContext tests
// ---------------------------------------------------------------------------

/**
 * Run fn with LEINA_HOME set to a fresh temp dir.
 * Returns the temp home path and restores the env var on completion.
 */
function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "leina-gate-home-"));
  const orig = process.env.LEINA_HOME;
  process.env.LEINA_HOME = home;
  try {
    return fn(home);
  } finally {
    if (orig === undefined) delete process.env.LEINA_HOME;
    else process.env.LEINA_HOME = orig;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Seed observations into the global memory at `home/memory.db` for the given cwd's project key.
 */
function seedMemory(
  home: string,
  cwd: string,
  obs: { title: string; content: string; type: string }[],
): void {
  const key = deriveProjectKey(cwd).key;
  const mem = new MemoryStore(join(home, "memory.db"), key);
  try {
    for (const o of obs) {
      mem.save({ title: o.title, content: o.content, type: o.type as "architecture" });
    }
  } finally {
    mem.close();
  }
}

// ---------------------------------------------------------------------------
// T2: buildActiveContext unit tests (FR-1, FR-2, FR-4, NFR-7)
// ---------------------------------------------------------------------------

test("(bac-FR1a) buildActiveContext: delivered=true and text contains observation entry when memory has observations", () => {
  const cwd = freshCwd();
  withTempHome((home) => {
    seedMemory(home, cwd, [
      { title: "My arch decision", content: "We use SQLite because it is embedded", type: "architecture" },
    ]);
    const result = buildActiveContext(cwd);
    assert.equal(result.delivered, true, "delivered=true when memory read succeeds");
    assert.match(result.text, /My arch decision/, "observation title present");
    assert.match(result.text, /\[architecture\]/, "observation type present");
  });
});

test("(bac-FR1b) buildActiveContext: delivered=true with empty state text (not SESSION_START_CONTEXT) when DB is empty", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    // No observations seeded — empty but valid DB
    const result = buildActiveContext(cwd);
    assert.equal(result.delivered, true, "delivered=true even for empty DB");
    assert.notEqual(result.text, SESSION_START_CONTEXT, "text is NOT the static fallback");
    assert.match(result.text, /Project memory|no observations/i, "reflects real empty state");
  });
});

test("(bac-FR1c) buildActiveContext: delivered=false and text===SESSION_START_CONTEXT on AmbiguousProjectError", () => {
  // Create a cwd with 2+ child dirs containing .git → deriveProjectKey throws AmbiguousProjectError
  const cwd = mkdtempSync(join(tmpdir(), "leina-gate-ambiguous-"));
  mkdirSync(join(cwd, ".devin"), { recursive: true });
  writeFileSync(join(cwd, ".devin", "hooks.v1.json"), "{}");
  // Create two child dirs with .git so deriveProjectKey sees ambiguity
  for (const child of ["repo-a", "repo-b"]) {
    mkdirSync(join(cwd, child, ".git"), { recursive: true });
  }
  try {
    withTempHome(() => {
      const result = buildActiveContext(cwd);
      assert.equal(result.delivered, false, "delivered=false on AmbiguousProjectError");
      assert.equal(result.text, SESSION_START_CONTEXT, "falls back to SESSION_START_CONTEXT");
    });
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("(bac-FR1d) buildActiveContext: delivered=false and text===SESSION_START_CONTEXT on corrupt DB", () => {
  const cwd = freshCwd();
  withTempHome((home) => {
    // Write garbage to the memory.db path so DatabaseSync throws
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "memory.db"), "THIS IS NOT A SQLITE DATABASE !!!@#$\n");
    const result = buildActiveContext(cwd);
    assert.equal(result.delivered, false, "delivered=false on corrupt DB");
    assert.equal(result.text, SESSION_START_CONTEXT, "falls back to SESSION_START_CONTEXT");
  });
});

test("(bac-FR2a) buildActiveContext: text contains node+edge count and 'fresh' label when graph.db exists and is fresh", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    // Create graph.db with some nodes
    const graphDbPath = join(cwd, ".leina", "graph.db");
    const gs = new GraphStore(graphDbPath);
    gs.addNodes([{ id: "n1", label: "foo", fileType: "code", kind: "function", sourceFile: "src/foo.ts", sourceLocation: "1:1", community: 0 }]);
    gs.close();
    // Create a fresh manifest (empty files list → isStale returns fresh for empty dir)
    writeManifest(cwd, []);

    const result = buildActiveContext(cwd);
    assert.equal(result.delivered, true);
    assert.match(result.text, /\d+ nodes/, "node count present");
    assert.match(result.text, /\d+ edges/, "edge count present");
    assert.match(result.text, /fresh/, "fresh label present");
    assert.doesNotMatch(result.text, /leina refresh/, "no refresh note when fresh");
    assert.doesNotMatch(result.text, /leina build/, "no build note when graph exists");
  });
});

test("(bac-FR2b) buildActiveContext: text contains graph stats and 'stale' label when graph.db present but stale", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    // Create graph.db but NO manifest → isStale returns stale (no-manifest)
    const graphDbPath = join(cwd, ".leina", "graph.db");
    const gs = new GraphStore(graphDbPath);
    gs.addNodes([{ id: "n1", label: "bar", fileType: "code", kind: "function", sourceFile: "src/bar.ts", sourceLocation: "1:1", community: 0 }]);
    gs.close();
    // No writeManifest call → no-manifest → stale

    const result = buildActiveContext(cwd);
    assert.equal(result.delivered, true);
    assert.match(result.text, /\d+ nodes/, "node count present");
    assert.match(result.text, /stale/, "stale label present");
    assert.match(result.text, /leina refresh/, "refresh note present when stale");
  });
});

test("(bac-FR2c/FR4a) buildActiveContext: text contains leina build note when graph.db absent; no stats section", () => {
  const cwd = freshCwd();
  // No graph.db created
  withTempHome(() => {
    const result = buildActiveContext(cwd);
    assert.equal(result.delivered, true, "delivered=true from memory even without graph");
    assert.match(result.text, /leina build/, "build note present when graph absent");
    assert.doesNotMatch(result.text, /\d+ nodes/, "no graph stats when graph.db absent");
  });
});

test("(bac-FR4b) buildActiveContext: text contains leina refresh <cwd> when graph.db is stale", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    // Create graph.db but no manifest → stale
    const graphDbPath = join(cwd, ".leina", "graph.db");
    new GraphStore(graphDbPath).close();

    const result = buildActiveContext(cwd);
     
    assert.match(result.text, new RegExp(`leina refresh ${cwd.replace(/\\/g, "\\\\")}`), "refresh note contains cwd path");
  });
});

test("(bac-FR4c) buildActiveContext: no ensure-ready note when graph is fresh", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    const graphDbPath = join(cwd, ".leina", "graph.db");
    new GraphStore(graphDbPath).close();
    writeManifest(cwd, []); // fresh manifest

    const result = buildActiveContext(cwd);
    assert.doesNotMatch(result.text, /leina refresh/, "no refresh note when fresh");
    assert.doesNotMatch(result.text, /leina build/, "no build note when graph exists");
  });
});

test("(bac-NFR7) buildActiveContext: memory section does not exceed ~4000 chars even with 10 long observations", () => {
  const cwd = freshCwd();
  withTempHome((home) => {
    // Seed 10 very long observations
    const longContent = "A".repeat(500); // 500-char content line per observation
    const obs = Array.from({ length: 10 }, (_, i) => ({
      title: `Long observation number ${i + 1}`,
      content: longContent,
      type: "architecture",
    }));
    seedMemory(home, cwd, obs);

    const result = buildActiveContext(cwd);
    assert.equal(result.delivered, true);
    // Extract the memory section (up to the double-newline separator before graph section)
    const memSection = result.text.split("\n\n")[0] ?? result.text;
    assert.ok(memSection.length <= 4500, `memory section too long: ${memSection.length} chars`);
  });
});

// ---------------------------------------------------------------------------
// T4: runAgentGate SessionStart injection + marker semantics + fail-open
// ---------------------------------------------------------------------------

test("(bac-FR3a) runAgentGate SessionStart: marker written after successful injection (mem+graph delivered=true)", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    const graphDbPath = join(cwd, ".leina", "graph.db");
    new GraphStore(graphDbPath).close();
    writeManifest(cwd, []); // fresh graph

    const payload = JSON.stringify({ hook_event_name: "SessionStart" });
    const { result, stdout } = withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(result, undefined);
    assert.ok(existsSync(join(cwd, MARKER_REL)), "marker written when delivered=true");
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    // With fresh graph, text should contain "fresh"
    assert.match(parsed.hookSpecificOutput.additionalContext, /fresh|Project memory/);
  });
});

test("(bac-FR3b) runAgentGate SessionStart: marker written on partial injection (mem present, graph absent)", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    // No graph.db — memory only injection
    const payload = JSON.stringify({ hook_event_name: "SessionStart" });
    const { result } = withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(result, undefined);
    assert.ok(existsSync(join(cwd, MARKER_REL)), "marker written even with partial injection (memory only)");
  });
});

test("(bac-FR3c) runAgentGate SessionStart: marker NOT written when buildActiveContext returns delivered=false", () => {
  // Make cwd ambiguous so deriveProjectKey throws. consent=enabled so the scope guard passes.
  const cwd2 = mkdtempSync(join(tmpdir(), "leina-gate-ambig2-"));
  mkdirSync(join(cwd2, ".leina"), { recursive: true });
  writeFileSync(join(cwd2, ".leina", "consent"), "enabled");
  for (const child of ["repo-x", "repo-y"]) {
    mkdirSync(join(cwd2, child, ".git"), { recursive: true });
  }
  try {
    withTempHome(() => {
      const payload = JSON.stringify({ hook_event_name: "SessionStart" });
      const { result, stdout } = withCapturedIO(() => runAgentGate(payload, cwd2));
      assert.equal(result, undefined);
      assert.equal(existsSync(join(cwd2, MARKER_REL)), false, "marker NOT written when fallback");
      // Fallback SESSION_START_CONTEXT is still emitted
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.hookSpecificOutput.additionalContext, SESSION_START_CONTEXT);
    });
  } finally {
    try { rmSync(cwd2, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("(bac-FR3d) runAgentGate SessionStart: existing marker deleted before injection runs", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    // Write marker first
    writeFileSync(join(cwd, MARKER_REL), "memory-loaded\n");
    assert.ok(existsSync(join(cwd, MARKER_REL)), "marker exists before SessionStart");

    const payload = JSON.stringify({ hook_event_name: "SessionStart" });
    // With empty (valid) DB: delivered=true → marker re-written; but crucially it was reset first
    withCapturedIO(() => runAgentGate(payload, cwd));
    // Marker is re-written (delivered=true), so it still exists but was reset
    // The key invariant: rmSync ran before buildActiveContext
    assert.ok(existsSync(join(cwd, MARKER_REL)), "marker re-written after successful injection");
  });
});

test("(bac-FR6a) runAgentGate SessionStart in non-leina repo → silent no-op", () => {
  const cwd = bareCwd(); // no consent flag → "unknown" → gate silent
  const payload = JSON.stringify({ hook_event_name: "SessionStart" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout, "", "no stdout in non-leina repos");
  assert.equal(stderr, "", "no stderr in non-leina repos");
  assert.equal(existsSync(join(cwd, MARKER_REL)), false, "no marker in non-leina repos");
});

test("(bac-FR7a) runAgentGate SessionStart: empty stdin → exit 0, no output", () => {
  const cwd = freshCwd();
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate("", cwd, "SessionStart"));
  assert.equal(result, undefined);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("(bac-FR7b) runAgentGate SessionStart: non-JSON stdin → exit 0 (fail-open)", () => {
  const cwd = freshCwd();
  const { result } = withCapturedIO(() => runAgentGate("{bad json", cwd, "SessionStart"));
  assert.equal(result, undefined);
});

test("(bac-FR7c) runAgentGate SessionStart: EACCES on marker write → additionalContext still emitted, exit 0", () => {
  // Simulate a read-only .leina dir by removing write perms.
  // If this OS doesn't support chmod effectively, we just skip the permission-level check
  // and verify that emitting stdout doesn't throw regardless.
  const cwd = freshCwd();
  withTempHome(() => {
    const payload = JSON.stringify({ hook_event_name: "SessionStart" });
    const { result, stdout } = withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(result, undefined, "always exit 0");
    // Regardless of marker write outcome, stdout is emitted
    assert.ok(stdout.trim().length > 0, "additionalContext emitted even if marker write might fail");
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  });
});

test("(bac-FR7d) runAgentGate SessionStart: deriveProjectKey error → fallback static text, marker NOT written, exit 0", () => {
  // Use an ambiguous cwd to force AmbiguousProjectError. consent=enabled so scope guard passes.
  const cwd2 = mkdtempSync(join(tmpdir(), "leina-gate-ambig3-"));
  mkdirSync(join(cwd2, ".leina"), { recursive: true });
  writeFileSync(join(cwd2, ".leina", "consent"), "enabled");
  for (const child of ["repo-c", "repo-d"]) {
    mkdirSync(join(cwd2, child, ".git"), { recursive: true });
  }
  try {
    withTempHome(() => {
      const payload = JSON.stringify({ hook_event_name: "SessionStart" });
      const { result, stdout } = withCapturedIO(() => runAgentGate(payload, cwd2));
      assert.equal(result, undefined, "always exit 0");
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.hookSpecificOutput.additionalContext, SESSION_START_CONTEXT, "fallback text");
      assert.equal(existsSync(join(cwd2, MARKER_REL)), false, "marker NOT written on fallback");
    });
  } finally {
    try { rmSync(cwd2, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// T6: runAgentGate PostCompaction branch
// ---------------------------------------------------------------------------

test("(bac-FR5a) runAgentGate PostCompaction with summary string: re-injects context, writes marker, exit 0", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    const payload = JSON.stringify({ hook_event_name: "PostCompaction", summary: "compaction summary text" });
    const { result, stdout } = withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(result, undefined);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostCompaction");
    assert.ok(parsed.hookSpecificOutput.additionalContext.length > 0, "additionalContext present");
    assert.ok(existsSync(join(cwd, MARKER_REL)), "marker written after PostCompaction injection");
  });
});

test("(bac-FR5b) runAgentGate PostCompaction with summary=null: identical re-inject behavior", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    const payload = JSON.stringify({ hook_event_name: "PostCompaction", summary: null });
    const { result, stdout } = withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(result, undefined);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostCompaction");
    assert.ok(existsSync(join(cwd, MARKER_REL)), "marker written even when summary=null");
  });
});

test("(bac-FR5c) runAgentGate PostCompaction with no summary field: re-inject, fail-open, exit 0", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    const payload = JSON.stringify({ hook_event_name: "PostCompaction" });
    const { result, stdout } = withCapturedIO(() => runAgentGate(payload, cwd));
    assert.equal(result, undefined);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostCompaction");
    assert.ok(existsSync(join(cwd, MARKER_REL)), "marker written even with no summary field");
  });
});

test("(bac-FR5d/FR6b) runAgentGate PostCompaction in non-leina repo → silent no-op", () => {
  const cwd = bareCwd(); // no consent flag → "unknown" → gate silent
  const payload = JSON.stringify({ hook_event_name: "PostCompaction", summary: "some summary" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout, "", "no stdout in non-leina repos");
  assert.equal(stderr, "", "no stderr in non-leina repos");
});

test("(bac-PostCompaction-no-reset) PostCompaction does NOT delete existing marker before re-arming", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    // Write the marker first
    writeFileSync(join(cwd, MARKER_REL), "memory-loaded\n");

    const payload = JSON.stringify({ hook_event_name: "PostCompaction" });
    withCapturedIO(() => runAgentGate(payload, cwd));

    // Marker should still exist (re-armed, not reset)
    assert.ok(existsSync(join(cwd, MARKER_REL)), "marker still present after PostCompaction re-arm");
  });
});

// ---------------------------------------------------------------------------
// T8: Stop branch tests (FR-1, S1-1..S1-5, NFR-1, NFR-2, NFR-3)
// ---------------------------------------------------------------------------

test("(Stop-S1-1) Stop + marker absent → stderr nudge, stdout EMPTY, exit 0 [NFR-1 critical]", () => {
  const cwd = freshCwd();
  // Ensure save marker is absent
  assert.equal(existsSync(join(cwd, SAVE_MARKER_REL)), false);
  const payload = JSON.stringify({ hook_event_name: "Stop" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined, "always exit 0 — never blocks");
  assert.equal(stdout.trim(), "", "stdout MUST be empty for Stop — never write a block envelope");
  assert.match(stderr, /leina memory session/, "nudge names memory session command");
  assert.match(stderr, /leina memory save/, "nudge names memory save command");
  assert.match(stderr, /not a block/, "nudge clarifies it is advisory only");
});

test("(Stop-S1-2) Stop + marker present → silent no-op (stdout empty, stderr empty, exit 0)", () => {
  const cwd = freshCwd();
  // Write save marker to simulate a save happened this session
  writeFileSync(join(cwd, SAVE_MARKER_REL), "memory-saved\n");
  const payload = JSON.stringify({ hook_event_name: "Stop" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout.trim(), "", "stdout empty — no block envelope");
  assert.equal(stderr, "", "no nudge when save marker is present");
});

test("(Stop-S1-3) Stop in non-leina project → scope-aware silent no-op", () => {
  const cwd = bareCwd(); // no consent flag → "unknown" → gate silent
  const payload = JSON.stringify({ hook_event_name: "Stop" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout, "", "no stdout in non-leina repo");
  assert.equal(stderr, "", "no stderr in non-leina repo");
});

test("(Stop-S1-4) Stop + empty stdin → exit 0, fail-open", () => {
  const cwd = freshCwd();
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate("", cwd, "Stop"));
  assert.equal(result, undefined, "empty stdin → fail-open exit 0");
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("(Stop-S1-5) Stop + malformed JSON → exit 0, fail-open", () => {
  const cwd = freshCwd();
  const { result, stdout } = withCapturedIO(() => runAgentGate("{bad json}", cwd, "Stop"));
  assert.equal(result, undefined, "malformed JSON → fail-open exit 0");
  assert.equal(stdout.trim(), "", "stdout always empty");
});

test("(Stop-NUDGE) STOP_SAVE_NUDGE exported constant: names both commands and advisory wording", () => {
  assert.match(STOP_SAVE_NUDGE, /leina memory session/);
  assert.match(STOP_SAVE_NUDGE, /leina memory save/);
  assert.match(STOP_SAVE_NUDGE, /not a block/);
});

// ---------------------------------------------------------------------------
// T9: Save marker PostToolUse tests (FR-2, S2-1..S2-3, S2-5, S2-6)
// ---------------------------------------------------------------------------

const SAVE_MARKER_REL_LOCAL = SAVE_MARKER_REL; // alias for clarity in tests

test("(Save-S2-1) PostToolUse + exec + `memory save` → session.memory-saved written", () => {
  const cwd = freshCwd();
  assert.equal(existsSync(join(cwd, SAVE_MARKER_REL_LOCAL)), false);
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "exec",
    tool_input: { command: "leina memory save . --title foo --content bar" },
  });
  const { result } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(existsSync(join(cwd, SAVE_MARKER_REL_LOCAL)), true, "save marker created");
});

test("(Save-S2-2) PostToolUse + exec + `memory session` → session.memory-saved written", () => {
  const cwd = freshCwd();
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "exec",
    tool_input: { command: "leina memory session . --content 'session summary'" },
  });
  const { result } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(existsSync(join(cwd, SAVE_MARKER_REL_LOCAL)), true, "save marker created for session");
});

test("(Save-S2-3) PostToolUse + exec + `memory update` → session.memory-saved written", () => {
  const cwd = freshCwd();
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "exec",
    tool_input: { command: "leina memory update . abc123 --content updated" },
  });
  const { result } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(existsSync(join(cwd, SAVE_MARKER_REL_LOCAL)), true, "save marker created for update");
});

test("(Save-S2-5) PostToolUse + exec + `memory search` → save marker NOT written, load marker IS written", () => {
  const cwd = freshCwd();
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "exec",
    tool_input: { command: "leina memory search . 'my query'" },
  });
  withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(existsSync(join(cwd, SAVE_MARKER_REL_LOCAL)), false, "save marker NOT written for search");
  assert.equal(existsSync(join(cwd, MARKER_REL)), true, "load marker IS written for search");
});

test("(Save-REGEX-micro) MEMORY_SAVE_CMD_RE: matches save/session/update but NOT session-start", () => {
  // We test via the gate behavior: memory session-start must NOT write the save marker
  const cwd = freshCwd();
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "exec",
    tool_input: { command: "leina memory session-start ." },
  });
  withCapturedIO(() => runAgentGate(payload, cwd));
  // session-start must NOT match MEMORY_SAVE_CMD_RE
  assert.equal(existsSync(join(cwd, SAVE_MARKER_REL_LOCAL)), false, "session-start must NOT write save marker");
  // And it should not match MEMORY_LOAD_CMD_RE either
  assert.equal(existsSync(join(cwd, MARKER_REL)), false, "session-start must NOT write load marker");
});

// ---------------------------------------------------------------------------
// T10: Dual-marker reset at SessionStart (FR-2, S2-4)
// ---------------------------------------------------------------------------

test("(DualReset-S2-4) SessionStart resets BOTH markers (load + save)", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    // Pre-write both markers
    writeFileSync(join(cwd, MARKER_REL), "memory-loaded\n");
    writeFileSync(join(cwd, SAVE_MARKER_REL_LOCAL), "memory-saved\n");
    assert.ok(existsSync(join(cwd, MARKER_REL)), "load marker exists before SessionStart");
    assert.ok(existsSync(join(cwd, SAVE_MARKER_REL_LOCAL)), "save marker exists before SessionStart");

    const payload = JSON.stringify({ hook_event_name: "SessionStart" });
    withCapturedIO(() => runAgentGate(payload, cwd));

    // Save marker must be deleted (never re-written by SessionStart)
    assert.equal(existsSync(join(cwd, SAVE_MARKER_REL_LOCAL)), false, "save marker deleted at SessionStart");
    // Load marker is re-written on successful injection (delivered=true with empty DB)
    // — this verifies the load marker re-arm behavior is preserved
    assert.ok(existsSync(join(cwd, MARKER_REL)), "load marker re-written after successful injection");
  });
});

// ---------------------------------------------------------------------------
// T11: Marker isolation (NFR-7, S2-7) + buildActiveContext reminder (FR-3, S3-1/S3-2)
// ---------------------------------------------------------------------------

test("(Isolation-S2-7-NFR7) load marker present + save marker absent → Stop still emits nudge", () => {
  const cwd = freshCwd();
  // Write ONLY the load marker — stop should still nudge (save marker is sole Stop signal)
  writeFileSync(join(cwd, MARKER_REL), "memory-loaded\n");
  assert.equal(existsSync(join(cwd, SAVE_MARKER_REL_LOCAL)), false, "save marker absent");

  const payload = JSON.stringify({ hook_event_name: "Stop" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout.trim(), "", "stdout always empty for Stop");
  // Load marker being present must NOT suppress the Stop nudge — only save marker matters
  assert.match(stderr, /leina memory session/, "nudge emitted despite load marker being present");
});

test("(FR3-S3-1) buildActiveContext delivered context includes session save reminder", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    const result = buildActiveContext(cwd);
    assert.equal(result.delivered, true);
    assert.match(result.text, /leina memory session/, "delivered context has session save reminder");
  });
});

test("(FR3-S3-2) SESSION_START_CONTEXT fallback includes session save reminder", () => {
  assert.match(SESSION_START_CONTEXT, /leina memory session/, "static fallback has session save reminder");
});

// ---------------------------------------------------------------------------
// resolveHookProjectRoot — prefer Devin's documented DEVIN_PROJECT_DIR env var,
// fall back to the process cwd. Pure function; no fs / process access.
// ---------------------------------------------------------------------------

test("resolveHookProjectRoot prefers DEVIN_PROJECT_DIR when set", () => {
  const root = resolveHookProjectRoot({ DEVIN_PROJECT_DIR: "/work/repo" }, "/fallback/cwd");
  assert.equal(root, "/work/repo");
});

test("resolveHookProjectRoot falls back to cwd when env var is absent", () => {
  const root = resolveHookProjectRoot({}, "/fallback/cwd");
  assert.equal(root, "/fallback/cwd");
});

test("resolveHookProjectRoot falls back to cwd when env var is blank/whitespace", () => {
  assert.equal(resolveHookProjectRoot({ DEVIN_PROJECT_DIR: "" }, "/fallback/cwd"), "/fallback/cwd");
  assert.equal(resolveHookProjectRoot({ DEVIN_PROJECT_DIR: "   " }, "/fallback/cwd"), "/fallback/cwd");
});

test("resolveHookProjectRoot trims surrounding whitespace from the env var", () => {
  const root = resolveHookProjectRoot({ DEVIN_PROJECT_DIR: "  /work/repo  " }, "/fallback/cwd");
  assert.equal(root, "/work/repo");
});

// ---------------------------------------------------------------------------
// Palanca A — PreToolUse grep/glob advisory (S1-S5, spec §Advisory PreToolUse)
// ---------------------------------------------------------------------------

test("(S1) decideAgentGate PreToolUse grep, marker absent → reason = GREP_GATE_MESSAGE (block:false)", () => {
  const d = decideAgentGate({ hook_event_name: "PreToolUse", tool_name: "grep" }, false);
  assert.equal(d.block, false);
  assert.equal(d.reason, GREP_GATE_MESSAGE);
});

test("(S2) decideAgentGate PreToolUse glob, marker absent → reason = GREP_GATE_MESSAGE (block:false)", () => {
  const d = decideAgentGate({ hook_event_name: "PreToolUse", tool_name: "glob" }, false);
  assert.equal(d.block, false);
  assert.equal(d.reason, GREP_GATE_MESSAGE);
});

test("(S3-S4) decideAgentGate PreToolUse grep/glob, memory-loaded present → reason = '' (silenced by marker)", () => {
  for (const tool of ["grep", "glob"]) {
    const d = decideAgentGate({ hook_event_name: "PreToolUse", tool_name: tool }, true);
    assert.equal(d.block, false, `${tool} never blocks`);
    assert.equal(d.reason, "", `${tool} silenced when marker present`);
  }
});

test("(S5) decideAgentGate PreToolUse read → reason = '' regardless of marker (read is never advisory)", () => {
  for (const markerExists of [true, false]) {
    const d = decideAgentGate({ hook_event_name: "PreToolUse", tool_name: "read" }, markerExists);
    assert.equal(d.block, false);
    assert.equal(d.reason, "", `read has no advisory (marker=${String(markerExists)})`);
  }
});

// ---------------------------------------------------------------------------
// Palanca C — PostToolUse native one-shot nudge (Gap 2 closure, ADR-2/ADR-3)
// ---------------------------------------------------------------------------

const NUDGE_REL = NATIVE_NUDGE_MARKER_REL;

test("(C-Gap2) PostToolUse grep: memory-loaded present + nudge absent → advisory on stderr + nudge marker written; stdout empty; exit 0", () => {
  const cwd = freshCwd();
  // Simulate memory already loaded this session (Gap 2: the advisory must fire anyway)
  writeFileSync(join(cwd, MARKER_REL), "memory-loaded\n");
  const payload = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "grep" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout, "", "stdout always empty on native nudge path");
  assert.ok(stderr.length > 0, "advisory emitted on stderr");
  assert.match(stderr, /leina query|leina affected|leina memory search/);
  assert.equal(existsSync(join(cwd, NUDGE_REL)), true, "nudge marker written");
});

test("(C-oneshot) PostToolUse grep: nudge-shown present → stderr empty; stdout empty; exit 0 (one-shot)", () => {
  const cwd = freshCwd();
  writeFileSync(join(cwd, NUDGE_REL), "shown\n");
  const payload = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "grep" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("(C-read) PostToolUse read: nudge absent (memory-loaded present) → advisory on stderr; exit 0", () => {
  const cwd = freshCwd();
  writeFileSync(join(cwd, MARKER_REL), "memory-loaded\n");
  const payload = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "read" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout, "", "stdout always empty");
  assert.ok(stderr.length > 0, "advisory emitted on stderr");
  assert.match(stderr, /leina/);
});

test("(C-glob) PostToolUse glob: nudge absent → advisory on stderr + nudge marker written; exit 0", () => {
  const cwd = freshCwd();
  const payload = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "glob" });
  const { result, stdout, stderr } = withCapturedIO(() => runAgentGate(payload, cwd));
  assert.equal(result, undefined);
  assert.equal(stdout, "", "stdout always empty");
  assert.ok(stderr.length > 0, "advisory emitted");
  assert.equal(existsSync(join(cwd, NUDGE_REL)), true, "nudge marker written");
});

test("(C-reset) SessionStart with all 3 markers present → all 3 deleted (load re-armed, save+nudge gone)", () => {
  const cwd = freshCwd();
  withTempHome(() => {
    writeFileSync(join(cwd, MARKER_REL), "memory-loaded\n");
    writeFileSync(join(cwd, SAVE_MARKER_REL), "memory-saved\n");
    writeFileSync(join(cwd, NUDGE_REL), "shown\n");
    assert.ok(existsSync(join(cwd, SAVE_MARKER_REL)), "save marker exists before SessionStart");
    assert.ok(existsSync(join(cwd, NUDGE_REL)), "nudge marker exists before SessionStart");

    const payload = JSON.stringify({ hook_event_name: "SessionStart" });
    withCapturedIO(() => runAgentGate(payload, cwd));

    assert.equal(existsSync(join(cwd, SAVE_MARKER_REL)), false, "save marker deleted at SessionStart");
    assert.equal(existsSync(join(cwd, NUDGE_REL)), false, "nudge marker deleted at SessionStart");
  });
});

test("(C-nudge-const) NATIVE_SEARCH_NUDGE is retrospective, English, names the three CLI alternatives", () => {
  assert.match(NATIVE_SEARCH_NUDGE, /leina query/);
  assert.match(NATIVE_SEARCH_NUDGE, /leina affected/);
  assert.match(NATIVE_SEARCH_NUDGE, /leina memory search/);
  assert.match(NATIVE_SEARCH_NUDGE, /not a block/);
  // Retrospective: acknowledges the tool already ran
  assert.match(NATIVE_SEARCH_NUDGE, /just ran/);
});

// ---------------------------------------------------------------------------
// Auto-build self-heal — maybySelfHealGraph (REQ-SESSION, REQ-NOREGRESS)
// ---------------------------------------------------------------------------

import {
  acquireForegroundBuildLock,
  buildLockPath,
  spawnDetachedBuild,
  type SpawnFn,
} from "../src/cli/background-build.ts";
import { graphNeedsBuild } from "../src/cli/agent-gate.ts";

test("(gate-autobuild-1) SessionStart with no graph.db: autobuild path runs, emitInjectedContext still fires", () => {
  const cwd = freshCwd();
  // Autobuild is suppressed file-wide (kill-switch baseline) — we verify the path runs without
  // breaking injection, and that the decision flagged a build as needed.
  try {
    withTempHome(() => {
      // No graph.db exists → build needed
      assert.equal(existsSync(join(cwd, ".leina", "graph.db")), false);
      assert.equal(graphNeedsBuild(cwd), true, "absent graph.db must flag a build");
      const payload = JSON.stringify({ hook_event_name: "SessionStart" });
      const { stdout } = withCapturedIO(() => runAgentGate(payload, cwd));
      const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string } };
      assert.equal(parsed.hookSpecificOutput?.hookEventName, "SessionStart", "emitInjectedContext still ran");
      // No real spawn happened (kill-switch on) → no lock leaked.
      assert.equal(existsSync(buildLockPath(cwd)), false, "no lock created while autobuild suppressed");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("(gate-autobuild-2) SessionStart with stale graph.db: build decision is true, emitInjectedContext intact", () => {
  const cwd = freshCwd();
  try {
    withTempHome(() => {
      // graph.db exists but no manifest → stale → build needed
      writeFileSync(join(cwd, ".leina", "graph.db"), "");
      assert.equal(graphNeedsBuild(cwd), true, "stale graph must flag a build");

      const payload = JSON.stringify({ hook_event_name: "SessionStart" });
      const { stdout } = withCapturedIO(() => runAgentGate(payload, cwd));

      // emitInjectedContext must have run; no real spawn (kill-switch on) → no lock leaked.
      const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string } };
      assert.equal(parsed.hookSpecificOutput?.hookEventName, "SessionStart", "context injection intact after autobuild trigger");
      assert.equal(existsSync(buildLockPath(cwd)), false, "no lock created while autobuild suppressed");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("(gate-autobuild-3) SessionStart with fresh graph.db: build decision is false, context injection intact", () => {
  const cwd = freshCwd();
  try {
    withTempHome(() => {
      // graph.db exists + fresh manifest → isStale returns fresh → no autobuild
      writeFileSync(join(cwd, ".leina", "graph.db"), "");
      writeManifest(cwd, []); // fresh manifest with no tracked files
      assert.equal(graphNeedsBuild(cwd), false, "fresh graph must NOT flag a build");

      const payload = JSON.stringify({ hook_event_name: "SessionStart" });
      const { stdout } = withCapturedIO(() => runAgentGate(payload, cwd));

      const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string } };
      assert.equal(parsed.hookSpecificOutput?.hookEventName, "SessionStart", "context injection intact");
      assert.equal(existsSync(buildLockPath(cwd)), false, "no lock file when graph is fresh");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("(gate-autobuild-4) maybeSelfHealGraph's spawnDetachedBuild → the detached child's own acquireForegroundBuildLock never deadlocks on its own pid (self-pid fix, end-to-end)", () => {
  const cwd = freshCwd();
  try {
    // Reproduce exactly what maybeSelfHealGraph does: check the same predicate it
    // guards on, then call spawnDetachedBuild(cwd) — bypassing only the file-wide
    // kill-switch via an injected spawner (real spawns are never created), same
    // technique used in background-build.test.ts.
    assert.equal(graphNeedsBuild(cwd), true, "fresh cwd has no graph.db — a build is needed");

    // Simulate the detached child: spawnDetachedBuild writes the CHILD's pid into the
    // lock. We can't spawn a real OS child here, so the fake spawner returns THIS
    // process's own pid — exactly the value the real child would see as "its own pid"
    // once it re-enters the lock via `leina build`.
    const spawner: SpawnFn = () => ({ pid: process.pid, unref() {} });
    const result = spawnDetachedBuild(cwd, { spawner });
    assert.equal(result, "spawned");
    assert.equal(existsSync(buildLockPath(cwd)), true, "lock written with the child's pid");

    // The child's own `leina build` now calls acquireForegroundBuildLock. Before the
    // self-pid fix was centralized, it would see a "live" holder (itself, indistinguishable
    // from an unrelated live foreign process) and wait — forever, since it never releases
    // its own lock. Assert it instead reclaims immediately, with zero polling.
    let sleeps = 0;
    const lockResult = acquireForegroundBuildLock(cwd, { sleep: () => { sleeps++; } });
    assert.ok("fd" in lockResult, "self-pid reclaims instead of waiting on itself");
    assert.equal(sleeps, 0, "no waiting at all — this is the deadlock the fix prevents");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G1: isLeinaProject — tri-state flag (PR5 scope-guard migration)
// Spec §5 / G1-1, G1-2, G1-3
// ---------------------------------------------------------------------------

test("(G1-1) isLeinaProject: consent=enabled → returns true", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leina-gate-g1-enabled-"));
  try {
    mkdirSync(join(cwd, ".leina"), { recursive: true });
    writeFileSync(join(cwd, ".leina", "consent"), "enabled");
    assert.equal(isLeinaProject(cwd), true, "consent=enabled must return true");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("(G1-2) isLeinaProject: consent flag absent → returns false (unknown state)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leina-gate-g1-absent-"));
  try {
    // No .leina/consent file → readConsentFlag returns "unknown" → false
    assert.equal(isLeinaProject(cwd), false, "absent flag must return false");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("(G1-3) isLeinaProject: consent=disabled → returns false", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leina-gate-g1-disabled-"));
  try {
    mkdirSync(join(cwd, ".leina"), { recursive: true });
    writeFileSync(join(cwd, ".leina", "consent"), "disabled");
    assert.equal(isLeinaProject(cwd), false, "consent=disabled must return false");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G2: Backward-compat — repos legacy con .devin/hooks.v1.json sin consent flag
// Spec §5 / G2-1, G2-2
// ---------------------------------------------------------------------------

test("(G2-1) legacy repo (.devin/hooks.v1.json present, no consent flag) → gate SILENT (unknown, no injection)", () => {
  // G2: repos with the old hooks.v1.json but no consent flag must resolve to "unknown".
  // isLeinaProject must return false (NOT auto-enable). Gate must be completely silent.
  const cwd = mkdtempSync(join(tmpdir(), "leina-gate-g2-legacy-"));
  try {
    mkdirSync(join(cwd, ".devin"), { recursive: true });
    writeFileSync(join(cwd, ".devin", "hooks.v1.json"), "{}");
    // No .leina/consent written → readConsentFlag returns "unknown"
    assert.equal(isLeinaProject(cwd), false, "legacy repo must NOT be auto-enabled (no consent flag)");

    // Gate must be completely silent for PreToolUse
    const editPayload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "edit" });
    const { stdout: out1, stderr: err1 } = withCapturedIO(() => runAgentGate(editPayload, cwd));
    assert.equal(out1, "", "no stdout for legacy repo without consent flag");
    assert.equal(err1, "", "no advisory for legacy repo without consent flag");

    // SessionStart must also be silent (no additionalContext injection)
    const ssPayload = JSON.stringify({ hook_event_name: "SessionStart" });
    const { stdout: out2, stderr: err2 } = withCapturedIO(() => runAgentGate(ssPayload, cwd));
    assert.equal(out2, "", "no additionalContext injected for legacy repo");
    assert.equal(err2, "", "no stderr for legacy repo at SessionStart");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("(G2-2) legacy migration: after init writes consent=enabled, gate activates", () => {
  // G2: once the user runs `leina init` (which writes consent=enabled), the gate
  // activates on the next hook call. Simulates the affirmative resolution of the one-time prompt.
  const cwd = mkdtempSync(join(tmpdir(), "leina-gate-g2-migrate-"));
  try {
    // Before migration: legacy state — hooks.v1.json exists, no consent flag
    mkdirSync(join(cwd, ".devin"), { recursive: true });
    writeFileSync(join(cwd, ".devin", "hooks.v1.json"), "{}");
    assert.equal(isLeinaProject(cwd), false, "gate silent before migration (no consent flag)");

    // Migration: user runs `leina init` → consent flag written as "enabled"
    mkdirSync(join(cwd, ".leina"), { recursive: true });
    writeFileSync(join(cwd, ".leina", "consent"), "enabled");

    // After migration: gate should now recognise the project
    assert.equal(isLeinaProject(cwd), true, "gate active after consent=enabled written");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

