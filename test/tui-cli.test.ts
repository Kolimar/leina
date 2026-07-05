// tui-cli.test.ts — `leina tui` contract that survives CI: it must refuse to start
// without an interactive terminal and point at the non-interactive equivalents. (The
// interactive flows are thin dispatchers over the same handlers the flag commands use —
// exercised via activate/init/repair/env tests.)
// Run: node --no-warnings --experimental-strip-types --test test/tui-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

test("(tui-1) without a TTY: exit 1 and name the non-interactive equivalents", () => {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "tui"],
    { encoding: "utf8" }, // spawned pipes → no TTY on stdin/stdout
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr ?? "", /interactive terminal/);
  assert.match(r.stderr ?? "", /setup\/activate/);
});

test("(tui-2) tui appears in the root help", () => {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "help"],
    { encoding: "utf8" },
  );
  assert.match(r.stdout ?? "", /tui \[dir\]/);
});
