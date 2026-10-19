// graph-cli.test.ts — CLI integration tests for the graph command handlers
// (build / refresh / status / stats / affected / path / query) in src/cli/handlers/graph.ts.
// Run: node --no-warnings --experimental-strip-types --test test/graph-cli.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

// `build`/`refresh` opportunistically upsert into the global project registry
// (~/.leina/projects.json). Sandbox LEINA_HOME so these CLI-integration tests never
// touch the developer's real global state.
const sandboxHome = mkdtempSync(join(tmpdir(), "leina-graphcli-home-"));
after(() => rmSync(sandboxHome, { recursive: true, force: true }));

function runCli(args: string[]): RunResult {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", env: { ...process.env, LEINA_HOME: sandboxHome } },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

// A tiny TS project where alpha() calls beta() — gives us at least one call edge so
// affected / path / query have something to resolve.
function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "leina-graphcli-"));
  writeFileSync(join(dir, "b.ts"), `export function beta(): number { return 1; }\n`);
  writeFileSync(
    join(dir, "a.ts"),
    `import { beta } from "./b.ts";\nexport function alpha(): number { return beta(); }\n`,
  );
  return dir;
}

test("(GC-1) build: produces a graph and reports node/edge counts", () => {
  const dir = tmpProject();
  try {
    const r = runCli(["build", dir]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Building graph for/);
    assert.match(r.stdout, /Done\. \d+ nodes, \d+ edges from/);
    assert.ok(existsSync(join(dir, ".leina", "graph.db")), "graph.db written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-2) build --json: also exports graph.json", () => {
  const dir = tmpProject();
  try {
    const r = runCli(["build", dir, "--json"]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /exported .*graph\.json/);
    assert.ok(existsSync(join(dir, ".leina", "graph.json")), "graph.json written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-3) refresh: rebuilds the graph", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    const r = runCli(["refresh", dir]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Rebuilding graph for/);
    assert.match(r.stdout, /Done\. \d+ nodes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-3b) refresh re-extracts every file; a second build reuses the cache", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    // An unchanged rebuild reuses the per-file TypeScript extraction cache...
    const again = runCli(["build", dir]);
    assert.equal(again.code, 0, `exit 0. stderr: ${again.stderr}`);
    assert.match(again.stderr, /ts extract cache: \d+ reused, 0 re-extracted/);
    // ...refresh, the escape hatch from any cache problem, never does.
    const r = runCli(["refresh", dir]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /ts extract cache/, "refresh extracts everything");
    // And it leaves a cache the next build can reuse again.
    assert.match(runCli(["build", dir]).stderr, /ts extract cache: \d+ reused, 0 re-extracted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-4) status: reports freshness, posture and last build", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    const r = runCli(["status", dir]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /status: (fresh|STALE)/);
    assert.match(r.stdout, /posture: (auto|refuse)/);
    assert.match(r.stdout, /built:/);
    assert.match(r.stdout, /tracked files: \d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-5) stats: prints node/edge counts + confidence breakdown", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    const r = runCli(["stats", dir]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /nodes: \d+/);
    assert.match(r.stdout, /edges: \d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-6) affected: prints the blast radius for a resolved symbol", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    const r = runCli(["affected", dir, "beta"]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Blast radius of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-7) affected: unknown symbol fails with a message", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    const r = runCli(["affected", dir, "doesNotExistSymbol"]);
    assert.notEqual(r.code, 0, "should fail for an unknown symbol");
    assert.match(r.stderr, /no exact match for "doesNotExistSymbol"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-13) affected/path: a near-miss is never resolved by substring — did-you-mean + exit 1", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    // "alph" is a substring of alpha(): it used to resolve silently.
    const r = runCli(["affected", dir, "alph"]);
    assert.equal(r.code, 1, `exit 1. stdout: ${r.stdout}`);
    assert.match(r.stderr, /no exact match for "alph"; did you mean:\n {2}alpha +a\.ts:2/);
    assert.doesNotMatch(r.stdout, /Blast radius/);
    const p = runCli(["path", dir, "alpha", "bet"]);
    assert.equal(p.code, 1);
    assert.match(p.stderr, /no exact match for "bet"; did you mean:\n {2}beta /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-14) affected: an ambiguous name uses the best match and lists the others with selectors", () => {
  const dir = tmpProject();
  try {
    writeFileSync(join(dir, "c.ts"), `export function beta(): number { return 2; }\n`);
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test", "beta.test.ts"), `export function beta(): number { return 3; }\n`);
    runCli(["build", dir]);
    const r = runCli(["affected", dir, "beta"]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    // Production before tests, then path order: b.ts wins over c.ts and test/beta.test.ts.
    assert.match(r.stderr, /^note: "beta" matches 3 nodes; using b\.ts:beta \(b\.ts:1\)/);
    assert.match(r.stderr, /\n {2}c\.ts:beta +c\.ts:1\n {2}test\/beta\.test\.ts:beta +test\/beta\.test\.ts:1/);
    assert.match(r.stdout, /Blast radius of beta\(\) \(b\.ts/);
    // The listed selector picks that node, unambiguously (no note).
    const pick = runCli(["affected", dir, "c.ts:beta"]);
    assert.equal(pick.stderr, "");
    assert.match(pick.stdout, /Blast radius of beta\(\) \(c\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-8) affected: missing args prints usage and fails", () => {
  const r = runCli(["affected"]);
  assert.notEqual(r.code, 0, "should fail without <dir>");
  assert.match(r.stderr, /usage: affected/);
});

test("(GC-9) path: prints a path or a 'no path' notice", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    const r = runCli(["path", dir, "alpha", "beta"]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /alpha|No path between/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-15) affected prints the call-site line; path prints the real edge direction", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-graphcli-loc-"));
  try {
    writeFileSync(join(dir, "b.ts"), `export function beta(): number { return 1; }\n`);
    writeFileSync(
      join(dir, "a.ts"),
      `import { beta } from "./b.ts";\nexport function alpha(): number {\n  const x = 1;\n  return beta() + x;\n}\n`,
    );
    writeFileSync(join(dir, "c.ts"), `import { beta } from "./b.ts";\n\n\nbeta();\nexport const v = beta();\n`);
    runCli(["build", dir]);
    const r = runCli(["affected", dir, "beta"]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Blast radius of beta\(\) \(b\.ts:1\):/);
    assert.match(r.stdout, /alpha\(\) {2}\[calls\] {2}a\.ts:4\n/, "call at L4, not alpha's definition at L2");
    assert.match(r.stdout, /c\.ts {2}\[calls\] {2}c\.ts:4\n/, "module-level caller keeps its line");
    assert.match(r.stdout, /v {2}\[calls\] {2}c\.ts:5\n/, "a top-level initializer's call belongs to its variable");
    const fwd = runCli(["path", dir, "alpha", "beta"]);
    assert.match(fwd.stdout, /^alpha\(\) {2}\(a\.ts:2\)\n {2}--calls\(EXTRACTED\)--> beta\(\) {2}a\.ts:4\n$/);
    const back = runCli(["path", dir, "beta", "alpha"]);
    assert.match(back.stdout, /^beta\(\) {2}\(b\.ts:1\)\n {2}<--calls\(EXTRACTED\)-- alpha\(\) {2}a\.ts:4\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-10) query: prints seeds and subgraph summary", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    const r = runCli(["query", dir, "beta"]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Seeds:/);
    assert.match(r.stdout, /Subgraph: \d+ nodes, \d+ edges/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-12) query --json: prints the graph.query output contract, flag kept out of the question", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    const text = runCli(["query", dir, "beta"]);
    // The flag may sit anywhere after <dir>; it must never become a search term.
    for (const args of [["query", dir, "beta", "--json"], ["query", dir, "--json", "beta"]]) {
      const r = runCli(args);
      assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout) as { seeds: string[]; nodes: Record<string, unknown>[]; edges: unknown[] };
      // graphQueryOutputSchema: required seeds/nodes/edges arrays.
      for (const k of ["seeds", "nodes", "edges"] as const) assert.ok(Array.isArray(out[k]), `${k} is an array`);
      // Compact shape: seeds are ids, the first nodes; every node is {id, label, kind, at}.
      assert.equal(out.nodes[0]?.id, out.seeds[0]);
      assert.equal(out.nodes[0]?.label, "beta()", "same top seed as the text output");
      for (const n of out.nodes) assert.deepEqual(Object.keys(n).sort(), ["at", "id", "kind", "label"]);
      assert.match(text.stdout, new RegExp(`Subgraph: ${out.nodes.length} nodes, ${out.edges.length} edges`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(GC-11) read on a dir with no graph fails with a build hint", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-graphcli-empty-"));
  try {
    const r = runCli(["query", dir, "anything"]);
    assert.notEqual(r.code, 0, "should fail when there is no graph");
    assert.match(r.stderr, /No graph at .*Run: leina build/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
