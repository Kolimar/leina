// sidecar-verify.test.ts — Verifica el subcomando `leina sidecar verify`.
//
// Cubre: REQ-SV-1, REQ-SV-2, REQ-SV-3, AC-8.
//
// Escenarios:
//   - Sin toolchain (missingTools): exit 0, output contiene "skip"
//   - Con toolchain (condicional): exit 0, output contiene "ok" (se salta si no hay JDK/dotnet)
//
// Run: node --no-warnings --experimental-strip-types --test test/sidecar-verify.test.ts

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

// Detectar si la herramienta está disponible en PATH
function toolAvailable(tool: string): boolean {
  const r = spawnSync(tool, ["--version"], { stdio: "ignore" });
  return r.status === 0 || (r.status === null && r.error === undefined);
}

const hasDotnet = toolAvailable("dotnet");
const hasJava = toolAvailable("javac");

// ---------------------------------------------------------------------------
// verify csharp
// ---------------------------------------------------------------------------

test("(SV-1) sidecar verify csharp: exit 0 y nunca lanza (skip cuando falta dotnet)", () => {
  const r = runCli(["sidecar", "verify", "csharp"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  // Siempre debe producir alguna salida (skip u ok)
  const combined = r.stdout + r.stderr;
  assert.ok(
    combined.includes("skip") || combined.includes("ok"),
    `debe contener 'skip' u 'ok'. salida: ${combined}`,
  );
});

test("(SV-2) sidecar verify csharp: salida contiene 'skip' cuando dotnet no está disponible", {
  skip: hasDotnet ? "dotnet disponible — se omite este escenario de skip" : false,
}, () => {
  const r = runCli(["sidecar", "verify", "csharp"]);
  assert.strictEqual(r.code, 0, `debe salir 0 en skip. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("skip"), `stdout debe contener 'skip'. stdout: ${r.stdout}`);
});

// ---------------------------------------------------------------------------
// verify java
// ---------------------------------------------------------------------------

test("(SV-3) sidecar verify java: exit 0 y nunca lanza (skip cuando falta JDK)", () => {
  const r = runCli(["sidecar", "verify", "java"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  const combined = r.stdout + r.stderr;
  assert.ok(
    combined.includes("skip") || combined.includes("ok"),
    `debe contener 'skip' u 'ok'. salida: ${combined}`,
  );
});

test("(SV-4) sidecar verify java: salida contiene 'skip' cuando JDK no está disponible", {
  skip: hasJava ? "JDK disponible — se omite este escenario de skip" : false,
}, () => {
  const r = runCli(["sidecar", "verify", "java"]);
  assert.strictEqual(r.code, 0, `debe salir 0 en skip. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("skip"), `stdout debe contener 'skip'. stdout: ${r.stdout}`);
});

// ---------------------------------------------------------------------------
// verify (ambos) sin argumento de lang
// ---------------------------------------------------------------------------

test("(SV-5) sidecar verify (sin lang): exit 0 y produce salida para csharp + java", () => {
  const r = runCli(["sidecar", "verify"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  const combined = r.stdout + r.stderr;
  assert.ok(combined.includes("csharp"), `debe mencionar 'csharp'. salida: ${combined}`);
  assert.ok(combined.includes("java"), `debe mencionar 'java'. salida: ${combined}`);
});

// ---------------------------------------------------------------------------
// Contrato del adaptador verify() directamente (sin CLI)
// ---------------------------------------------------------------------------

test("(SV-6) SidecarExtractor.verify() retorna VerificationCheck con status sk/ok/fail, nunca lanza", async () => {
  const { SidecarExtractor } = await import("../src/infrastructure/extractors/semantic/sidecar.ts");
  for (const lang of ["csharp", "java"] as const) {
    const ext = new SidecarExtractor(lang, "test");
    let check;
    try {
      check = await ext.verify();
    } catch (err) {
      assert.fail(`verify() no debe lanzar para ${lang}: ${(err as Error).message}`);
    }
    assert.ok(
      check.status === "ok" || check.status === "skip" || check.status === "fail",
      `${lang}: status debe ser ok/skip/fail. got: ${check.status}`,
    );
    // skip nunca tiene result
    if (check.status === "skip") {
      assert.strictEqual(check.result, undefined, `${lang}: skip no debe tener result`);
    }
  }
});

// ---------------------------------------------------------------------------
// REQ-D4a: mensajes user-facing en inglés (toolchain no disponible / sidecar no
// configurado), tanto en el mensaje del adaptador como en el fallback del handler.
// ---------------------------------------------------------------------------

test("(SV-7) verify() message text is English, never the Spanish original", async () => {
  const { SidecarExtractor } = await import("../src/infrastructure/extractors/semantic/sidecar.ts");
  for (const lang of ["csharp", "java"] as const) {
    const ext = new SidecarExtractor(lang, "test");
    const check = await ext.verify();
    if (check.status !== "skip") continue; // this environment must skip at least one of these
    assert.ok(check.message, `${lang}: skip debe traer message`);
    assert.doesNotMatch(check.message, /no disponible|no configurado/, `${lang}: message no debe estar en español`);
    assert.match(check.message, /toolchain unavailable for|sidecar not configured for/, `${lang}: message debe usar el texto en inglés esperado`);
  }
});

test("(SV-8) CLI 'sidecar verify' output never leaks the Spanish fallback strings", () => {
  const r = runCli(["sidecar", "verify"]);
  assert.strictEqual(r.code, 0, `debe salir 0. stderr: ${r.stderr}`);
  const combined = r.stdout + r.stderr;
  assert.doesNotMatch(combined, /no disponible|verificaci[oó]n fallida|no configurado/i);
});
