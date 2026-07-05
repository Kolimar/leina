// extractor-contract.test.ts — Verifica que los 7 adaptadores cumplen el puerto GraphExtractor.
//
// Cubre: REQ-EP-1, REQ-EP-2, AC-1, AC-2, AC-3, AC-6, REQ-ER-1.
// No modifica test/architecture.test.ts.
//
// Run: node --no-warnings --experimental-strip-types --test test/extractor-contract.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { TsmorphExtractor } from "../src/infrastructure/extractors/semantic/tsmorph.ts";
import { ScipExtractor } from "../src/infrastructure/extractors/semantic/scip.ts";
import { SidecarExtractor } from "../src/infrastructure/extractors/semantic/sidecar.ts";
import { TreesitterExtractor } from "../src/infrastructure/extractors/treesitter.ts";
import { EXTRACTOR_ORDER, orderRegistry } from "../src/application/graph/extractor-registry.ts";
import type { GraphExtractor } from "../src/domain/graph/extractor.ts";

const VERSION = "1.4.0-test";
const fixtureDir = join(import.meta.dirname, "fixtures", "tsmorph-crossfile");
const fixtureFiles = [
  join(fixtureDir, "callee.ts"),
  join(fixtureDir, "caller.ts"),
  join(fixtureDir, "reexport.ts"),
  join(fixtureDir, "top-level-caller.ts"),
];

// ---------------------------------------------------------------------------
// Instanciar los 7 adaptadores
// ---------------------------------------------------------------------------

const tsmorph = new TsmorphExtractor(VERSION);
const scipGo = new ScipExtractor("go", VERSION);
const scipRust = new ScipExtractor("rust", VERSION);
const scipPython = new ScipExtractor("python", VERSION);
const sidecarCs = new SidecarExtractor("csharp", VERSION);
const sidecarJava = new SidecarExtractor("java", VERSION);
const treesitter = new TreesitterExtractor(VERSION);

const allExtractors: GraphExtractor[] = [tsmorph, scipGo, scipRust, scipPython, sidecarCs, sidecarJava, treesitter];

// ---------------------------------------------------------------------------
// REQ-EP-1: Campos obligatorios presentes en cada adaptador
// ---------------------------------------------------------------------------

test("(EC-1) todos los adaptadores tienen id no vacío", () => {
  for (const ext of allExtractors) {
    assert.ok(typeof ext.id === "string" && ext.id.length > 0, `${ext.id}: id debe ser string no vacío`);
  }
});

test("(EC-2) todos los adaptadores tienen version no vacía", () => {
  for (const ext of allExtractors) {
    assert.ok(typeof ext.version === "string" && ext.version.length > 0, `${ext.id}: version debe ser string no vacío`);
  }
});

test("(EC-3) todos los adaptadores tienen supports como función", () => {
  for (const ext of allExtractors) {
    assert.strictEqual(typeof ext.supports, "function", `${ext.id}: supports debe ser función`);
  }
});

test("(EC-4) todos los adaptadores tienen extract como función", () => {
  for (const ext of allExtractors) {
    assert.strictEqual(typeof ext.extract, "function", `${ext.id}: extract debe ser función`);
  }
});

// ---------------------------------------------------------------------------
// REQ-EP-1: verify presente solo en sidecars
// ---------------------------------------------------------------------------

test("(EC-5) verify presente en sidecar-csharp, sidecar-java, scip-go, scip-rust y scip-python", () => {
  assert.strictEqual(typeof sidecarCs.verify, "function", "sidecar-csharp: verify debe ser función");
  assert.strictEqual(typeof sidecarJava.verify, "function", "sidecar-java: verify debe ser función");
  assert.strictEqual(typeof scipGo.verify, "function", "scip-go: verify debe ser función");
  assert.strictEqual(typeof scipRust.verify, "function", "scip-rust: verify debe ser función");
  assert.strictEqual(typeof scipPython.verify, "function", "scip-python: verify debe ser función");
});

