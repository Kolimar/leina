// test/mocks/fake-agent-runner.test.ts — R-7: FakeAgentRunner sequence test.
//
// Validates that a 3-step sequence (SessionStart → PostToolUse(memory save) → Stop)
// produces the expected hook outputs and on-disk markers.
//
// Run: node --no-warnings --experimental-strip-types --test test/mocks/fake-agent-runner.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FakeAgentRunner } from "./fake-agent-runner.ts";

const SAVE_MARKER_REL = ".leina/session.memory-saved";

test("(far-R7) SessionStart → PostToolUse(memory save) → Stop: markers and outputs correct", () => {
  const runner = FakeAgentRunner.create();
  try {
    // Use an isolated memory home so buildActiveContext works against an empty controlled DB.
    const isolatedHome = runner.dir;
    const hookEnv: Record<string, string> = {
      LEINA_HOME: isolatedHome,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    };

    const results = runner.runSequence([
      // Step 1: SessionStart — should inject additionalContext on stdout
      {
        event: "SessionStart",
        payload: { hook_event_name: "SessionStart" },
        env: hookEnv,
      },
      // Step 2: PostToolUse with a memory save command — should write session.memory-saved marker
      {
        event: "PostToolUse",
        payload: {
          hook_event_name: "PostToolUse",
          tool_name: "exec",
          tool_input: {
            command: `leina memory save . --title "test-session" --content "session notes"`,
          },
        },
        env: hookEnv,
      },
      // Step 3: Stop — save marker is present, so no nudge should be emitted on stderr
      {
        event: "Stop",
        payload: { hook_event_name: "Stop" },
        env: hookEnv,
      },
    ]);

    // --- Step 1 assertions: SessionStart injects additionalContext ---
    assert.equal(results[0]!.code, 0, "SessionStart: exit code 0");
    assert.ok(
      results[0]!.stdout.trim().length > 0,
      "SessionStart: stdout is non-empty (additionalContext emitted)",
    );
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(results[0]!.stdout.trim()) as Record<string, unknown>;
    } catch {
      assert.fail(`SessionStart: stdout is not valid JSON: ${results[0]!.stdout}`);
    }
    // The hook output envelope has shape: { hookSpecificOutput: { hookEventName, additionalContext } }
    const hookOut = parsed.hookSpecificOutput as Record<string, unknown> | undefined;
    assert.ok(
      hookOut !== undefined && "additionalContext" in hookOut,
      "SessionStart: hookSpecificOutput.additionalContext is present",
    );

    // --- Step 2 assertions: PostToolUse writes the memory-saved marker ---
    assert.equal(results[1]!.code, 0, "PostToolUse: exit code 0");
    assert.ok(
      existsSync(join(runner.dir, SAVE_MARKER_REL)),
      "PostToolUse: session.memory-saved marker written to disk",
    );

    // --- Step 3 assertions: Stop is silent when save marker is present ---
    assert.equal(results[2]!.code, 0, "Stop: exit code 0");
    assert.equal(results[2]!.stdout, "", "Stop: stdout always empty");
    // The save nudge must NOT appear since the marker is present
    assert.ok(
      !results[2]!.stderr.includes("memory session") && !results[2]!.stderr.includes("memory save"),
      `Stop: no save nudge on stderr (got: ${results[2]!.stderr})`,
    );
  } finally {
    runner.cleanup();
  }
});

test("(far-create) FakeAgentRunner.create initialises a project with scope sentinel", () => {
  const runner = FakeAgentRunner.create();
  try {
    assert.ok(
      existsSync(join(runner.dir, ".devin", "hooks.v1.json")),
      "scope sentinel .devin/hooks.v1.json is present after create()",
    );
    assert.ok(
      existsSync(join(runner.dir, "AGENTS.md")),
      "AGENTS.md is present after create()",
    );
  } finally {
    runner.cleanup();
  }
});

test("(far-cleanup) FakeAgentRunner.cleanup removes the temporary directory", () => {
  const runner = FakeAgentRunner.create();
  const dir = runner.dir;
  runner.cleanup();
  assert.ok(!existsSync(dir), "temp dir removed after cleanup()");
});
