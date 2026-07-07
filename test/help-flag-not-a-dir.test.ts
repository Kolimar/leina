// test/help-flag-not-a-dir.test.ts
//
// Regression guard: `--help` / `-h` after a subcommand must print help and MUST NOT be
// consumed as the <dir> positional. Several handlers (status/stats/affected/path/query)
// resolve <dir> from their first arg; before the fix, `leina stats --help` (etc.) treated
// "--help" as a directory and opened/built a graph in a folder literally named "--help"
// (a stray `--help/.leina/graph.db` appeared in the repo). Two layers now prevent it:
//   1. the dispatcher intercepts --help/-h before delegating and prints root help;
//   2. the dir-resolving handlers reject a leading "--" token as a directory.
//
// This test spawns the real CLI in a temp cwd and asserts, for each form, that (a) root
// help is printed, (b) exit code is 0, and (c) no "--help"/"-h" directory is created.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const HELP_MARKER = "code knowledge graph + project memory";

function runCli(args: string[], cwd: string): { stdout: string; code: number } {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", cwd },
  );
  return { stdout: r.stdout ?? "", code: r.status ?? 1 };
}

// Each case is a subcommand invocation where "--help"/"-h" lands in (or before) the <dir>
// positional slot. None may create a directory named after the flag.
const CASES: string[][] = [
  ["stats", "--help"],
  ["status", "--help"],
  ["build", "--help"],
  ["refresh", "--help"],
  ["query", "--help", "someterm"],
  ["affected", "--help", "SomeSymbol"],
  ["path", "--help", "a", "b"],
  ["graph", "serve", "--help"],
  ["stats", "-h"],
  ["visualize", "--help"],
];

for (const args of CASES) {
  test(`\`leina ${args.join(" ")}\` prints help and creates no flag-named dir`, () => {
    const dir = mkdtempSync(join(tmpdir(), "leina-help-"));
    try {
      const { stdout, code } = runCli(args, dir);
      assert.equal(code, 0, `expected exit 0, got ${code}`);
      assert.ok(stdout.includes(HELP_MARKER), "expected root help on stdout");
      assert.ok(!existsSync(join(dir, "--help")), "must not create a '--help' directory");
      assert.ok(!existsSync(join(dir, "-h")), "must not create a '-h' directory");
      // Nothing at all should be written to cwd by a help invocation.
      assert.deepEqual(readdirSync(dir), [], "help invocation must not write to cwd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
