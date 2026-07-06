// graph-cli.test.ts — CLI integration tests for the graph command handlers
// (build / refresh / status / stats / affected / path / query) in src/cli/handlers/graph.ts.
// Run: node --no-warnings --experimental-strip-types --test test/graph-cli.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    assert.match(r.stderr, /no node matches/);
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
