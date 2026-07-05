// wiring-cli.test.ts — CLI integration tests for the composition-root paths in
// src/cli/wiring.ts that the happy-path tests don't reach: the stale→auto-rebuild
// branch of openFreshStore, the "refuse" posture, and the lazy graph open in
// openMemoryRepo (anchor resolution with / without a graph.db).
// Run: node --no-warnings --experimental-strip-types --test test/wiring-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): RunResult {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", env: opts.env ?? process.env },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "leina-wiringcli-"));
  writeFileSync(join(dir, "b.ts"), `export function beta(): number { return 1; }\n`);
  writeFileSync(
    join(dir, "a.ts"),
    `import { beta } from "./b.ts";\nexport function alpha(): number { return beta(); }\n`,
  );
  return dir;
}

test("(WC-1) openFreshStore: stale graph auto-rebuilds before serving", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    // Add a new source file → the tracked file set changes → graph is stale.
    writeFileSync(join(dir, "c.ts"), `export function gamma(): number { return 2; }\n`);
    const r = runCli(["query", dir, "gamma"]);
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stderr, /graph stale .*rebuilding/s);
    // gamma only resolves if the rebuild actually happened.
    assert.match(r.stdout, /Seeds:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(WC-2) refuse posture: stale read fails and instructs to refresh", () => {
  const dir = tmpProject();
  try {
    runCli(["build", dir]);
    writeFileSync(join(dir, "c.ts"), `export function gamma(): number { return 2; }\n`);
    const env = { ...process.env, LEINA_FRESHNESS: "refuse" };
    const r = runCli(["query", dir, "gamma"], { env });
    assert.notEqual(r.code, 0, "should refuse to rebuild");
    assert.match(r.stderr, /freshness posture is "refuse"/);
    assert.match(r.stderr, /leina refresh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(WC-3) save --anchors with a built graph resolves against it", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-wiringcli-home-"));
  const dir = tmpProject();
  try {
    const env = { ...process.env, LEINA_HOME: home };
    runCli(["build", dir], { env });
    // Anchors trigger the lazy graph open inside openMemoryRepo (getGraph, graph present).
    const r = runCli(
      ["memory", "save", dir, "--title", "Anchored", "--content", "C", "--anchors", "alpha,beta"],
      { env },
    );
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Saved .* \(new\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(WC-4) save --anchors with no graph still succeeds (anchors unresolved)", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-wiringcli-home2-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-wiringcli-no3-"));
  try {
    const env = { ...process.env, LEINA_HOME: home };
    // No `build` → no graph.db → getGraph throws → anchors degrade to unresolved, save still ok.
    const r = runCli(
      ["memory", "save", dir, "--title", "NoGraph", "--content", "C", "--anchors", "whatever"],
      { env },
    );
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Saved .* \(new\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
