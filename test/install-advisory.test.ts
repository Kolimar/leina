// install-advisory.test.ts — the runtime shell-interop advisory that replaced the npm
// postinstall hook, plus the no-postinstall packaging invariant.
//
// INVARIANT (I-PM1): nothing critical may live in npm lifecycle scripts — pnpm >= 10 and
// bun skip dependency scripts by default, and --ignore-scripts is common in CI. The Git
// Bash advisory therefore ships as a pure decision (shellInteropAdvisory) emitted by the
// lifecycle commands (setup/activate/init), which run under every package manager.
//
// Run: node --no-warnings --experimental-strip-types --test test/install-advisory.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shellInteropAdvisory } from "../src/infrastructure/install/shell.ts";

// ---------------------------------------------------------------------------
// (adv-a) Packaging invariant: no lifecycle scripts, no shipped postinstall file
// ---------------------------------------------------------------------------

test("(adv-a1) package.json declares NO npm lifecycle install scripts", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  for (const hook of ["preinstall", "install", "postinstall"]) {
    assert.equal(pkg.scripts?.[hook], undefined, `scripts.${hook} must not exist`);
  }
});

test("(adv-a2) scripts/postinstall.mjs is gone and not shipped", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  assert.ok(
    !(pkg.files as string[]).some((f) => f.includes("postinstall")),
    "files[] must not ship a postinstall script",
  );
  assert.equal(
    existsSync(fileURLToPath(new URL("../scripts/postinstall.mjs", import.meta.url))),
    false,
    "scripts/postinstall.mjs must not exist",
  );
});

// ---------------------------------------------------------------------------
// (adv-b) Pure advisory decision — testable from any host via injected env/platform
// ---------------------------------------------------------------------------

test("(adv-b1) win32 + MSYSTEM → full advisory text", () => {
  const msg = shellInteropAdvisory({ MSYSTEM: "MINGW64" }, "win32", "C:\\x\\dist\\cli\\index.js");
  assert.ok(msg !== null);
  assert.match(msg, /Git Bash \/ MSYS detected/);
  assert.match(msg, /MODULE_NOT_FOUND/);
  assert.match(msg, /node "C:\\x\\dist\\cli\\index\.js" --help/);
});

test("(adv-b2) win32 + POSIX bash SHELL → advisory", () => {
  const msg = shellInteropAdvisory({ SHELL: "/usr/bin/bash" }, "win32");
  assert.ok(msg !== null);
});

test("(adv-b3) win32 without Git Bash signals → null", () => {
  assert.equal(shellInteropAdvisory({}, "win32"), null);
});

test("(adv-b4) non-win32 platforms → null even with Git-Bash-like env", () => {
  for (const platform of ["linux", "darwin"] as const) {
    assert.equal(
      shellInteropAdvisory({ MSYSTEM: "MINGW64", SHELL: "/usr/bin/bash" }, platform),
      null,
      platform,
    );
  }
});
