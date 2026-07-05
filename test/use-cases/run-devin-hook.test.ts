// Unit tests for the devin-hook active-context module.
// Tests the fail-open contract and the exported constants.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildActiveContext,
  SESSION_START_CONTEXT,
} from "../../src/cli/active-context.ts";
import type { ActiveContextResult } from "../../src/cli/active-context.ts";

test("buildActiveContext: non-existent dir still produces a result (fail-open)", () => {
  const fakeDir = join(tmpdir(), `leina-test-nonexistent-${  Date.now()}`);
  const result: ActiveContextResult = buildActiveContext(fakeDir);
  // Should never throw; always returns text (either injected or fallback)
  assert.ok(typeof result.text === "string");
  assert.ok(result.text.length > 0);
});

test("buildActiveContext: empty temp dir returns text with delivered status", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "leina-ctx-"));
  const result: ActiveContextResult = buildActiveContext(tempDir);
  assert.ok(typeof result.text === "string");
  assert.ok(result.text.length > 0);
  assert.ok(typeof result.delivered === "boolean");
});

test("SESSION_START_CONTEXT: contains advisory guidance keywords", () => {
  assert.ok(SESSION_START_CONTEXT.includes("leina"));
  assert.ok(SESSION_START_CONTEXT.includes("memory context"));
  assert.ok(SESSION_START_CONTEXT.includes("memory session"));
  assert.ok(SESSION_START_CONTEXT.includes("advisory"));
});
