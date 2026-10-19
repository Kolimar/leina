// ts-incremental.test.ts — incremental TypeScript extraction.
// Contract: after any edit, the cached extraction (re-extracting only what the edit can reach)
// returns exactly what a full extraction of the edited project returns — same nodes, same
// edges, same order — and it re-extracts no more than the planner says it must.
// Run: node --no-warnings --experimental-strip-types --test test/ts-incremental.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  extractTsProject,
  extractTsProjectCached,
  type TsCachedExtraction,
} from "../src/infrastructure/extractors/semantic/tsmorph.ts";
import { fileFacts } from "../src/infrastructure/extractors/semantic/ts-facts.ts";
import { planTsExtraction } from "../src/infrastructure/extractors/semantic/ts-plan.ts";
import type { TsCachedFile } from "../src/infrastructure/sqlite/ts-extract-cache.ts";

const { ts } = await import("ts-morph");

const SANDBOX = mkdtempSync(join(tmpdir(), "leina-tsinc-"));
process.env.HOME = join(SANDBOX, "home");
process.env.LEINA_HOME = join(SANDBOX, "leina-home");
delete process.env.LEINA_TS_FULL_EXTRACT;
test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Fixture project
// ---------------------------------------------------------------------------

const PROJECT: Record<string, string> = {
  "a.ts": [
    "export function alpha(x: number): number {",
    "  return x + 1;",
    "}",
    "export function alphaV2(x: number): number {",
    "  return x * 2;",
    "}",
    "",
  ].join("\n"),
  "b.ts": 'import { alpha } from "./a";\nexport function beta(): number {\n  return alpha(1);\n}\n',
  "index.ts": 'export { alpha } from "./a";\nexport { beta } from "./b";\n',
  "c.ts": 'import { alpha, beta } from "./index";\nexport function gamma(): number {\n  return alpha(2) + beta();\n}\n',
  "iface.ts": "export interface Port {\n  run(): void;\n  stop(): void;\n}\n",
  "impl.ts": [
    'import type { Port } from "./iface";',
    "export class Impl implements Port {",
    "  run(): void {}",
    "  stop(): void {}",
    "}",
    "",
  ].join("\n"),
  "d.ts": "export const helper = (): number => 3;\n",
  "e.ts": 'import { helper } from "./d";\nexport function eps(): number {\n  return helper();\n}\n',
  "lib/index.ts": "export function libFn(): number {\n  return 1;\n}\n",
  "uses-lib.ts": 'import { libFn } from "./lib";\nexport function useLib(): number {\n  return libFn();\n}\n',
  "lonely.ts": "export function lonely(): string {\n  return 'x';\n}\n",
};

function makeProject(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(SANDBOX, "p-"));
  for (const [rel, text] of Object.entries({ ...PROJECT, ...extra })) write(root, rel, text);
  return root;
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function edit(root: string, rel: string, from: string, to: string): void {
  const p = join(root, rel);
  const before = readFileSync(p, "utf8");
  assert.ok(before.includes(from), `${rel} contains ${from}`);
  writeFileSync(p, before.replace(from, to));
}

function tsFiles(root: string, rels: string[]): string[] {
  return rels.filter((r) => r.endsWith(".ts")).sort().map((r) => join(root, r));
}

const run = (root: string, rels: string[], fullExtraction?: string): TsCachedExtraction =>
  extractTsProjectCached(root, tsFiles(root, rels), { version: "test", fullExtraction });

/** The incremental result equals a full extraction of the same files, order included. */
function assertSameAsFull(root: string, rels: string[], inc: TsCachedExtraction): void {
  const full = extractTsProject(root, tsFiles(root, rels));
  assert.deepStrictEqual(inc.nodes, full.nodes, "nodes identical to a full extraction");
  assert.deepStrictEqual(inc.edges, full.edges, "edges identical to a full extraction");
}

const has = (r: TsCachedExtraction, s: string, rel: string, t: string): boolean =>
  r.edges.some((e) => e.source === s && e.relation === rel && e.target === t);

