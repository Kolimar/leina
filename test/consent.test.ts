// Unit tests for src/application/install/consent.ts
// Covers spec scenarios C1-1, C1-2, C1-3 + fail-safe I/O error path.
// All tests use a fresh tmpdir as `cwd` so they never touch the developer's real repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConsentFlag, writeConsentFlag } from "../src/application/install/consent.ts";
import type { ConsentState } from "../src/application/install/consent.ts";

// ---- helper ----------------------------------------------------------------

function freshCwd(): string {
  return mkdtempSync(join(tmpdir(), "consent-test-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---- Escenario C1-1: lectura de flag ausente --------------------------------

test("(consent-C1-1) readConsentFlag returns 'unknown' when .leina/consent absent", () => {
  const cwd = freshCwd();
  try {
    const result = readConsentFlag(cwd);
    assert.equal(result, "unknown");
  } finally {
    cleanup(cwd);
  }
});

// ---- Escenario C1-2: lectura de flag enabled / disabled --------------------

test("(consent-C1-2a) readConsentFlag returns 'enabled' when file contains 'enabled'", () => {
  const cwd = freshCwd();
  try {
    mkdirSync(join(cwd, ".leina"), { recursive: true });
    writeFileSync(join(cwd, ".leina", "consent"), "enabled");
    assert.equal(readConsentFlag(cwd), "enabled");
  } finally {
    cleanup(cwd);
  }
});

test("(consent-C1-2b) readConsentFlag returns 'disabled' when file contains 'disabled'", () => {
  const cwd = freshCwd();
  try {
    mkdirSync(join(cwd, ".leina"), { recursive: true });
    writeFileSync(join(cwd, ".leina", "consent"), "disabled");
    assert.equal(readConsentFlag(cwd), "disabled");
  } finally {
    cleanup(cwd);
  }
});

test("(consent-C1-2c) readConsentFlag trims whitespace before comparing", () => {
  const cwd = freshCwd();
  try {
    mkdirSync(join(cwd, ".leina"), { recursive: true });
    writeFileSync(join(cwd, ".leina", "consent"), "  enabled\n");
    assert.equal(readConsentFlag(cwd), "enabled");
  } finally {
    cleanup(cwd);
  }
});

test("(consent-C1-2d) readConsentFlag returns 'unknown' for unrecognised content", () => {
  const cwd = freshCwd();
  try {
    mkdirSync(join(cwd, ".leina"), { recursive: true });
    writeFileSync(join(cwd, ".leina", "consent"), "garbage");
    assert.equal(readConsentFlag(cwd), "unknown");
  } finally {
    cleanup(cwd);
  }
});

// ---- Escenario C1-3: escritura crea directorio -----------------------------

test("(consent-C1-3a) writeConsentFlag creates .leina/ when absent and writes 'enabled'", () => {
  const cwd = freshCwd();
  try {
    assert.ok(!existsSync(join(cwd, ".leina")), "dir absent before write");
    writeConsentFlag(cwd, "enabled");
    assert.ok(existsSync(join(cwd, ".leina", "consent")), "file created");
    assert.equal(readConsentFlag(cwd), "enabled");
  } finally {
    cleanup(cwd);
  }
});

test("(consent-C1-3b) writeConsentFlag creates .leina/ when absent and writes 'disabled'", () => {
  const cwd = freshCwd();
  try {
    writeConsentFlag(cwd, "disabled");
    assert.equal(readConsentFlag(cwd), "disabled");
  } finally {
    cleanup(cwd);
  }
});

// ---- Round-trip enabled → disabled ----------------------------------------

test("(consent-round-trip) round-trip enabled→disabled preserves last write", () => {
  const cwd = freshCwd();
  try {
    writeConsentFlag(cwd, "enabled");
    assert.equal(readConsentFlag(cwd), "enabled");
    writeConsentFlag(cwd, "disabled");
    assert.equal(readConsentFlag(cwd), "disabled");
  } finally {
    cleanup(cwd);
  }
});

// ---- Fail-safe: I/O error path ---------------------------------------------

test("(consent-fail-safe) readConsentFlag returns 'unknown' for non-existent cwd path (no throw)", () => {
  // Pass a path that doesn't exist at all — readConsentFlag must never throw.
  const nonExistent = join(tmpdir(), `consent-no-such-dir-xyzzy-${  Date.now()}`);
  let result: ConsentState;
  assert.doesNotThrow(() => {
    result = readConsentFlag(nonExistent);
  });
  assert.equal(result!, "unknown");
});

test("(consent-idempotent) writeConsentFlag is idempotent — re-writing same state is safe", () => {
  const cwd = freshCwd();
  try {
    writeConsentFlag(cwd, "enabled");
    writeConsentFlag(cwd, "enabled");
    assert.equal(readConsentFlag(cwd), "enabled");
  } finally {
    cleanup(cwd);
  }
});
