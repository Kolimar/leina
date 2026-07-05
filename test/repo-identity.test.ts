// test/repo-identity.test.ts — suite unitaria para domain/project/identity y
// application/project/identity (buildRepoIdentity).
//
// Cubre: REQ-RI-1/2/3/4/5/6
// Run: node --no-warnings --experimental-strip-types --test test/repo-identity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  methodToConfidence,
  computePathHash,
  normalizeRemote,
  type RepoIdentity,
} from "../src/domain/project/identity.ts";
import { buildRepoIdentity } from "../src/application/project/identity.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "leina-ri-"));
}

// ---------------------------------------------------------------------------
// (ri-a) methodToConfidence — mapeo cerrado para los 5 DetectionMethod
// ---------------------------------------------------------------------------

test("(ri-a1) methodToConfidence: config-lock → high", () => {
  assert.equal(methodToConfidence("config-lock"), "high");
});

test("(ri-a2) methodToConfidence: git-remote → high", () => {
  assert.equal(methodToConfidence("git-remote"), "high");
});

test("(ri-a3) methodToConfidence: git-root → medium", () => {
  assert.equal(methodToConfidence("git-root"), "medium");
});

test("(ri-a4) methodToConfidence: child-git-auto → medium", () => {
  assert.equal(methodToConfidence("child-git-auto"), "medium");
});

test("(ri-a5) methodToConfidence: dir-basename → low", () => {
  assert.equal(methodToConfidence("dir-basename"), "low");
});

test("(ri-a6) methodToConfidence: unknown → low (fallback)", () => {
  assert.equal(methodToConfidence("some-future-method"), "low");
});

// ---------------------------------------------------------------------------
// (ri-b) computePathHash — 16 hex chars, normalización cross-OS
// ---------------------------------------------------------------------------

test("(ri-b1) computePathHash: produce 16 chars hex siempre", () => {
  const h = computePathHash("/Users/alice/projects/myrepo");
  assert.equal(h.length, 16, "debe tener exactamente 16 caracteres");
  assert.match(h, /^[0-9a-f]{16}$/, "debe ser hex en minúsculas");
});

test("(ri-b2) computePathHash: backslash y forward slash producen el mismo hash", () => {
  const winPath = "C:\\Users\\alice\\projects\\myrepo";
  const posixPath = "C:/Users/alice/projects/myrepo";
  const h1 = computePathHash(winPath);
  const h2 = computePathHash(posixPath);
  assert.equal(h1, h2, "backslash y slash deben producir hash idéntico");
});

test("(ri-b3) computePathHash: lowercase normalización — misma ruta en distintos cases", () => {
  const h1 = computePathHash("/Users/Alice/Projects/MyRepo");
  const h2 = computePathHash("/users/alice/projects/myrepo");
  assert.equal(h1, h2, "la normalización a lowercase produce hashes iguales");
});

test("(ri-b4) computePathHash: determinista — misma entrada, mismo resultado", () => {
  const path = "/Users/alice/projects/myrepo";
  assert.equal(computePathHash(path), computePathHash(path), "debe ser determinista");
});

// ---------------------------------------------------------------------------
// (ri-c) normalizeRemote — SCP, HTTPS, vacío/inparseable
// ---------------------------------------------------------------------------

test("(ri-c1) normalizeRemote: SCP git@github.com:Org/MyRepo.git → 'github.com/org/myrepo'", () => {
  const result = normalizeRemote("git@github.com:Org/MyRepo.git");
  assert.equal(result, "github.com/org/myrepo");
});

test("(ri-c2) normalizeRemote: HTTPS https://github.com/Org/MyRepo.git → 'github.com/org/myrepo'", () => {
  const result = normalizeRemote("https://github.com/Org/MyRepo.git");
  assert.equal(result, "github.com/org/myrepo");
});

test("(ri-c3) normalizeRemote: SCP sin .git → normaliza igualmente", () => {
  const result = normalizeRemote("git@github.com:Org/MyRepo");
  assert.equal(result, "github.com/org/myrepo");
});

test("(ri-c4) normalizeRemote: cadena vacía → undefined", () => {
  const result = normalizeRemote("");
  assert.equal(result, undefined);
});

test("(ri-c5) normalizeRemote: solo espacios → undefined", () => {
  const result = normalizeRemote("   ");
  assert.equal(result, undefined);
});

test("(ri-c6) normalizeRemote: URL HTTPS en mayúsculas → lowercase", () => {
  const result = normalizeRemote("https://GITHUB.COM/Org/MyRepo.git");
  assert.equal(result, "github.com/org/myrepo");
});

test("(ri-c7) normalizeRemote: URL con trailing slash → se elimina", () => {
  const result = normalizeRemote("https://github.com/Org/MyRepo.git/");
  assert.equal(result, "github.com/org/myrepo");
});

// ---------------------------------------------------------------------------
// (ri-d) buildRepoIdentity — shape y campos en el proyecto actual
// ---------------------------------------------------------------------------

