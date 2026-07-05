// workspace-config.test.ts — unit tests for readWorkspaceConfig
// Covers: SC-04 (empty object → workspace), SC-05 (exclude), unknown fields ignored,
// absent file, malformed JSON, wrong types.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readWorkspaceConfig } from "../src/application/project/workspace-config.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ws-config-"));
}

function writeWsConfig(dir: string, content: string): void {
  writeFileSync(join(dir, "workspace.json"), content, "utf8");
}

// ---------------------------------------------------------------------------
// SC-04: empty {} → workspace
// ---------------------------------------------------------------------------

test("(ws-cfg-1) empty object {} is valid → returns {exclude:[]}", () => {
  const dir = tmpDir();
  try {
    writeWsConfig(dir, "{}");
    const cfg = readWorkspaceConfig(dir);
    assert.ok(cfg !== null, "should return config (not null)");
    assert.deepEqual(cfg.exclude, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-05: exclude filters repos
// ---------------------------------------------------------------------------

test("(ws-cfg-2) exclude array is parsed correctly", () => {
  const dir = tmpDir();
  try {
    writeWsConfig(dir, JSON.stringify({ exclude: ["legacy-repo", "sandbox"] }));
    const cfg = readWorkspaceConfig(dir);
    assert.ok(cfg !== null);
    assert.deepEqual(cfg.exclude, ["legacy-repo", "sandbox"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unknown fields ignored (forward-compat)
// ---------------------------------------------------------------------------

test("(ws-cfg-3) unknown fields are silently ignored", () => {
  const dir = tmpDir();
  try {
    writeWsConfig(dir, JSON.stringify({ exclude: ["foo"], future_flag: true, meta: { v: 2 } }));
    const cfg = readWorkspaceConfig(dir);
    assert.ok(cfg !== null);
    assert.deepEqual(cfg.exclude, ["foo"]);
    // No error thrown for unknown fields
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ws-cfg-4) object with only unknown fields → {exclude:[]}", () => {
  const dir = tmpDir();
  try {
    writeWsConfig(dir, JSON.stringify({ future_flag: true }));
    const cfg = readWorkspaceConfig(dir);
    assert.ok(cfg !== null);
    assert.deepEqual(cfg.exclude, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-open cases
// ---------------------------------------------------------------------------

test("(ws-cfg-5) absent file → null", () => {
  const dir = tmpDir();
  try {
    const cfg = readWorkspaceConfig(dir);
    assert.equal(cfg, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ws-cfg-6) malformed JSON → null", () => {
  const dir = tmpDir();
  try {
    writeWsConfig(dir, "{ invalid json");
    const cfg = readWorkspaceConfig(dir);
    assert.equal(cfg, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ws-cfg-7) JSON array at root → null", () => {
  const dir = tmpDir();
  try {
    writeWsConfig(dir, "[]");
    const cfg = readWorkspaceConfig(dir);
    assert.equal(cfg, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ws-cfg-8) JSON string at root → null", () => {
  const dir = tmpDir();
  try {
    writeWsConfig(dir, '"hello"');
    const cfg = readWorkspaceConfig(dir);
    assert.equal(cfg, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ws-cfg-9) exclude is not an array → treated as missing, returns {exclude:[]}", () => {
  const dir = tmpDir();
  try {
    writeWsConfig(dir, JSON.stringify({ exclude: "legacy-repo" }));
    const cfg = readWorkspaceConfig(dir);
    assert.ok(cfg !== null);
    assert.deepEqual(cfg.exclude, [], "non-array exclude silently ignored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ws-cfg-10) exclude array with mixed types — only strings kept", () => {
  const dir = tmpDir();
  try {
    writeWsConfig(dir, JSON.stringify({ exclude: ["repo-a", 42, null, "repo-b"] }));
    const cfg = readWorkspaceConfig(dir);
    assert.ok(cfg !== null);
    assert.deepEqual(cfg.exclude, ["repo-a", "repo-b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
