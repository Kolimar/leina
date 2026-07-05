// parser-assets.test.ts — verification of the WASM parser assets
// (src/infrastructure/extractors/parser-assets.ts) and its doctor wiring.
//
// On a healthy checkout the report must be fully ok; the failure shapes are exercised
// through the pure report/advice builders (we cannot uninstall packages mid-test).
// Run: node --no-warnings --experimental-strip-types --test test/parser-assets.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  GRAMMAR_WASM_FILES,
  YAML_WASM_FILE,
  parserAssetsAdvice,
  verifyParserAssets,
  wasmAssetsDir,
} from "../src/infrastructure/extractors/parser-assets.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

test("(pa-a1) on a healthy install the report is ok, with all grammars present", () => {
  const report = verifyParserAssets();
  assert.equal(report.ok, true, report.detail);
  assert.notEqual(report.webTreeSitterDir, null);
  assert.notEqual(report.wasmsDir, null);
  assert.deepEqual(report.missingWasms, []);
  assert.deepEqual(report.corruptedWasms, []);
  assert.match(report.detail, /12 grammar wasms present and checksum-verified/);
});

test("(pa-a2) the map lists one existing wasm file per supported code language", () => {
  const report = verifyParserAssets();
  const langs = Object.keys(GRAMMAR_WASM_FILES);
  assert.equal(langs.length, 11);
  for (const [lang, file] of Object.entries(GRAMMAR_WASM_FILES)) {
    assert.match(file, /^tree-sitter-.+\.wasm$/, lang);
    assert.ok(existsSync(join(report.wasmsDir!, file)), `${lang} → ${file} exists`);
  }
});

test("(pa-a3) the yaml grammar wasm is vendored and verified alongside the code grammars", () => {
  const report = verifyParserAssets();
  assert.match(YAML_WASM_FILE, /^tree-sitter-.+\.wasm$/);
  assert.ok(existsSync(join(report.wasmsDir!, YAML_WASM_FILE)), "yaml wasm exists");
  assert.equal(report.missingWasms.includes(YAML_WASM_FILE), false);
});

test("(pa-a4) wasmAssetsDir resolves to the vendored assets/wasm/ directory", () => {
  const dir = wasmAssetsDir();
  assert.ok(existsSync(dir), dir);
  assert.ok(existsSync(join(dir, "checksums.json")), "checksums.json present");
});

test("(pa-b1) advice names the problem and the reinstall remedy", () => {
  const advice = parserAssetsAdvice({
    ok: false,
    webTreeSitterDir: null,
    wasmsDir: null,
    missingWasms: [],
    corruptedWasms: [],
    detail: "web-tree-sitter does not resolve; assets/wasm/ does not exist",
  });
  assert.match(advice, /web-tree-sitter does not resolve/);
  assert.match(advice, /npm i -g leina/);
  assert.match(advice, /leina doctor/);
});

// Fake wasm set for the checksum tests: every expected filename exists with known content,
// so only the deliberately introduced defect shows up in the report.
function writeFakeWasms(dir: string): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const f of [...Object.values(GRAMMAR_WASM_FILES), YAML_WASM_FILE]) {
    writeFileSync(join(dir, f), f);
    checksums[f] = createHash("sha256").update(f).digest("hex");
  }
  return checksums;
}

test("(pa-d1) a present-but-tampered grammar is reported as corrupted (sha256 mismatch)", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-wasm-"));
  try {
    const checksums = writeFakeWasms(dir);
    checksums[YAML_WASM_FILE] = "0".repeat(64);
    writeFileSync(join(dir, "checksums.json"), JSON.stringify(checksums));
    const report = verifyParserAssets(dir);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingWasms, []);
    assert.deepEqual(report.corruptedWasms, [YAML_WASM_FILE]);
    assert.match(report.detail, /corrupted grammars \(sha256 mismatch\): tree-sitter-yaml\.wasm/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pa-d2) all wasms present but checksums.json missing → reported, not ok", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-wasm-"));
  try {
    writeFakeWasms(dir);
    const report = verifyParserAssets(dir);
    assert.equal(report.ok, false);
    assert.deepEqual(report.corruptedWasms, []);
    assert.match(report.detail, /checksums\.json missing or unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pa-d3) matching checksums over the fake set verify clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-wasm-"));
  try {
    const checksums = writeFakeWasms(dir);
    writeFileSync(join(dir, "checksums.json"), JSON.stringify(checksums));
    const report = verifyParserAssets(dir);
    assert.equal(report.ok, true, report.detail);
    assert.deepEqual(report.corruptedWasms, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pa-c1) doctor exposes the parser-assets check (ok on this checkout)", () => {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "doctor", "--json"],
    { encoding: "utf8" },
  );
  const report = JSON.parse(r.stdout) as {
    results: { label: string; status: string; detail: string }[];
  };
  const check = report.results.find((c) => c.label === "parser assets (wasm)");
  assert.ok(check, "doctor must include the parser assets check");
  assert.equal(check.status, "ok", check.detail);
});
