// scip-verify.test.ts — CLI surface for `leina scip [status|verify|install]`
// (task 4.1; sdd/scip-lang-rollout wave B extends this to `rust`, wave C to
// `python`). Mirrors sidecar-verify.test.ts's pattern: by default this
// sandbox has neither `scip-go`, `rust-analyzer`, nor `scip-python` on PATH,
// so verify/status/install must all degrade to their "not available"
// branch, exit 0, and print English detect+instruct text — UNLESS the
// sandbox actually has the tool installed (as it may per this wave's
// real-toolchain verification), in which case the "available"/"ok" branch
// is asserted instead.
//
// Run: node --no-warnings --experimental-strip-types --test test/scip-verify.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[]): RunResult {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8" },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

// Two guards per tool, one per test POLARITY — because detection and
// functionality can disagree. On GitHub's ubuntu runners `rust-analyzer`
// exists on PATH as a rustup shim: `commandExists` finds it (so `scip status`
// says "found"), but `rust-analyzer --version` exits non-zero and
// `rust-analyzer scip` produces no index.
//
//  - NEGATIVE-branch tests ("not installed"/"not found") skip unless the CLI
//    itself reports NOT found (`has*` below, from `scip status` — the same
//    source of truth the assertions run against).
//  - POSITIVE-branch tests ('ok' against the real fixture) skip unless the
//    tool actually WORKS: the CLI finds it AND `<tool> --version` exits 0
//    (`works*` below).
//
// In the shim environment has*=true and works*=false, so BOTH polarities
// skip — correct, because that environment is genuinely ambiguous: the CLI
// answers "found" but the tool cannot produce an index.
const statusStdout = runCli(["scip", "status"]).stdout;
const hasScipGo = /(^|\n)go: found/.test(statusStdout);
const hasRustAnalyzer = /(^|\n)rust: found/.test(statusStdout);
const hasScipPython = /(^|\n)python: found/.test(statusStdout);

// Functional probe for the positive branch (reintroduced from the pre-e063099
// `toolAvailable`, now REQUIRING exit 0 and combined with CLI detection
// instead of replacing it). `go` needs no `works*` guard today: there is no
// positive 'ok' test for it (indexing the fixture additionally requires the
// full go toolchain, so a version probe alone could not guard one anyway).
function toolWorks(bin: string): boolean {
  const r = spawnSync(bin, ["--version"], { stdio: "ignore" });
  return r.status === 0;
}
const worksRustAnalyzer = hasRustAnalyzer && toolWorks("rust-analyzer");
const worksScipPython = hasScipPython && toolWorks("scip-python");

// ---------------------------------------------------------------------------
// scip status
// ---------------------------------------------------------------------------