test("(EC-6) verify ausente (undefined) en tsmorph y treesitter", () => {
  // Cast a GraphExtractor porque el contrato define verify? como opcional
  assert.strictEqual((tsmorph as GraphExtractor).verify, undefined, "tsmorph: verify debe ser undefined");
  assert.strictEqual((treesitter as GraphExtractor).verify, undefined, "treesitter: verify debe ser undefined");
});

// ---------------------------------------------------------------------------
// Supports correctness
// ---------------------------------------------------------------------------

test("(EC-7) tsmorph.supports reconoce .ts y .tsx pero no .cs/.java/.py", () => {
  assert.ok(tsmorph.supports("foo.ts"), "debe soportar .ts");
  assert.ok(tsmorph.supports("foo.tsx"), "debe soportar .tsx");
  assert.ok(!tsmorph.supports("foo.cs"), "no debe soportar .cs");
  assert.ok(!tsmorph.supports("foo.java"), "no debe soportar .java");
  assert.ok(!tsmorph.supports("foo.py"), "no debe soportar .py");
});

test("(EC-8) sidecar-csharp.supports reconoce solo .cs", () => {
  assert.ok(sidecarCs.supports("foo.cs"), "debe soportar .cs");
  assert.ok(!sidecarCs.supports("foo.java"), "no debe soportar .java");
  assert.ok(!sidecarCs.supports("foo.ts"), "no debe soportar .ts");
});

test("(EC-9) sidecar-java.supports reconoce solo .java", () => {
  assert.ok(sidecarJava.supports("foo.java"), "debe soportar .java");
  assert.ok(!sidecarJava.supports("foo.cs"), "no debe soportar .cs");
  assert.ok(!sidecarJava.supports("foo.ts"), "no debe soportar .ts");
});

test("(EC-9b) scip-go.supports reconoce solo .go", () => {
  assert.ok(scipGo.supports("foo.go"), "debe soportar .go");
  assert.ok(scipGo.supports("FOO.GO"), "debe ser case-insensitive");
  assert.ok(!scipGo.supports("foo.java"), "no debe soportar .java");
  assert.ok(!scipGo.supports("foo.ts"), "no debe soportar .ts");
});

test("(EC-9c) scip-rust.supports reconoce solo .rs", () => {
  assert.ok(scipRust.supports("foo.rs"), "debe soportar .rs");
  assert.ok(scipRust.supports("FOO.RS"), "debe ser case-insensitive");
  assert.ok(!scipRust.supports("foo.go"), "no debe soportar .go");
  assert.ok(!scipRust.supports("foo.ts"), "no debe soportar .ts");
});

test("(EC-9d) scip-python.supports reconoce .py y .pyi", () => {
  assert.ok(scipPython.supports("foo.py"), "debe soportar .py");
  assert.ok(scipPython.supports("foo.pyi"), "debe soportar .pyi (stub)");
  assert.ok(scipPython.supports("FOO.PY"), "debe ser case-insensitive");
  assert.ok(!scipPython.supports("foo.rs"), "no debe soportar .rs");
  assert.ok(!scipPython.supports("foo.ts"), "no debe soportar .ts");
});

test("(EC-10) treesitter.supports reconoce .ts, .py, .go, .java, .cs (catch-all)", () => {
  assert.ok(treesitter.supports("foo.ts"), "debe soportar .ts");
  assert.ok(treesitter.supports("foo.py"), "debe soportar .py");
  assert.ok(treesitter.supports("foo.go"), "debe soportar .go");
  assert.ok(treesitter.supports("foo.java"), "debe soportar .java");
  assert.ok(treesitter.supports("foo.cs"), "debe soportar .cs");
  assert.ok(!treesitter.supports("foo.txt"), "no debe soportar .txt");
});

// ---------------------------------------------------------------------------
// Ids canónicos
// ---------------------------------------------------------------------------