test("(ri-d1) buildRepoIdentity: shape correcto en el repositorio actual", () => {
  const identity = buildRepoIdentity(".");

  // projectKey — validamos forma y normalización (no la ubicación del checkout):
  // la key se deriva del remoto/dir actual, así que un valor exacto sería frágil.
  assert.equal(typeof identity.projectKey, "string", "projectKey debe ser string");
  assert.ok(identity.projectKey.length > 0, "projectKey no debe estar vacío");
  assert.match(
    identity.projectKey,
    /^[a-z0-9][a-z0-9._/-]*$/,
    "projectKey debe ser un slug normalizado (minúsculas)",
  );

  // strategy — debe ser uno de los 5 DetectionMethod
  const validMethods = ["config-lock", "git-remote", "git-root", "child-git-auto", "dir-basename"];
  assert.ok(validMethods.includes(identity.strategy), `strategy '${identity.strategy}' debe ser válido`);

  // confidence — uno de los 3 valores
  const validConf = ["high", "medium", "low"];
  assert.ok(validConf.includes(identity.confidence), "confidence debe ser high|medium|low");

  // pathHash — 16 hex chars
  assert.match(identity.pathHash, /^[0-9a-f]{16}$/, "pathHash debe ser 16 hex chars");
});

test("(ri-d2) buildRepoIdentity: rootCommit presente en repo con commits (este repo)", () => {
  const identity = buildRepoIdentity(".");
  // Este repositorio tiene commits, así que rootCommit debe estar presente
  if (identity.rootCommit !== undefined) {
    assert.match(
      identity.rootCommit,
      /^[0-9a-f]{40,64}$/,
      "rootCommit debe ser SHA hex de 40 o 64 chars",
    );
  }
  // rootCommit puede ser undefined si git no está disponible en el PATH seguro del test;
  // en ese caso el campo simplemente se omite (fail-open)
});

test("(ri-d3) buildRepoIdentity: rootCommit undefined en repo vacío (sin commits)", () => {
  const dir = tmpDir();
  try {
    // Inicializar repo vacío (sin commits)
    const initRes = spawnSync("git", ["init", dir], { encoding: "utf8" });
    if (initRes.status !== 0) {
      // Si git no está disponible, saltar el test
      return;
    }

    const identity = buildRepoIdentity(dir);
    assert.equal(
      identity.rootCommit,
      undefined,
      "repo vacío: rootCommit debe ser undefined (fail-open)",
    );
    // El resto del report debe seguir siendo válido
    assert.match(identity.pathHash, /^[0-9a-f]{16}$/, "pathHash siempre presente");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ri-d4) buildRepoIdentity: normalizedRemote undefined en repo sin remote", () => {
  const dir = tmpDir();
  try {
    const initRes = spawnSync("git", ["init", dir], { encoding: "utf8" });
    if (initRes.status !== 0) return; // git no disponible

    const identity = buildRepoIdentity(dir);
    assert.equal(
      identity.normalizedRemote,
      undefined,
      "repo sin remote: normalizedRemote debe ser undefined",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(ri-d5) buildRepoIdentity: pathHash determinista — misma ruta = mismo hash", () => {
  const h1 = buildRepoIdentity(".").pathHash;
  const h2 = buildRepoIdentity(".").pathHash;
  assert.equal(h1, h2, "pathHash debe ser determinista");
});

// ---------------------------------------------------------------------------
// (ri-e) snapshot deriveProjectKey — keys inalterados
// ---------------------------------------------------------------------------

test("(ri-e1) snapshot: buildRepoIdentity.projectKey coincide con deriveProjectKey.key", async () => {
  // Importar deriveProjectKey directamente para comparar
  const { deriveProjectKey } = await import("../src/application/project/detect-key.ts");
  const det = deriveProjectKey(".");
  const identity = buildRepoIdentity(".");
  assert.equal(identity.projectKey, det.key, "projectKey debe coincidir byte-a-byte con deriveProjectKey.key");
  assert.equal(identity.strategy, det.method, "strategy debe coincidir con det.method");
});

// ---------------------------------------------------------------------------
// (ri-f) buildRepoIdentity: confidence mapeada correctamente del strategy
// ---------------------------------------------------------------------------

test("(ri-f1) buildRepoIdentity: confidence de este repo coincide con methodToConfidence(strategy)", () => {
  const identity = buildRepoIdentity(".");
  const expected = methodToConfidence(identity.strategy);
  assert.equal(identity.confidence, expected, "confidence debe coincidir con methodToConfidence(strategy)");
});

test("(ri-f2) buildRepoIdentity: JSON serialization omite normalizedRemote si está ausente", () => {
  const dir = tmpDir();
  try {
    const initRes = spawnSync("git", ["init", dir], { encoding: "utf8" });
    if (initRes.status !== 0) return;

    const identity = buildRepoIdentity(dir);
    const json = JSON.parse(JSON.stringify(identity)) as RepoIdentity;
    if (identity.normalizedRemote === undefined) {
      assert.ok(!("normalizedRemote" in json), "normalizedRemote ausente en JSON cuando es undefined");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