test("(SC-1) scip status: exit 0, mentions go, rust and python", () => {
  const r = runCli(["scip", "status"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("go"), `debe mencionar 'go'. salida: ${r.stdout}`);
  assert.ok(r.stdout.includes("rust"), `debe mencionar 'rust'. salida: ${r.stdout}`);
  assert.ok(r.stdout.includes("python"), `debe mencionar 'python'. salida: ${r.stdout}`);
});

test("(SC-2) scip (sin sub) por defecto muestra status", () => {
  const r = runCli(["scip"]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes("go"));
  assert.ok(r.stdout.includes("rust"));
  assert.ok(r.stdout.includes("python"));
});

test("(SC-3) scip status: sin scip-go en PATH, instruye instalación (detect+instruct, nunca auto-instala)", {
  skip: hasScipGo ? "scip-go disponible — se omite este escenario" : false,
}, () => {
  const r = runCli(["scip", "status"]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes("not found"), `debe indicar 'not found'. salida: ${r.stdout}`);
  assert.ok(r.stdout.includes("go install"), `debe instruir el comando de instalación. salida: ${r.stdout}`);
});

test("(SC-3b) scip status: sin rust-analyzer en PATH, instruye instalación (detect+instruct, nunca auto-instala)", {
  skip: hasRustAnalyzer ? "rust-analyzer disponible — se omite este escenario" : false,
}, () => {
  const r = runCli(["scip", "status"]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes("not found"), `debe indicar 'not found'. salida: ${r.stdout}`);
  assert.ok(r.stdout.includes("rustup component add rust-analyzer"), `debe instruir el comando de instalación. salida: ${r.stdout}`);
});

test("(SC-3c) scip status: con rust-analyzer en PATH, reporta 'found'", {
  skip: hasRustAnalyzer ? false : "rust-analyzer no disponible en este sandbox — se omite",
}, () => {
  const r = runCli(["scip", "status"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /rust: found/, `debe indicar 'rust: found'. salida: ${r.stdout}`);
});

test("(SC-3d) scip status: sin scip-python en PATH, instruye instalación (detect+instruct, nunca auto-instala)", {
  skip: hasScipPython ? "scip-python disponible — se omite este escenario" : false,
}, () => {
  const r = runCli(["scip", "status"]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes("not found"), `debe indicar 'not found'. salida: ${r.stdout}`);
  assert.ok(r.stdout.includes("npm install -g @sourcegraph/scip-python"), `debe instruir el comando de instalación. salida: ${r.stdout}`);
});

test("(SC-3e) scip status: con scip-python en PATH, reporta 'found'", {
  skip: hasScipPython ? false : "scip-python no disponible en este sandbox — se omite",
}, () => {
  const r = runCli(["scip", "status"]);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /python: found/, `debe indicar 'python: found'. salida: ${r.stdout}`);
});

// ---------------------------------------------------------------------------
// scip install — detect + instruct only, never auto-installs
// ---------------------------------------------------------------------------

test("(SC-4) scip install go: exit 0, nunca auto-instala (solo detect+instruct)", {
  skip: hasScipGo ? "scip-go disponible — se omite este escenario" : false,
}, () => {
  const r = runCli(["scip", "install", "go"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("not installed"), `debe indicar 'not installed'. salida: ${r.stdout}`);
  assert.ok(r.stdout.includes("go install"), `debe imprimir el comando a correr manualmente. salida: ${r.stdout}`);
});

test("(SC-4b) scip install rust: exit 0, nunca auto-instala (solo detect+instruct)", {
  skip: hasRustAnalyzer ? "rust-analyzer disponible — se omite este escenario" : false,
}, () => {
  const r = runCli(["scip", "install", "rust"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("not installed"), `debe indicar 'not installed'. salida: ${r.stdout}`);
  assert.ok(r.stdout.includes("rustup component add rust-analyzer"), `debe imprimir el comando a correr manualmente. salida: ${r.stdout}`);
});

test("(SC-4c) scip install python: exit 0, nunca auto-instala (solo detect+instruct)", {
  skip: hasScipPython ? "scip-python disponible — se omite este escenario" : false,
}, () => {
  const r = runCli(["scip", "install", "python"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("not installed"), `debe indicar 'not installed'. salida: ${r.stdout}`);
  assert.ok(r.stdout.includes("npm install -g @sourcegraph/scip-python"), `debe imprimir el comando a correr manualmente. salida: ${r.stdout}`);
});

// ---------------------------------------------------------------------------
// scip verify — exit 0 skip/ok, exit 1 fail
// ---------------------------------------------------------------------------

test("(SC-5) scip verify: exit 0 y nunca lanza (skip cuando falta el indexador)", () => {
  const r = runCli(["scip", "verify"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  const combined = r.stdout + r.stderr;
  assert.ok(
    combined.includes("skip") || combined.includes("ok"),
    `debe contener 'skip' u 'ok'. salida: ${combined}`,
  );
});

test("(SC-6) scip verify go: salida contiene 'skip' cuando scip-go no está disponible", {
  skip: hasScipGo ? "scip-go disponible — se omite este escenario de skip" : false,
}, () => {
  const r = runCli(["scip", "verify", "go"]);
  assert.strictEqual(r.code, 0, `debe salir 0 en skip. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("skip"), `stdout debe contener 'skip'. stdout: ${r.stdout}`);
});

test("(SC-6b) scip verify rust: salida contiene 'skip' cuando rust-analyzer no está disponible", {
  skip: hasRustAnalyzer ? "rust-analyzer disponible — se omite este escenario de skip" : false,
}, () => {
  const r = runCli(["scip", "verify", "rust"]);
  assert.strictEqual(r.code, 0, `debe salir 0 en skip. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("skip"), `stdout debe contener 'skip'. stdout: ${r.stdout}`);
});

test("(SC-6c) scip verify rust: con rust-analyzer FUNCIONAL, corre contra el fixture real y reporta 'ok'", {
  skip: worksRustAnalyzer ? false : "rust-analyzer no funcional en este sandbox (ausente o shim) — se omite",
}, () => {
  const r = runCli(["scip", "verify", "rust"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("rust: ok"), `stdout debe contener 'rust: ok'. stdout: ${r.stdout}`);
  assert.match(r.stdout, /nodes=\d+ edges=\d+/, `debe reportar node/edge counts. stdout: ${r.stdout}`);
});

test("(SC-6d) scip verify python: salida contiene 'skip' cuando scip-python no está disponible", {
  skip: hasScipPython ? "scip-python disponible — se omite este escenario de skip" : false,
}, () => {
  const r = runCli(["scip", "verify", "python"]);
  assert.strictEqual(r.code, 0, `debe salir 0 en skip. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("skip"), `stdout debe contener 'skip'. stdout: ${r.stdout}`);
});

test("(SC-6e) scip verify python: con scip-python FUNCIONAL, corre contra el fixture real y reporta 'ok'", {
  skip: worksScipPython ? false : "scip-python no funcional en este sandbox (ausente o shim) — se omite",
}, () => {
  const r = runCli(["scip", "verify", "python"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("python: ok"), `stdout debe contener 'python: ok'. stdout: ${r.stdout}`);
  assert.match(r.stdout, /nodes=\d+ edges=\d+/, `debe reportar node/edge counts. stdout: ${r.stdout}`);
});

test("(SC-7) scip verify: mensajes en inglés, nunca el español", () => {
  const r = runCli(["scip", "verify"]);
  const combined = r.stdout + r.stderr;
  assert.doesNotMatch(combined, /no disponible|verificaci[oó]n fallida|no configurado/i);
});

// ---------------------------------------------------------------------------
// Contrato del adaptador verify() directamente (sin CLI) — nunca lanza
// ---------------------------------------------------------------------------

test("(SC-8) ScipExtractor.verify() retorna VerificationCheck con status skip/ok/fail, nunca lanza", async () => {
  const { ScipExtractor } = await import("../src/infrastructure/extractors/semantic/scip.ts");
  const ext = new ScipExtractor("go", "test");
  let check;
  try {
    check = await ext.verify();
  } catch (err) {
    assert.fail(`verify() no debe lanzar: ${(err as Error).message}`);
  }
  assert.ok(check.status === "ok" || check.status === "skip" || check.status === "fail");
  if (check.status === "skip") assert.strictEqual(check.result, undefined);
});

test("(SC-8b) ScipExtractor('rust').verify() retorna VerificationCheck con status skip/ok/fail, nunca lanza", async () => {
  const { ScipExtractor } = await import("../src/infrastructure/extractors/semantic/scip.ts");
  const ext = new ScipExtractor("rust", "test");
  let check;
  try {
    check = await ext.verify();
  } catch (err) {
    assert.fail(`verify() no debe lanzar: ${(err as Error).message}`);
  }
  assert.ok(check.status === "ok" || check.status === "skip" || check.status === "fail");
  if (check.status === "skip") assert.strictEqual(check.result, undefined);
  if (worksRustAnalyzer) {
    assert.strictEqual(check.status, "ok", "con rust-analyzer funcional, verify() contra el fixture real debe dar 'ok'");
  }
});

test("(SC-8c) ScipExtractor('python').verify() retorna VerificationCheck con status skip/ok/fail, nunca lanza", async () => {
  const { ScipExtractor } = await import("../src/infrastructure/extractors/semantic/scip.ts");
  const ext = new ScipExtractor("python", "test");
  let check;
  try {
    check = await ext.verify();
  } catch (err) {
    assert.fail(`verify() no debe lanzar: ${(err as Error).message}`);
  }
  assert.ok(check.status === "ok" || check.status === "skip" || check.status === "fail");
  if (check.status === "skip") assert.strictEqual(check.result, undefined);
  if (worksScipPython) {
    assert.strictEqual(check.status, "ok", "con scip-python funcional, verify() contra el fixture real debe dar 'ok'");
  }
});
