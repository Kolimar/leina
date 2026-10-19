// Unit tests for the devin-hook active-context module.
// Tests the fail-open contract and the exported constants.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildActiveContext,
  SESSION_START_CONTEXT,
} from "../../src/cli/active-context.ts";
import type { ActiveContextResult } from "../../src/cli/active-context.ts";

// buildActiveContext opens the GLOBAL memory.db ($LEINA_HOME/memory.db, created on first
// open): point it at a throwaway home so these tests never touch the real ~/.leina.
function withSandboxHome(fn: () => void): void {
  const home = mkdtempSync(join(tmpdir(), "leina-ctx-home-"));
  const saved = process.env.LEINA_HOME;
  process.env.LEINA_HOME = home;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.LEINA_HOME;
    else process.env.LEINA_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
}

test("buildActiveContext: non-existent dir still produces a result (fail-open)", () => {
  withSandboxHome(() => {
    const fakeDir = join(tmpdir(), `leina-test-nonexistent-${  Date.now()}`);
    const result: ActiveContextResult = buildActiveContext(fakeDir);
    // Should never throw; always returns text (either injected or fallback)
    assert.ok(typeof result.text === "string");
    assert.ok(result.text.length > 0);
  });
});

test("buildActiveContext: empty temp dir returns text with delivered status", () => {
  withSandboxHome(() => {
    const tempDir = mkdtempSync(join(tmpdir(), "leina-ctx-"));
    try {
      const result: ActiveContextResult = buildActiveContext(tempDir);
      assert.ok(typeof result.text === "string");
      assert.ok(result.text.length > 0);
      assert.ok(typeof result.delivered === "boolean");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test("SESSION_START_CONTEXT: contains advisory guidance keywords", () => {
  assert.ok(SESSION_START_CONTEXT.includes("leina"));
  assert.ok(SESSION_START_CONTEXT.includes("memory context"));
  assert.ok(SESSION_START_CONTEXT.includes("memory session"));
  assert.ok(SESSION_START_CONTEXT.includes("advisory"));
});
