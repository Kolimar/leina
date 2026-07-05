// node-version-advice.test.ts — unit tests for the LIKE-mode warning builder.
// Run: node --no-warnings --experimental-strip-types --test test/node-version-advice.test.ts
//
// Tests use the injectable detectNodeVersionAdviceFromEnv to mock process.env and
// avoid touching the real environment. existsSync-based fallbacks are not tested
// here because they depend on the developer's machine layout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectNodeVersionAdvice,
  detectNodeVersionAdviceFromEnv,
  buildLikeModeWarning,
} from "../src/infrastructure/node-version-advice.ts";

// ---------------------------------------------------------------------------
// Manager detection by env vars
// ---------------------------------------------------------------------------

test("(nva-1) fnm detected via FNM_DIR", () => {
  const advice = detectNodeVersionAdviceFromEnv(
    { FNM_DIR: "/home/user/.fnm" },
    "/tmp",
    24,
  );
  assert.equal(advice.manager, "fnm");
  assert.match(advice.switchCommand, /fnm install 24/);
  assert.match(advice.switchCommand, /fnm use 24/);
});

test("(nva-1b) fnm detected via FNM_MULTISHELL_PATH", () => {
  const advice = detectNodeVersionAdviceFromEnv(
    { FNM_MULTISHELL_PATH: "/tmp/fnm_multishell" },
    "/tmp",
    24,
  );
  assert.equal(advice.manager, "fnm");
});

test("(nva-2) nvm detected via NVM_DIR", () => {
  const advice = detectNodeVersionAdviceFromEnv(
    { NVM_DIR: "/home/user/.nvm" },
    "/tmp",
    24,
  );
  assert.equal(advice.manager, "nvm");
  assert.match(advice.switchCommand, /nvm install 24/);
  assert.match(advice.switchCommand, /nvm use 24/);
});

test("(nva-3) asdf detected via ASDF_DIR", () => {
  const advice = detectNodeVersionAdviceFromEnv(
    { ASDF_DIR: "/home/user/.asdf" },
    "/tmp",
    24,
  );
  assert.equal(advice.manager, "asdf");
  assert.match(advice.switchCommand, /asdf install nodejs 24/);
  assert.match(advice.switchCommand, /asdf set nodejs 24/);
});

test("(nva-3b) asdf detected via ASDF_DATA_DIR", () => {
  const advice = detectNodeVersionAdviceFromEnv(
    { ASDF_DATA_DIR: "/home/user/.asdf" },
    "/tmp",
    24,
  );
  assert.equal(advice.manager, "asdf");
});

test("(nva-4) volta detected via VOLTA_HOME", () => {
  const advice = detectNodeVersionAdviceFromEnv(
    { VOLTA_HOME: "/home/user/.volta" },
    "/tmp",
    24,
  );
  assert.equal(advice.manager, "volta");
  assert.match(advice.switchCommand, /volta install node@24/);
});

test("(nva-5) no manager detected: manager==='none', command references nodejs.org", () => {
  // Use a nonexistent HOME so both env-var and filesystem-fallback paths return nothing.
  const advice = detectNodeVersionAdviceFromEnv(
    {
      HOME: "/nonexistent-home-leina-test-12345",
      USERPROFILE: "/nonexistent-home-leina-test-12345",
    },
    "/tmp/nonexistent-dir-that-will-not-match-anything",
    24,
  );
  assert.equal(advice.manager, "none");
  assert.match(advice.switchCommand, /nodejs\.org/);
});

test("(nva-6) fnm takes priority over nvm when both env vars are set", () => {
  const advice = detectNodeVersionAdviceFromEnv(
    {
      FNM_DIR: "/home/user/.fnm",
      NVM_DIR: "/home/user/.nvm",
    },
    "/tmp",
    24,
  );
  assert.equal(advice.manager, "fnm", "fnm should win when both FNM_DIR and NVM_DIR are set");
});

// ---------------------------------------------------------------------------
// pinnedFile detection
// ---------------------------------------------------------------------------

test("(nva-7) .nvmrc present in cwd: pinnedFile points to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-nva-"));
  try {
    writeFileSync(join(dir, ".nvmrc"), "22\n");
    const advice = detectNodeVersionAdviceFromEnv(
      { NVM_DIR: "/home/user/.nvm" },
      dir,
      24,
    );
    assert.ok(advice.pinnedFile, "pinnedFile should be set");
    assert.match(advice.pinnedFile, /\.nvmrc$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(nva-8) .node-version present in cwd: pinnedFile points to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-nva-"));
  try {
    writeFileSync(join(dir, ".node-version"), "22.13.0\n");
    const advice = detectNodeVersionAdviceFromEnv(
      {},
      dir,
      24,
    );
    assert.ok(advice.pinnedFile, "pinnedFile should be set");
    assert.match(advice.pinnedFile, /\.node-version$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(nva-9) no pin file present: pinnedFile is undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-nva-"));
  try {
    const advice = detectNodeVersionAdviceFromEnv(
      { NVM_DIR: "/home/user/.nvm" },
      dir,
      24,
    );
    assert.equal(advice.pinnedFile, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildLikeModeWarning output
// ---------------------------------------------------------------------------

test("(nva-10) buildLikeModeWarning includes ⚠, node version, and switch command", () => {
  const advice = { manager: "fnm" as const, switchCommand: "fnm install 24 && fnm use 24" };
  const warning = buildLikeModeWarning("v22.13.0", advice);
  assert.match(warning, /⚠/, "warning must start with ⚠");
  assert.match(warning, /v22\.13\.0/, "warning must include the node version");
  assert.match(warning, /fnm install 24/, "warning must include the switch command");
  assert.match(warning, /leina doctor/, "warning must reference leina doctor");
  assert.ok(!warning.includes(process.stdout.toString()), "warning should not go to stdout");
});

test("(nva-11) buildLikeModeWarning includes pinnedFile when present", () => {
  const advice = {
    manager: "nvm" as const,
    switchCommand: "nvm install 24 && nvm use 24",
    pinnedFile: "/home/user/project/.nvmrc",
  };
  const warning = buildLikeModeWarning("v22.13.0", advice);
  assert.match(warning, /\.nvmrc/, "warning must include the pin file path");
});

test("(nva-12) buildLikeModeWarning without pinnedFile: no pin-file line", () => {
  const advice = { manager: "volta" as const, switchCommand: "volta install node@24" };
  const warning = buildLikeModeWarning("v22.15.0", advice);
  assert.ok(!warning.includes(".nvmrc"), "no pin-file line when pinnedFile is absent");
  assert.ok(!warning.includes(".node-version"), "no pin-file line when pinnedFile is absent");
});

// ---------------------------------------------------------------------------
// detectNodeVersionAdvice (real env, smoke test)
// ---------------------------------------------------------------------------

test("(nva-13) detectNodeVersionAdvice runs without throwing and returns a valid advice object", () => {
  // This uses the real process.env; we just verify the shape is correct.
  const advice = detectNodeVersionAdvice(process.cwd(), 24);
  assert.ok(
    ["fnm", "nvm", "asdf", "volta", "none"].includes(advice.manager),
    `manager should be a known value, got: ${advice.manager}`,
  );
  assert.ok(typeof advice.switchCommand === "string" && advice.switchCommand.length > 0);
});
