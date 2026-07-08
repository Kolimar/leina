// `leina doctor` end-to-end — spawns the real CLI against an isolated tmp home and asserts
// the printed report + exit code. The collector logic is unit-tested in doctor.test.ts; this
// covers the CLI wiring (case dispatch, formatting, process.exit code).
// Run: node --no-warnings --experimental-strip-types --test test/doctor-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

const TEMP_HOME = mkdtempSync(join(tmpdir(), "leina-doctor-cli-"));
const TEST_ENV = {
  ...process.env,
  LEINA_HOME: TEMP_HOME,
  HOME: TEMP_HOME,
  USERPROFILE: TEMP_HOME,
};

test.after(() => rmSync(TEMP_HOME, { recursive: true, force: true }));

function runDoctor(dir?: string) {
  return spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "doctor", ...(dir ? [dir] : [])],
    { encoding: "utf8", env: TEST_ENV },
  );
}

test("(doc-cli-a) doctor prints a report and exits non-zero on a fresh (uninstalled) home", () => {
  const res = runDoctor();
  assert.match(res.stdout, /leina doctor/, "prints the report header");
  assert.match(res.stdout, /share:/, "includes the share group");
  assert.match(res.stdout, /fail, .* warn, .* checks total/, "prints the summary line");
  assert.equal(res.status, 1, "fresh home has a failing share check → exit 1");
});

test("(doc-cli-b) doctor [dir] runs after init+activate and reports the project's checks", () => {
  // activate populates the global share; init wires AGENTS.md/.gitignore/.devin.
  const proj = join(TEMP_HOME, "myproj");
  const activateRes = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "activate", "--no-user-hooks", "--hosts", "devin"],
    { encoding: "utf8", env: TEST_ENV },
  );
  assert.equal(activateRes.status, 0, `activate succeeded: ${activateRes.stderr}`);
  const initRes = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", proj, "--hosts", "devin", "--profile", "devin"],
    { encoding: "utf8", env: TEST_ENV },
  );
  assert.equal(initRes.status, 0, `init succeeded: ${initRes.stderr}`);

  // CLI-only: doctor takes an optional [dir]; the project checks live under the `project:` group.
  const res = runDoctor(proj);
  assert.match(res.stdout, /project:/, "the project checks appear under the project group");
  assert.match(res.stdout, /AGENTS\.md/, "the project's AGENTS.md check is present");
  assert.match(res.stdout, /share version/, "share version line present (activated)");
});

// ---------------------------------------------------------------------------
// REQ-DV-1/2: doctor --json y verify --json exponen repoIdentity (T6 etapa-3)
// ---------------------------------------------------------------------------

test("(doc-cli-c) doctor --json emite JSON parseable con results y exitCode", () => {
  const res = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "doctor", "--json"],
    { encoding: "utf8", env: TEST_ENV },
  );
  // El stdout debe ser JSON parseable
  let report: { results: unknown[]; exitCode: number; repoIdentity?: unknown };
  assert.doesNotThrow(() => {
    report = JSON.parse(res.stdout) as typeof report;
  }, "doctor --json debe emitir JSON parseable");
  assert.ok(Array.isArray(report!.results), "report.results debe ser array");
  assert.ok(typeof report!.exitCode === "number", "report.exitCode debe ser number");
  // exit code del proceso debe coincidir con report.exitCode
  assert.equal(res.status, report!.exitCode, "exit code del proceso coincide con report.exitCode");
});

test("(doc-cli-d) doctor --json: repoIdentity tiene shape correcto cuando presente", () => {
  // Ejecutar contra el directorio actual (repo git con commits)
  const res = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "doctor", ".", "--json"],
    { encoding: "utf8", env: TEST_ENV },
  );
  const report = JSON.parse(res.stdout) as {
    results: unknown[];
    exitCode: number;
    repoIdentity?: {
      projectKey: string;
      strategy: string;
      confidence: string;
      pathHash: string;
      normalizedRemote?: string;
      rootCommit?: string;
    };
  };
  if (report.repoIdentity !== undefined) {
    const ri = report.repoIdentity;
    assert.ok(["high", "medium", "low"].includes(ri.confidence), "confidence válido");
    assert.match(ri.pathHash, /^[0-9a-f]{16}$/, "pathHash: 16 hex chars");
    assert.ok(ri.projectKey.length > 0, "projectKey no vacío");
  }
  // exit 1 normal (share ausente en tmpHome, que es esperado)
});

test("(doc-cli-e) doctor sin --json: stdout es formato humano (golden — no contiene JSON raw)", () => {
  const res = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "doctor"],
    { encoding: "utf8", env: TEST_ENV },
  );
  // El stdout humano debe contener el encabezado y el summary line
  assert.match(res.stdout, /leina doctor/, "contiene el encabezado humano");
  assert.match(res.stdout, /fail, .* warn, .* checks total/, "contiene el summary line");
  // NO debe ser JSON crudo (no debe empezar con '{')
  assert.ok(!res.stdout.trimStart().startsWith("{"), "no es JSON crudo en modo humano");
});

test("(doc-cli-f) verify --json incluye repoIdentity idéntico a doctor --json", () => {
  const doctorRes = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "doctor", ".", "--json"],
    { encoding: "utf8", env: TEST_ENV },
  );
  const verifyRes = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "verify", ".", "--json"],
    { encoding: "utf8", env: TEST_ENV },
  );

  // Ambos deben ser JSON parseables
  const drep = JSON.parse(doctorRes.stdout) as { repoIdentity?: unknown };
  const vrep = JSON.parse(verifyRes.stdout) as { repoIdentity?: unknown };

  // repoIdentity de verify debe coincidir con el de doctor
  assert.deepEqual(
    vrep.repoIdentity,
    drep.repoIdentity,
    "verify --json debe tener repoIdentity idéntico a doctor --json",
  );
});
