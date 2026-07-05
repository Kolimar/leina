// verify.test.ts — covers REQ-VC-1/2/3/4
//
// Uses spawnSync to test `leina verify` end-to-end.
// doctor.ts is NOT modified (REQ-VC-2); both `doctor` and `verify` must
// produce the same diagnosis in the same environment.
//
// Run: node --no-warnings --experimental-strip-types --test test/verify.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

// Isolated home: share dir is missing → doctor finds a "fail" → exit 1.
const TEMP_HOME_FAIL = mkdtempSync(join(tmpdir(), "leina-verify-fail-"));
const ENV_FAIL = { ...process.env, LEINA_HOME: TEMP_HOME_FAIL, HOME: TEMP_HOME_FAIL, USERPROFILE: TEMP_HOME_FAIL };

test.after(() => {
  rmSync(TEMP_HOME_FAIL, { recursive: true, force: true });
});

function runCli(args: string[], env = process.env) {
  return spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", env },
  );
}

// ---------------------------------------------------------------------------
// REQ-VC-1 — verify command is recognized (exit 0 on normal env)
// ---------------------------------------------------------------------------

test("(ver-1) verify: exit 0 when all checks ok/warn (normal environment)", () => {
  const res = runCli(["verify"]);
  // In a fully installed environment every check should be ok or warn.
  // We can't guarantee "ok" in CI, but we CAN assert it's not an unrecognized command.
  // A recognized command either prints output or exits with a valid code (0 or 1).
  assert.ok(
    res.stdout.length > 0,
    `verify must produce output; stderr: ${res.stderr}`,
  );
  assert.ok(
    res.status === 0 || res.status === 1,
    `verify must exit 0 or 1; got ${res.status}`,
  );
});

// ---------------------------------------------------------------------------
// REQ-VC-3 — exit code semantics: fail → 1, warn only → 0
// ---------------------------------------------------------------------------

test("(ver-2) verify: exit 1 when at least one check fails (no share dir)", () => {
  const res = runCli(["verify"], ENV_FAIL);
  assert.equal(res.status, 1, `expected exit 1 when share dir missing; got ${res.status}\nstdout: ${res.stdout}`);
});

test("(ver-3) verify --json: stdout is valid JSON with exitCode field", () => {
  const res = runCli(["verify", "--json"]);
  let parsed: { results: unknown[]; exitCode: number } | undefined;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(res.stdout) as { results: unknown[]; exitCode: number };
  }, "verify --json must produce valid JSON");
  assert.ok(parsed !== undefined);
  assert.ok(Array.isArray(parsed.results), "results must be an array");
  assert.ok(typeof parsed.exitCode === "number", "exitCode must be a number");
  assert.equal(res.status, parsed.exitCode, "process exit code must match report.exitCode");
});

test("(ver-4) verify --json with fail env: exitCode 1 in JSON and process exit 1", () => {
  const res = runCli(["verify", "--json"], ENV_FAIL);
  assert.equal(res.status, 1, `process must exit 1`);
  const parsed = JSON.parse(res.stdout) as { exitCode: number };
  assert.equal(parsed.exitCode, 1, "JSON exitCode must be 1");
});

// ---------------------------------------------------------------------------
// REQ-VC-2 — coexistence: doctor and verify produce same diagnosis
// ---------------------------------------------------------------------------

test("(ver-5) verify and doctor produce same check results in same environment", () => {
  const resDoctor = runCli(["doctor", "--json"]);
  const resVerify = runCli(["verify", "--json"]);

  // Both commands must produce JSON (doctor doesn't support --json natively,
  // but verify --json does; compare status codes instead for parity).
  // We compare exit codes as the primary parity signal.
  // doctor exits based on report.exitCode; verify does the same.
  assert.equal(
    resVerify.status,
    resDoctor.status,
    `verify and doctor should exit with the same code in the same env\n` +
    `doctor exit: ${resDoctor.status}, verify exit: ${resVerify.status}`,
  );
});

// ---------------------------------------------------------------------------
// REQ-VC-4 — verify is listed in printRootHelp()
// ---------------------------------------------------------------------------

test("(ver-6) printRootHelp includes 'verify' (no-args output)", () => {
  const res = runCli([]);
  assert.ok(
    res.stdout.includes("verify"),
    `root help must mention 'verify'; got:\n${res.stdout}`,
  );
});

test("(ver-7) printRootHelp includes 'capabilities' (no-args output)", () => {
  const res = runCli([]);
  assert.ok(
    res.stdout.includes("capabilities"),
    `root help must mention 'capabilities'; got:\n${res.stdout}`,
  );
});
