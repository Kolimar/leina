// `leina deactivate` end-to-end.
//
// Tests: T1-1 (deactivate after setup: symlinks removed, Exec grant revoked, hooks removed,
//              .blanket unchanged), T1-2 (idempotent second deactivate).
//
// Sandbox pattern: LEINA_HOME + HOME + USERPROFILE all redirected to a temp dir.
//
// Run: node --no-warnings --experimental-strip-types --test test/deactivate-cli.test.ts

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
  const home = mkdtempSync(join(tmpdir(), "leina-deactivate-cli-"));
  const pdHome = join(home, ".leina");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEINA_HOME: pdHome,
    HOME: home,
    USERPROFILE: home,
    LEINA_DISABLE_AUTOBUILD: "1",
  };
  delete env.APPDATA;
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
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", env },
  );
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// T1-1: deactivate after setup — symlinks removed, Exec grant revoked, hooks removed,
//        .blanket unchanged (deactivate MUST NOT modify blanketFile).
// ---------------------------------------------------------------------------

test("(T1-1) deactivate tras setup: symlinks removidos, Exec grant revocado, hooks removidos, .blanket sin cambio", () => {
  const { env, home, pdHome, cleanup } = makeSandbox();
  try {
    // First run setup to create the full machine-wide state (blanket + share + symlinks + config).
    const r0 = runCli(env, "setup");
    assert.equal(r0.status, 0, `setup exit 0 (stderr: ${r0.stderr})`);

    const blanketPath = join(pdHome, ".blanket");
    assert.ok(existsSync(blanketPath), ".blanket exists after setup (pre-condition T1-1)");

    const skillsRoot = join(home, ".config", "devin", "skills");
    const skillsBefore = readdirSync(skillsRoot);
    assert.ok(skillsBefore.length > 0, "skill symlinks present after setup (pre-condition T1-1)");

    const userCfg = join(home, ".config", "devin", "config.json");
    const cfgBefore = JSON.parse(readFileSync(userCfg, "utf8")) as Record<string, unknown>;
    const allowBefore = (cfgBefore.permissions as { allow?: string[] } | undefined)?.allow ?? [];
    assert.ok(allowBefore.includes("Exec(leina)"), "Exec grant present before deactivate (T1-1)");

    // Run deactivate
    const r1 = runCli(env, "deactivate");
    assert.equal(r1.status, 0, `deactivate exit 0 (T1-1) (stderr: ${r1.stderr})`);

    // .blanket MUST NOT be touched by deactivate (T1-1: deactivate MUST NOT modify blanketFile)
    assert.ok(
      existsSync(blanketPath),
      ".blanket still exists after deactivate — deactivate must NOT modify blanketFile (T1-1)",
    );

    // Managed skill symlinks removed (T1-1)
    const skillsAfter = readdirSync(skillsRoot);
    assert.equal(
      skillsAfter.length,
      0,
      "all managed skill symlinks removed by deactivate (T1-1)",
    );

    // Exec grant removed from user-global config (T1-1)
    const cfgAfter = JSON.parse(readFileSync(userCfg, "utf8")) as Record<string, unknown>;
    const allowAfter = (cfgAfter.permissions as { allow?: string[] } | undefined)?.allow ?? [];
    assert.ok(
      !allowAfter.includes("Exec(leina)"),
      "Exec grant removed from user-global config by deactivate (T1-1)",
    );

    // Managed SessionStart hooks removed (T1-1)
    const hooks = cfgAfter.hooks as Record<string, unknown[]> | undefined;
    const hasSessionStart =
      hooks?.SessionStart &&
      Array.isArray(hooks.SessionStart) &&
      hooks.SessionStart.length > 0;
    assert.ok(!hasSessionStart, "SessionStart hooks removed from user-global config (T1-1)");

    // stdout mentions deactivate
    assert.match(r1.stdout, /deactivate/, "stdout mentions 'deactivate' (T1-1)");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// T1-2: deactivate idempotente — second run exit 0, no errors, .blanket not created.
// ---------------------------------------------------------------------------

test("(T1-2) deactivate idempotente: segundo deactivate exit 0 sin errores, sin .blanket creado", () => {
  const { env, pdHome, cleanup } = makeSandbox();
  try {
    // Activate first (creates share + symlinks + user-global config; no blanket created).
    const r0 = runCli(env, "activate");
    assert.equal(r0.status, 0, `activate exit 0 (stderr: ${r0.stderr})`);

    // First deactivate
    const r1 = runCli(env, "deactivate");
    assert.equal(r1.status, 0, `first deactivate exit 0 (stderr: ${r1.stderr})`);

    // Second deactivate — must be idempotent (exit 0, no ENOENT / crash)
    const r2 = runCli(env, "deactivate");
    assert.equal(r2.status, 0, `second deactivate exit 0 (T1-2) (stderr: ${r2.stderr})`);

    // No unexpected stderr output (no ENOENT / crash traces)
    const unexpectedStderr = r2.stderr
      .split("\n")
      .filter((l) => /ENOENT|Error:|Uncaught/.test(l));
    assert.equal(
      unexpectedStderr.length,
      0,
      `no error output on idempotent deactivate (T1-2): ${unexpectedStderr.join("; ")}`,
    );

    // .blanket must NOT be created by deactivate (deactivate never touches blanketFile)
    assert.ok(
      !existsSync(join(pdHome, ".blanket")),
      ".blanket not created by deactivate (T1-2)",
    );
  } finally {
    cleanup();
  }
});