const RELS = Object.keys(PROJECT);

// ---------------------------------------------------------------------------
// Incremental == full, per kind of edit
// ---------------------------------------------------------------------------

test("(inc-1) no change: every result is reused", () => {
  const root = makeProject();
  const first = run(root, RELS);
  assert.equal(first.full, "no cached extraction");
  const again = run(root, RELS);
  assert.equal(again.full, null);
  assert.equal(again.extracted, 0);
  assert.equal(again.reused, RELS.length);
  assertSameAsFull(root, RELS, again);
});

test("(inc-2) edit a function body: only that file is re-extracted", () => {
  const root = makeProject();
  run(root, RELS);
  edit(root, "a.ts", "return x + 1;", "const y = x;\n  return y + 1;");
  const inc = run(root, RELS);
  assert.equal(inc.full, null);
  assert.equal(inc.extracted, 1, "an annotated body is invisible to the importers");
  assertSameAsFull(root, RELS, inc);
});

test("(inc-3) rename an exported function used elsewhere: the importers follow", () => {
  const root = makeProject();
  run(root, RELS);
  edit(root, "a.ts", "function alpha(", "function first(");
  edit(root, "b.ts", "import { alpha }", "import { first }");
  edit(root, "b.ts", "return alpha(1)", "return first(1)");
  edit(root, "index.ts", "export { alpha }", "export { first as alpha }");
  const inc = run(root, RELS);
  assert.equal(inc.full, null);
  assert.equal(inc.extracted, 4, "a, b, index (edited) + c (imports index)");
  assert.ok(has(inc, "c_ts:gamma", "calls", "a_ts:first"));
  assertSameAsFull(root, RELS, inc);
});

test("(inc-4) delete a file: its importers lose their edges", () => {
  const root = makeProject();
  run(root, RELS);
  unlinkSync(join(root, "d.ts"));
  const rels = RELS.filter((r) => r !== "d.ts");
  const inc = run(root, rels);
  assert.equal(inc.full, null);
  assert.equal(inc.extracted, 1, "e.ts");
  assert.ok(!has(inc, "e_ts:eps", "calls", "d_ts:helper"));
  assertSameAsFull(root, rels, inc);
});

test("(inc-5) add a file: it is extracted, and imports that now resolve to it follow", () => {
  const root = makeProject();
  run(root, RELS);
  write(root, "f.ts", 'import { alpha } from "./a";\nexport function phi(): number {\n  return alpha(3);\n}\n');
  // `./lib` resolved to lib/index.ts; lib.ts now takes precedence.
  write(root, "lib.ts", "export function libFn(): number {\n  return 2;\n}\n");
  const rels = [...RELS, "f.ts", "lib.ts"];
  const inc = run(root, rels);
  assert.equal(inc.full, null);
  assert.equal(inc.extracted, 3, "f.ts, lib.ts, uses-lib.ts");
  assert.ok(has(inc, "uses_lib_ts:uselib", "calls", "lib_ts:libfn"));
  assert.ok(has(inc, "f_ts:phi", "calls", "a_ts:alpha"));
  assertSameAsFull(root, rels, inc);
});

test("(inc-6) change an interface member: the implementations follow", () => {
  const root = makeProject();
  run(root, RELS);
  edit(root, "iface.ts", "stop(): void;", "halt(): void;");
  const inc = run(root, RELS);
  assert.equal(inc.full, null);
  assert.equal(inc.extracted, 2, "iface.ts + impl.ts");
  assert.ok(!has(inc, "impl_ts_impl:stop", "implements", "iface_ts_port:stop"));
  assert.ok(has(inc, "impl_ts_impl:run", "implements", "iface_ts_port:run"));
  assertSameAsFull(root, RELS, inc);
});