test("(EC-11) ids canónicos correctos", () => {
  assert.strictEqual(tsmorph.id, "tsmorph");
  assert.strictEqual(scipGo.id, "scip-go");
  assert.strictEqual(scipRust.id, "scip-rust");
  assert.strictEqual(scipPython.id, "scip-python");
  assert.strictEqual(sidecarCs.id, "sidecar-csharp");
  assert.strictEqual(sidecarJava.id, "sidecar-java");
  assert.strictEqual(treesitter.id, "treesitter");
});

// ---------------------------------------------------------------------------
// REQ-EP-2: Shape de GraphExtractionResult — tsmorph con fixture real
// ---------------------------------------------------------------------------

test("(EC-12) TsmorphExtractor.extract retorna resultado con shape correcto", async () => {
  const result = await tsmorph.extract(fixtureDir, fixtureFiles);
  assert.strictEqual(result.schemaVersion, 1, "schemaVersion debe ser 1");
  assert.strictEqual(result.extractor.id, "tsmorph", "extractor.id debe ser tsmorph");
  assert.ok(result.extractor.version.length > 0, "extractor.version debe ser no vacío");
  assert.ok(Array.isArray(result.nodes), "nodes debe ser array");
  assert.ok(Array.isArray(result.edges), "edges debe ser array");
  assert.ok(Array.isArray(result.diagnostics), "diagnostics debe ser array");
  assert.ok(Array.isArray(result.errors), "errors debe ser array");
  assert.ok(result.durationMs >= 0, "durationMs debe ser >= 0");
  // tsmorph no expone rawCalls ni imports (son undefined)
  assert.strictEqual(result.rawCalls, undefined, "tsmorph: rawCalls debe ser undefined");
  assert.strictEqual(result.imports, undefined, "tsmorph: imports debe ser undefined");
});

// ---------------------------------------------------------------------------
// REQ-EP-2: Shape de GraphExtractionResult — sidecars (sin toolchain: errors poblados)
// ---------------------------------------------------------------------------

test("(EC-13) SidecarExtractor.extract retorna resultado con shape correcto aunque no esté configurado", async () => {
  const result = await sidecarCs.extract(fixtureDir, [join(fixtureDir, "callee.ts")]);
  assert.strictEqual(result.schemaVersion, 1, "schemaVersion debe ser 1");
  assert.strictEqual(result.extractor.id, "sidecar-csharp", "extractor.id debe ser sidecar-csharp");
  assert.ok(result.extractor.version.length > 0, "extractor.version debe ser no vacío");
  assert.ok(Array.isArray(result.nodes), "nodes debe ser array");
  assert.ok(Array.isArray(result.edges), "edges debe ser array");
  assert.ok(Array.isArray(result.diagnostics), "diagnostics debe ser array");
  assert.ok(Array.isArray(result.errors), "errors debe ser array");
  assert.ok(result.durationMs >= 0, "durationMs debe ser >= 0");
  // sidecars no exponen rawCalls ni imports
  assert.strictEqual(result.rawCalls, undefined, "sidecar-csharp: rawCalls debe ser undefined");
  assert.strictEqual(result.imports, undefined, "sidecar-csharp: imports debe ser undefined");
});

// ---------------------------------------------------------------------------
// REQ-EP-2: Shape de GraphExtractionResult — ScipExtractor (sin toolchain: errors poblados)
// ---------------------------------------------------------------------------

test("(EC-13b) ScipExtractor.extract retorna resultado con shape correcto aunque el indexador no esté disponible", async () => {
  const result = await scipGo.extract(fixtureDir, [join(fixtureDir, "callee.ts")]);
  assert.strictEqual(result.schemaVersion, 1, "schemaVersion debe ser 1");
  assert.strictEqual(result.extractor.id, "scip-go", "extractor.id debe ser scip-go");
  assert.ok(result.extractor.version.length > 0, "extractor.version debe ser no vacío");
  assert.ok(Array.isArray(result.nodes), "nodes debe ser array");
  assert.ok(Array.isArray(result.edges), "edges debe ser array");
  assert.ok(Array.isArray(result.diagnostics), "diagnostics debe ser array");
  assert.ok(Array.isArray(result.errors), "errors debe ser array");
  assert.ok(result.durationMs >= 0, "durationMs debe ser >= 0");
  // scip-go no expone rawCalls ni imports
  assert.strictEqual(result.rawCalls, undefined, "scip-go: rawCalls debe ser undefined");
  assert.strictEqual(result.imports, undefined, "scip-go: imports debe ser undefined");
  // No hay archivos .go en el candidate list del fixture TS -> no reclama nada, errors no vacío
  assert.ok(result.errors.length > 0, "scip-go: sin archivos .go en el candidate list, errors debe ser no vacío");
});

