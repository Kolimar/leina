// `leina disable` end-to-end.
//
// Tests: B3-1 (full disable after setup) and B3-2 (idempotent second disable).
//
// Sandbox pattern: LEINA_HOME + HOME + USERPROFILE all redirected to a temp dir
// so no test can touch the real user home.
//
// Run: node --no-warnings --experimental-strip-types --test test/disable-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSandbox(): {
  env: NodeJS.ProcessEnv;
  home: string;
  pdHome: string;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "leina-disable-cli-"));
  const pdHome = join(home, ".leina");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEINA_HOME: pdHome,
    HOME: home,
    USERPROFILE: home,
  };
  // Point APPDATA into the sandbox so devinConfigRoot() resolves to <home>/.config/devin
  // on Windows too — the exact path these tests assert on every platform.
  env.APPDATA = join(home, ".config");
  return {
    env,
    home,
    pdHome,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function runCli(
  env: NodeJS.ProcessEnv,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  const needsHost =
    ["setup", "activate", "init", "install-global"].includes(args[0] ?? "") &&
    !args.includes("--hosts");
  const finalArgs = needsHost ? [...args, "--hosts", "devin"] : args;
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...finalArgs],
    { encoding: "utf8", env },
  );
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// B3-1: full disable after setup
// ---------------------------------------------------------------------------

test("(B3-1) disable after setup: .blanket removido, symlinks eliminados, grant+hooks removidos de user-global, exit 0", () => {
  const { env, home, pdHome, cleanup } = makeSandbox();
  try {
    // First: run setup to create the machine-wide state.
    const r1 = runCli(env, "setup");
    assert.equal(r1.status, 0, `setup exit 0 (stderr: ${r1.stderr})`);

    // Verify pre-conditions
    assert.ok(existsSync(join(pdHome, ".blanket")), ".blanket exists before disable");

    const userCfg = join(home, ".config", "devin", "config.json");
    const cfgBefore = JSON.parse(readFileSync(userCfg, "utf8")) as Record<string, unknown>;
    const allowBefore = (cfgBefore.permissions as { allow?: string[] } | undefined)?.allow ?? [];
    assert.ok(allowBefore.includes("Exec(leina)"), "grant present before disable");

    const skillsRoot = join(home, ".config", "devin", "skills");
    const skillsBefore = readdirSync(skillsRoot);
    assert.ok(skillsBefore.length > 0, "skill symlinks exist before disable");

    // Run disable
    const r2 = runCli(env, "disable");
    assert.equal(r2.status, 0, `disable exit 0 (B3-1) (stderr: ${r2.stderr})`);

    // .blanket removed (B3-1)
    assert.ok(
      !existsSync(join(pdHome, ".blanket")),
      ".blanket removed after disable (B3-1)",
    );

    // Managed skill symlinks removed (B3-1)
    const skillsAfter = readdirSync(skillsRoot);
    assert.equal(
      skillsAfter.length,
      0,
      "all managed skill symlinks removed by disable (B3-1)",
    );

    // Exec grant removed from user-global (B3-1)
    const cfgAfter = JSON.parse(readFileSync(userCfg, "utf8")) as Record<string, unknown>;
    const allowAfter = (cfgAfter.permissions as { allow?: string[] } | undefined)?.allow ?? [];
    assert.ok(
      !allowAfter.includes("Exec(leina)"),
      "Exec grant removed from user-global config (B3-1)",
    );

    // Managed SessionStart hooks removed (B3-1)
    const hooks = cfgAfter.hooks as Record<string, unknown[]> | undefined;
    const hasSessionStart =
      hooks?.SessionStart &&
      Array.isArray(hooks.SessionStart) &&
      hooks.SessionStart.length > 0;
    assert.ok(!hasSessionStart, "SessionStart hooks removed from user-global config (B3-1)");

    // stdout mentions disable
    assert.match(r2.stdout, /disable/, "stdout contains 'disable' report");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// B3-2: idempotent second disable
// ---------------------------------------------------------------------------

test("(B3-2) disable idempotente: segundo disable exit 0, sin error de archivo no encontrado", () => {
  const { env, pdHome, cleanup } = makeSandbox();
  try {
    // setup first, then disable, then disable again
    const r0 = runCli(env, "setup");
    assert.equal(r0.status, 0, `setup exit 0 (stderr: ${r0.stderr})`);

    const r1 = runCli(env, "disable");
    assert.equal(r1.status, 0, `first disable exit 0 (stderr: ${r1.stderr})`);

    // Second disable — must be idempotent (exit 0, no ENOENT / exception)
    const r2 = runCli(env, "disable");
    assert.equal(r2.status, 0, `second disable exit 0 (B3-2) (stderr: ${r2.stderr})`);

    // .blanket still absent
    assert.ok(
      !existsSync(join(pdHome, ".blanket")),
      ".blanket still absent after idempotent second disable (B3-2)",
    );

    // No unexpected stderr output (no ENOENT / crash traces)
    const unexpectedStderr = r2.stderr
      .split("\n")
      .filter((l) => /ENOENT|Error:|Uncaught/.test(l));
    assert.equal(
      unexpectedStderr.length,
      0,
      `no error output on idempotent disable (B3-2): ${unexpectedStderr.join("; ")}`,
    );
  } finally {
    cleanup();
  }
});
