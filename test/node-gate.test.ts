// node-gate.test.ts — the minimum-Node startup gate (src/cli/node-gate.ts).
//
// The gate exists because the dispatcher's static import graph reaches node:sqlite,
// which on an unsupported Node fails at ESM link time with an opaque error. These tests
// cover the pure pieces (version compare + message builder) and drive runNodeGate through
// a real child process for the exit/stderr contract (it calls process.exit, so it cannot
// be exercised in-process).
// Run: node --no-warnings --experimental-strip-types --test test/node-gate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MIN_NODE,
  RECOMMENDED_NODE_MAJOR,
  buildNodeGateMessage,
  isSupportedNodeVersion,
} from "../src/cli/node-gate.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const GATE = fileURLToPath(new URL("../src/cli/node-gate.ts", import.meta.url));

// ---------------------------------------------------------------------------
// (ng-a) Pure version comparison
// ---------------------------------------------------------------------------

test("(ng-a1) versions below the floor are rejected", () => {
  for (const v of ["18.20.4", "20.11.1", "21.99.0", "22.0.0", "22.12.9"]) {
    assert.equal(isSupportedNodeVersion(v), false, v);
  }
});

test("(ng-a2) the floor and above are accepted", () => {
  for (const v of ["22.13.0", "22.14.1", "23.0.0", "23.4.0", "24.0.0", "25.1.2"]) {
    assert.equal(isSupportedNodeVersion(v), true, v);
  }
});

test("(ng-a3) unparseable versions do not block (fail open)", () => {
  for (const v of ["", "garbage", "x.y.z"]) {
    assert.equal(isSupportedNodeVersion(v), true, JSON.stringify(v));
  }
});

test("(ng-a4) MIN_NODE matches the documented floor", () => {
  assert.deepEqual({ ...MIN_NODE }, { major: 22, minor: 13 });
  assert.equal(RECOMMENDED_NODE_MAJOR >= MIN_NODE.major, true);
});

// ---------------------------------------------------------------------------
// (ng-b) Message builder
// ---------------------------------------------------------------------------

test("(ng-b1) message names the running and required versions", () => {
  const msg = buildNodeGateMessage("20.11.1");
  assert.match(msg, /requires Node >= 22\.13/);
  assert.match(msg, /running Node 20\.11\.1/);
  assert.match(msg, new RegExp(`Node ${RECOMMENDED_NODE_MAJOR}\\+ is recommended`));
});

test("(ng-b2) switch command and pin file are included when provided", () => {
  const msg = buildNodeGateMessage("20.0.0", "nvm install 24 && nvm use 24", "/repo/.nvmrc");
  assert.match(msg, /→ nvm install 24 && nvm use 24/);
  assert.match(msg, /pin file detected: \/repo\/\.nvmrc/);
});

test("(ng-b3) message works without advice (best-effort path)", () => {
  const msg = buildNodeGateMessage("20.0.0");
  assert.doesNotMatch(msg, /→/);
  assert.doesNotMatch(msg, /pin file/);
});

// ---------------------------------------------------------------------------
// (ng-c) Process-level contract
// ---------------------------------------------------------------------------

test("(ng-c1) on a supported Node the gate lets the CLI through", () => {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "version"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test("(ng-c2) an unsupported version exits 1 with the actionable message on stderr", () => {
  // runNodeGate takes an injectable version precisely so this path is testable on a
  // modern Node: drive it in a child process because it calls process.exit.
  const script = `import { runNodeGate } from ${JSON.stringify(GATE)}; await runNodeGate("20.11.1");`;
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires Node >= 22\.13/);
  assert.match(r.stderr, /running Node 20\.11\.1/);
});

test("(ng-c3) a supported version returns without output or exit", () => {
  const script =
    `import { runNodeGate } from ${JSON.stringify(GATE)}; ` +
    `await runNodeGate("24.1.0"); process.stdout.write("alive");`;
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "alive");
  assert.equal(r.stderr, "");
});