test("(EC-13c) ScipExtractor(rust).extract retorna resultado con shape correcto aunque el indexador no esté disponible", async () => {
  const result = await scipRust.extract(fixtureDir, [join(fixtureDir, "callee.ts")]);
  assert.strictEqual(result.schemaVersion, 1, "schemaVersion debe ser 1");
  assert.strictEqual(result.extractor.id, "scip-rust", "extractor.id debe ser scip-rust");
  assert.ok(result.extractor.version.length > 0, "extractor.version debe ser no vacío");
  assert.ok(Array.isArray(result.nodes), "nodes debe ser array");
  assert.ok(Array.isArray(result.edges), "edges debe ser array");
  assert.ok(Array.isArray(result.diagnostics), "diagnostics debe ser array");
  assert.ok(Array.isArray(result.errors), "errors debe ser array");
  assert.ok(result.durationMs >= 0, "durationMs debe ser >= 0");
  assert.strictEqual(result.rawCalls, undefined, "scip-rust: rawCalls debe ser undefined");
  assert.strictEqual(result.imports, undefined, "scip-rust: imports debe ser undefined");
  // No hay archivos .rs en el candidate list del fixture TS -> no reclama nada, errors no vacío
  assert.ok(result.errors.length > 0, "scip-rust: sin archivos .rs en el candidate list, errors debe ser no vacío");
});

test("(EC-13d) ScipExtractor(python).extract retorna resultado con shape correcto aunque el indexador no esté disponible", async () => {
  const result = await scipPython.extract(fixtureDir, [join(fixtureDir, "callee.ts")]);
  assert.strictEqual(result.schemaVersion, 1, "schemaVersion debe ser 1");
  assert.strictEqual(result.extractor.id, "scip-python", "extractor.id debe ser scip-python");
  assert.ok(result.extractor.version.length > 0, "extractor.version debe ser no vacío");
  assert.ok(Array.isArray(result.nodes), "nodes debe ser array");
  assert.ok(Array.isArray(result.edges), "edges debe ser array");
  assert.ok(Array.isArray(result.diagnostics), "diagnostics debe ser array");
  assert.ok(Array.isArray(result.errors), "errors debe ser array");
  assert.ok(result.durationMs >= 0, "durationMs debe ser >= 0");
  assert.strictEqual(result.rawCalls, undefined, "scip-python: rawCalls debe ser undefined");
  assert.strictEqual(result.imports, undefined, "scip-python: imports debe ser undefined");
  // No hay archivos .py/.pyi en el candidate list del fixture TS -> no reclama nada, errors no vacío
  assert.ok(result.errors.length > 0, "scip-python: sin archivos .py en el candidate list, errors debe ser no vacío");
});

// ---------------------------------------------------------------------------
// REQ-EP-2: Shape de GraphExtractionResult — TreesitterExtractor con fixture
// ---------------------------------------------------------------------------