test("(inc-7) change a re-export: callers through the barrel move to the new target", () => {
  const root = makeProject();
  run(root, RELS);
  edit(root, "index.ts", "export { alpha }", "export { alphaV2 as alpha }");
  const inc = run(root, RELS);
  assert.equal(inc.full, null);
  assert.equal(inc.extracted, 2, "index.ts + c.ts");
  assert.ok(has(inc, "c_ts:gamma", "calls", "a_ts:alphav2"));
  assert.ok(!has(inc, "c_ts:gamma", "calls", "a_ts:alpha"));
  assertSameAsFull(root, RELS, inc);
});

test("(inc-8) a global declaration change, a changed non-listed import and the build's reason force a full extraction", () => {
  const root = makeProject({
    "globals.d.ts": "declare global {\n  interface Window { leina: number }\n}\nexport {};\n",
    "util.js": "export const k = 1;\n",
    "uses-js.ts": 'import { k } from "./util.js";\nexport function useJs(): number {\n  return k;\n}\n',
  });
  const rels = [...RELS, "globals.d.ts", "uses-js.ts"];
  run(root, rels);
  edit(root, "globals.d.ts", "leina: number", "leina: string");
  assert.match(run(root, rels).full ?? "", /^global declarations changed: globals\.d\.ts$/);
  edit(root, "util.js", "k = 1", "k = 2");
  assert.equal(run(root, rels).full, "dependency changed: util.js");
  assert.equal(run(root, rels, "extractor changed").full, "extractor changed");
  const settled = run(root, rels);
  assert.equal(settled.full, null);
  assertSameAsFull(root, rels, settled);
});

// ---------------------------------------------------------------------------
// Shape: what other files can observe of a file
// ---------------------------------------------------------------------------

function shapeOf(text: string): string {
  return fileFacts(ts.createSourceFile("/x/s.ts", text, ts.ScriptTarget.Latest, true), "s.ts").shape;
}

test("(shape-1) annotated bodies are private; inferred ones, signatures and comments are not", () => {
  const base = "export function f(a: number): number {\n  return a;\n}\n";
  assert.equal(shapeOf(base), shapeOf(base.replace("return a;", "return a + 1;")), "annotated body");
  const inferred = "export function f(a: number) {\n  return a;\n}\n";
  assert.notEqual(shapeOf(inferred), shapeOf(inferred.replace("return a;", "return String(a);")));
  assert.notEqual(shapeOf(base), shapeOf(base.replace("a: number)", "a: string)")), "signature");
  const annotatedConst = "export const n: number = 1;\n";
  assert.equal(shapeOf(annotatedConst), shapeOf("export const n: number = 2;\n"));
  assert.notEqual(shapeOf("export const n = 1;\n"), shapeOf("export const n = 2;\n"), "inferred const");
});

test("(shape-2) a constructor body is shape when it types an unannotated property", () => {
  const typed = "export class C {\n  x: number;\n  constructor() {\n    this.x = 1;\n  }\n}\n";
  assert.equal(shapeOf(typed), shapeOf(typed.replace("this.x = 1", "this.x = 2")));
  const inferred = "export class C {\n  x;\n  constructor() {\n    this.x = 1;\n  }\n}\n";
  assert.notEqual(shapeOf(inferred), shapeOf(inferred.replace("this.x = 1", "this.x = 'one'")));
});

test("(shape-3) the node ids are shape even behind an annotation", () => {
  const lit = "export const h: object = {\n  build(): void {}\n};\n";
  assert.notEqual(shapeOf(lit), shapeOf(lit.replace("build()", "make()")));
});

test("(shape-4) scripts, augmentations and triple-slash directives are global", () => {
  const isGlobal = (text: string): boolean =>
    fileFacts(ts.createSourceFile("/x/g.ts", text, ts.ScriptTarget.Latest, true), "g.ts").global;
  assert.equal(isGlobal("const x = 1;\n"), true, "script");
  assert.equal(isGlobal("export {};\ndeclare global {\n  var x: number;\n}\n"), true);
  assert.equal(isGlobal('import "x";\ndeclare module "x" {\n  const y: number;\n}\n'), true);
  assert.equal(isGlobal('/// <reference types="node" />\nexport const a = 1;\n'), true);
  assert.equal(isGlobal("export const a = 1;\n"), false);
});

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

