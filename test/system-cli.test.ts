// system-cli.test.ts — CLI integration tests for the system handlers in
// src/cli/handlers/system.ts: sidecar (status/build/clean) + root help, plus the
// top-level dispatcher fallbacks in src/cli/index.ts.
// Run: node --no-warnings --experimental-strip-types --test test/system-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

function tmpHomeEnv(): { env: NodeJS.ProcessEnv; home: string } {
  const home = mkdtempSync(join(tmpdir(), "leina-syscli-home-"));
  return { env: { ...process.env, LEINA_HOME: home }, home };
}

// ---------------------------------------------------------------------------
// sidecar
// ---------------------------------------------------------------------------

test("(SC-1) sidecar (default): prints built/not-built status for csharp + java", () => {
  const { env, home } = tmpHomeEnv();
  try {
    const r = runCli(["sidecar"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /csharp:/);
    assert.match(r.stdout, /java:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("(SC-2) sidecar build <lang>: builds or reports missing toolchain, never throws", () => {
  const { env, home } = tmpHomeEnv();
  try {
    const r = runCli(["sidecar", "build", "csharp"], { env });
    // Either the toolchain is present (Building ...) or it is missing — both exit 0.
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout + r.stderr, /Building csharp|missing build tools/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("(SC-3) sidecar clean: clears the build cache", () => {
  const { env, home } = tmpHomeEnv();
  try {
    const r = runCli(["sidecar", "clean"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Cleaned sidecar build cache\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// root help + dispatcher fallbacks (src/cli/index.ts)
// ---------------------------------------------------------------------------

test("(SC-4) help: prints the root help banner", () => {
  const r = runCli(["help"]);
  assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
  assert.match(r.stdout, /leina — code knowledge graph \+ project memory/);
  assert.match(r.stdout, /memory <dir> <sub>/);
});

test("(SC-5) --help alias prints the same banner", () => {
  const r = runCli(["--help"]);
  assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
  assert.match(r.stdout, /leina — code knowledge graph/);
});

test("(SC-6) unknown command falls back to root help", () => {
  const r = runCli(["definitely-not-a-command"]);
  assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
  assert.match(r.stdout, /^ {2}activate --hosts/m);
});

test("(SC-6b) root help lists every dispatched command family", () => {
  const r = runCli(["help"]);
  assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
  for (const cmd of ["visualize", "workspace", "audit", "events tail", "env", "tui", "sidecar"]) {
    assert.match(r.stdout, new RegExp(`^  ${cmd}`, "m"), `root help must list '${cmd}'; got:\n${r.stdout}`);
  }
});

test("(SC-7) version prints a semver-ish string", () => {
  const r = runCli(["version"]);
  assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});