test("(EC-14) TreesitterExtractor.extract retorna resultado con shape correcto + rawCalls poblados", async () => {
  const result = await treesitter.extract(fixtureDir, fixtureFiles);
  assert.strictEqual(result.schemaVersion, 1, "schemaVersion debe ser 1");
  assert.strictEqual(result.extractor.id, "treesitter", "extractor.id debe ser treesitter");
  assert.ok(result.extractor.version.length > 0, "extractor.version debe ser no vacío");
  assert.ok(Array.isArray(result.nodes), "nodes debe ser array");
  assert.ok(Array.isArray(result.edges), "edges debe ser array");
  assert.ok(Array.isArray(result.diagnostics), "diagnostics debe ser array");
  assert.ok(Array.isArray(result.errors), "errors debe ser array");
  assert.ok(result.durationMs >= 0, "durationMs debe ser >= 0");
  // Override D1: treesitter SÍ expone rawCalls/imports para resolveSymbols() global
  assert.ok(Array.isArray(result.rawCalls), "treesitter: rawCalls debe ser array (override D1)");
  assert.ok(Array.isArray(result.imports), "treesitter: imports debe ser array (override D1)");
});

// ---------------------------------------------------------------------------
// REQ-ER-1: Orden canónico del registry via orderRegistry
// ---------------------------------------------------------------------------

test("(EC-15) orderRegistry ordena según EXTRACTOR_ORDER canónico", () => {
  // Crear array desordenado
  const unordered: GraphExtractor[] = [treesitter, sidecarCs, tsmorph, sidecarJava, scipRust, scipGo, scipPython];
  const ordered = orderRegistry(unordered);
  assert.strictEqual(ordered[0]?.id, "tsmorph", "primero debe ser tsmorph");
  assert.strictEqual(ordered[1]?.id, "scip-go", "segundo debe ser scip-go");
  assert.strictEqual(ordered[2]?.id, "scip-rust", "tercero debe ser scip-rust");
  assert.strictEqual(ordered[3]?.id, "scip-python", "cuarto debe ser scip-python");
  assert.strictEqual(ordered[4]?.id, "sidecar-csharp", "quinto debe ser sidecar-csharp");
  assert.strictEqual(ordered[5]?.id, "sidecar-java", "sexto debe ser sidecar-java");
  assert.strictEqual(ordered[6]?.id, "treesitter", "séptimo debe ser treesitter (fallback)");
});

test("(EC-16) EXTRACTOR_ORDER tiene 7 entradas en el orden correcto", () => {
  assert.strictEqual(EXTRACTOR_ORDER.length, 7);
  assert.strictEqual(EXTRACTOR_ORDER[0], "tsmorph");
  assert.strictEqual(EXTRACTOR_ORDER[1], "scip-go");
  assert.strictEqual(EXTRACTOR_ORDER[2], "scip-rust");
  assert.strictEqual(EXTRACTOR_ORDER[3], "scip-python");
  assert.strictEqual(EXTRACTOR_ORDER[4], "sidecar-csharp");
  assert.strictEqual(EXTRACTOR_ORDER[5], "sidecar-java");
  assert.strictEqual(EXTRACTOR_ORDER[6], "treesitter");
});

test("(EC-17) scip-go reclama .go antes que treesitter (claim-before-fallback)", () => {
  const unordered: GraphExtractor[] = [treesitter, scipGo];
  const ordered = orderRegistry(unordered);
  assert.strictEqual(ordered[0]?.id, "scip-go", "scip-go debe preceder a treesitter para .go");
  assert.strictEqual(ordered[1]?.id, "treesitter");
});

test("(EC-17b) scip-rust reclama .rs antes que treesitter (claim-before-fallback)", () => {
  const unordered: GraphExtractor[] = [treesitter, scipRust];
  const ordered = orderRegistry(unordered);
  assert.strictEqual(ordered[0]?.id, "scip-rust", "scip-rust debe preceder a treesitter para .rs");
  assert.strictEqual(ordered[1]?.id, "treesitter");
});

test("(EC-17c) scip-python reclama .py antes que treesitter (claim-before-fallback)", () => {
  const unordered: GraphExtractor[] = [treesitter, scipPython];
  const ordered = orderRegistry(unordered);
  assert.strictEqual(ordered[0]?.id, "scip-python", "scip-python debe preceder a treesitter para .py");
  assert.strictEqual(ordered[1]?.id, "treesitter");
});