function cachedFile(hash: string, specs: [string, string | null][], shape = "s", global = false): TsCachedFile {
  return { hash, shape, global, specs: specs.map(([text, to]) => [text, null, to]) };
}

test("(plan-1) seeds reach importers transitively; body-only edits stay local", () => {
  const cached = new Map<string, TsCachedFile>([
    ["a.ts", cachedFile("1", [])],
    ["b.ts", cachedFile("1", [["./a", "a.ts"]])],
    ["c.ts", cachedFile("1", [["./b", "b.ts"]])],
    ["z.ts", cachedFile("1", [])],
  ]);
  const current = new Map([
    ["a.ts", "2"],
    ["b.ts", "1"],
    ["c.ts", "1"],
    ["z.ts", "1"],
  ]);
  const base = { current, cached, resolve: (_: string, s: [string, number | null, string | null]) => s[2], fullRatio: 1 };
  const local = planTsExtraction({ ...base, factsOf: () => ({ shape: "s", global: false }) });
  assert.deepStrictEqual(local, { kind: "incremental", dirty: new Set(["a.ts"]) });
  const ripple = planTsExtraction({ ...base, factsOf: () => ({ shape: "t", global: false }) });
  assert.deepStrictEqual(ripple, { kind: "incremental", dirty: new Set(["a.ts", "b.ts", "c.ts"]) });
  const global = planTsExtraction({ ...base, factsOf: () => ({ shape: "s", global: true }) });
  assert.equal(global.kind, "full");
  const half = planTsExtraction({ ...base, fullRatio: 0.5, factsOf: () => ({ shape: "t", global: false }) });
  assert.deepStrictEqual(half, { kind: "full", reason: "3 of 4 files affected" });
});

// ---------------------------------------------------------------------------
// Through buildGraph: the incremental rebuild stores the graph a fresh build stores
// ---------------------------------------------------------------------------

async function buildCapturing(root: string): Promise<{ nodes: string[]; edges: string[]; err: string }> {
  const { buildGraph } = await import("../src/application/graph/build.ts");
  const { buildDefaultRegistry } = await import("../src/cli/wiring.ts");
  const { GraphStore } = await import("../src/infrastructure/sqlite/graph-store.ts");
  const original = process.stderr.write.bind(process.stderr);
  let err = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  mkdirSync(join(root, ".leina"), { recursive: true });
  const store = new GraphStore(join(root, ".leina", "graph.db"));
  try {
    await buildGraph(root, store, await buildDefaultRegistry());
    const nodes = store.allNodes().map((n) => JSON.stringify(n)).sort();
    const edges = store.allEdges().map((e) => JSON.stringify(e)).sort();
    return { nodes, edges, err };
  } finally {
    store.close();
    process.stderr.write = original;
  }
}

test("(inc-9) buildGraph: an incremental rebuild stores exactly what a fresh build stores", async () => {
  const root = makeProject();
  const first = await buildCapturing(root);
  assert.doesNotMatch(first.err, /ts extract cache/, "the first build extracts everything, silently");
  edit(root, "iface.ts", "stop(): void;", "halt(): void;");
  edit(root, "a.ts", "return x + 1;", "return x + 3;");
  const inc = await buildCapturing(root);
  assert.match(inc.err, /ts extract cache: 8 reused, 3 re-extracted/);

  const fresh = makeProject();
  edit(fresh, "iface.ts", "stop(): void;", "halt(): void;");
  edit(fresh, "a.ts", "return x + 1;", "return x + 3;");
  const full = await buildCapturing(fresh);
  assert.deepStrictEqual(inc.nodes, full.nodes);
  assert.deepStrictEqual(inc.edges, full.edges);
});
