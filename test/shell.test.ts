// Unit tests for src/install/shell.ts — Git Bash / MSYS detection on Windows.
// detectGitBashOnWindows is parameterized on (env, platform) so we test it without mutating globals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectGitBashOnWindows, gitBashAdvisory, mergeShellWrapper } from "../src/infrastructure/install/shell.ts";

test("(sh-a) non-Windows is never flagged, even with MSYSTEM set", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const det = detectGitBashOnWindows({ MSYSTEM: "MINGW64", SHELL: "/usr/bin/bash" }, platform);
    assert.equal(det.isGitBashOnWindows, false);
  }
});

test("(sh-b) win32 + MSYSTEM=MINGW64 → detected with msystem echoed back", () => {
  const det = detectGitBashOnWindows({ MSYSTEM: "MINGW64" }, "win32");
  assert.equal(det.isGitBashOnWindows, true);
  assert.equal(det.msystem, "MINGW64");
});

test("(sh-c) win32 + POSIX bash SHELL (no MSYSTEM) → detected", () => {
  const det = detectGitBashOnWindows({ SHELL: "/usr/bin/bash" }, "win32");
  assert.equal(det.isGitBashOnWindows, true);
  assert.equal(det.msystem, undefined);
});

test("(sh-d) win32 plain cmd/powershell (no MSYS signals) → not detected", () => {
  const det = detectGitBashOnWindows({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32");
  assert.equal(det.isGitBashOnWindows, false);
});

test("(sh-e) blank/whitespace MSYSTEM is ignored", () => {
  const det = detectGitBashOnWindows({ MSYSTEM: "   " }, "win32");
  assert.equal(det.isGitBashOnWindows, false);
});

test("(sh-f) advisory includes the exact CLI path when provided", () => {
  const msg = gitBashAdvisory("C:/Users/x/AppData/Roaming/npm/node_modules/leina/dist/cli/index.js");
  assert.match(msg, /cmd\.exe or PowerShell/);
  assert.match(msg, /node "C:\/Users\/x.*index\.js"/);
});

test("(sh-g) advisory falls back to a placeholder path when none provided", () => {
  const msg = gitBashAdvisory();
  assert.match(msg, /<npm-prefix>/);
});

test("(wrap-1) mergeShellWrapper creates, replaces in place, and is idempotent", () => {
  const v1 = mergeShellWrapper(null, "C:\\x\\dist\\cli\\index.js");
  assert.ok(v1 !== null);
  assert.match(v1, /leina\(\) \{ node "C:\\x\\dist\\cli\\index\.js" "\$@"; \}/);
  assert.match(v1, /leina:shell-wrapper:start/);

  // Idempotent: same entry again → null (no rewrite).
  assert.equal(mergeShellWrapper(v1, "C:\\x\\dist\\cli\\index.js"), null);

  // Entry moved → block replaced in place, user content preserved.
  const withUser = `alias ll='ls -la'\n${  v1}`;
  const v2 = mergeShellWrapper(withUser, "D:\\y\\index.js");
  assert.ok(v2 !== null);
  assert.match(v2, /alias ll/);
  assert.match(v2, /D:\\y\\index\.js/);
  assert.doesNotMatch(v2, /C:\\x/);
  assert.equal(v2.split("leina:shell-wrapper:start").length - 1, 1, "single block");
});

test("(wrap-2) repair --write-shell-wrapper on non-win32 skips with a note", () => {
  if (process.platform === "win32") return;
  const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "repair", "--write-shell-wrapper"],
    { encoding: "utf8" },
  );
  assert.match(r.stdout ?? "", /only relevant on Windows Git Bash — skipped/);
});
