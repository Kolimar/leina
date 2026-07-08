// `leina deinit` end-to-end — E2 validation workflow (standalone).
//
// Tests (spec IDs):
//   E2-1 / T3-1 — FULL init (no blanket) → assert repo self-contained + user-global intacto
//                 → deinit → managed blocks gone, user content preserved, user-global intacto.
//   T3-2        — LIGHT init (blanket active) → deinit → flag=disabled, gitignore limpio,
//                 MUST NOT error on ausencia de .devin/hooks.v1.json.
//   T3-3        — idempotency: second deinit after FULL init → exit 0 sin errores.
//   OQ-2        — second deinit after LIGHT init → "nothing to revert".
//
// Sandbox pattern: LEINA_HOME + HOME + USERPROFILE redirected to temp dirs.
// LEINA_DISABLE_AUTOBUILD=1 set on all tests (NF3).
//
// Run: node --no-warnings --experimental-strip-types --test test/deinit-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
  const home = mkdtempSync(join(tmpdir(), "leina-deinit-cli-"));
  const pdHome = join(home, ".leina");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEINA_HOME: pdHome,
    HOME: home,
    USERPROFILE: home,
    LEINA_DISABLE_AUTOBUILD: "1",
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

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "leina-deinit-proj-"));
}

// ---------------------------------------------------------------------------
// E2-1 / T3-1: FULL init (no blanket) → deinit strips all managed artifacts.
//              User content in AGENTS.md and .gitignore MUST be preserved.
//              ~/.config/devin/config.json MUST NOT be touched by init or deinit.
// ---------------------------------------------------------------------------

test("(E2-1/T3-1) FULL init sin blanket: deinit elimina artefactos gestionados, preserva contenido usuario, user-global intacto", () => {
  const { env, home, cleanup } = makeSandbox();
  const project = tmpProject();
  try {
    // Pre-populate user content that MUST survive the full init → deinit cycle.
    writeFileSync(join(project, "AGENTS.md"), "# My Project\n\nUser content here.\n");
    writeFileSync(join(project, ".gitignore"), "node_modules/\ndist/\n");

    const userCfg = join(home, ".config", "devin", "config.json");

    // ── Step 1: init FULL (no blanket) ──────────────────────────────────────
    const r1 = runCli(env, "init", "--project", project);
    assert.equal(r1.status, 0, `init exit 0 (stderr: ${r1.stderr})`);
    assert.match(r1.stdout, /FULL/, "init reports FULL mode (E2-1)");

    // Assert repo self-contained (E2-1 / I1-2)
    const consentPath = join(project, ".leina", "consent");
    assert.ok(existsSync(consentPath), "consent flag written by FULL init (E2-1)");
    assert.equal(
      readFileSync(consentPath, "utf8").trim(),
      "enabled",
      "consent=enabled after FULL init (E2-1)",
    );

    const agentsAfterInit = readFileSync(join(project, "AGENTS.md"), "utf8");
    assert.ok(
      agentsAfterInit.includes("User content here."),
      "user content preserved in AGENTS.md after init (E2-1)",
    );
    assert.ok(
      agentsAfterInit.includes("leina:protocol:start"),
      "protocol block written to AGENTS.md by FULL init (E2-1)",
    );

    const gitignoreAfterInit = readFileSync(join(project, ".gitignore"), "utf8");
    assert.ok(
      gitignoreAfterInit.includes("node_modules/"),
      "user gitignore content preserved after init (E2-1)",
    );
    assert.ok(
      gitignoreAfterInit.includes("leina:ignore:start"),
      "gitignore block written by FULL init (E2-1)",
    );

    assert.ok(
      existsSync(join(project, ".devin", "hooks.v1.json")),
      ".devin/hooks.v1.json written by FULL init (E2-1)",
    );

    const localCfg = JSON.parse(
      readFileSync(join(project, ".devin", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    const localAllow = (localCfg.permissions as { allow?: string[] } | undefined)?.allow ?? [];
    assert.ok(
      localAllow.includes("Exec(leina)"),
      "local Exec grant written to .devin/config.json by FULL init (E2-1)",
    );

    // user-global config MUST NOT be touched by FULL init (I3)
    assert.ok(
      !existsSync(userCfg),
      "~/.config/devin/config.json NOT created by FULL init (E2-1 / I3)",
    );

    // ── Step 2: deinit (strip-inverse) ──────────────────────────────────────
    const r2 = runCli(env, "deinit", "--project", project);
    assert.equal(r2.status, 0, `deinit exit 0 (T3-1) (stderr: ${r2.stderr})`);

    // T3-1: consent = disabled
    assert.equal(
      readFileSync(consentPath, "utf8").trim(),
      "disabled",
      "consent=disabled after deinit (T3-1)",
    );

    // T3-1: AGENTS.md user content preserved, protocol block removed
    const agentsAfterDeinit = readFileSync(join(project, "AGENTS.md"), "utf8");
    assert.ok(
      agentsAfterDeinit.includes("User content here."),
      "user content preserved in AGENTS.md after deinit (T3-1)",
    );
    assert.ok(
      !agentsAfterDeinit.includes("leina:protocol:start"),
      "protocol block removed from AGENTS.md by deinit (T3-1)",
    );

    // T3-1: .gitignore user content preserved, managed block removed
    const gitignoreAfterDeinit = readFileSync(join(project, ".gitignore"), "utf8");
    assert.ok(
      gitignoreAfterDeinit.includes("node_modules/"),
      "user gitignore content preserved after deinit (T3-1)",
    );
    assert.ok(
      !gitignoreAfterDeinit.includes("leina:ignore:start"),
      "gitignore block removed by deinit (T3-1)",
    );

    // T3-1: .devin/hooks.v1.json removed
    assert.ok(
      !existsSync(join(project, ".devin", "hooks.v1.json")),
      ".devin/hooks.v1.json removed by deinit (T3-1)",
    );

    // T3-1: user-global config NOT touched by deinit
    assert.ok(
      !existsSync(userCfg),
      "~/.config/devin/config.json NOT created by deinit (T3-1)",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// T3-3: deinit idempotente — second deinit after FULL init reports "nothing to revert".
// ---------------------------------------------------------------------------

test("(T3-3) deinit idempotente: segundo deinit exit 0 sin errores, imprime 'nothing to revert'", () => {
  const { env, cleanup } = makeSandbox();
  const project = tmpProject();
  try {
    // FULL init + first deinit
    const r1 = runCli(env, "init", "--project", project);
    assert.equal(r1.status, 0, `init exit 0 (stderr: ${r1.stderr})`);

    const r2 = runCli(env, "deinit", "--project", project);
    assert.equal(r2.status, 0, `first deinit exit 0 (stderr: ${r2.stderr})`);

    // Second deinit — must be idempotent
    const r3 = runCli(env, "deinit", "--project", project);
    assert.equal(r3.status, 0, `second deinit exit 0 (T3-3) (stderr: ${r3.stderr})`);

    // No unexpected stderr errors
    const unexpectedStderr = r3.stderr
      .split("\n")
      .filter((l) => /ENOENT|Error:|Uncaught/.test(l));
    assert.equal(
      unexpectedStderr.length,
      0,
      `no error output on idempotent deinit (T3-3): ${unexpectedStderr.join("; ")}`,
    );

    // "nothing to revert" in stdout (OQ-2 contract — idempotent run)
    assert.match(
      r3.stdout,
      /nothing to revert/i,
      "second deinit reports 'nothing to revert' (T3-3)",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// T3-2: deinit tras init LIGHT — flag=disabled, gitignore limpio,
//        MUST NOT error on ausencia de .devin/hooks.v1.json.
// ---------------------------------------------------------------------------

test("(T3-2) deinit tras init LIGHT: flag=disabled, gitignore limpio, sin error por hooks.v1.json ausente", () => {
  const { env, pdHome, cleanup } = makeSandbox();
  const project = tmpProject();
  try {
    // Activate blanket (setup) so init takes the LIGHT path.
    const r0 = runCli(env, "setup");
    assert.equal(r0.status, 0, `setup exit 0 (stderr: ${r0.stderr})`);
    assert.ok(existsSync(join(pdHome, ".blanket")), ".blanket exists after setup (T3-2)");

    // LIGHT init
    const r1 = runCli(env, "init", "--project", project);
    assert.equal(r1.status, 0, `init exit 0 (stderr: ${r1.stderr})`);
    assert.match(r1.stdout, /LIGHT/, "init reports LIGHT mode (T3-2)");

    // Verify LIGHT artifacts (consent + gitignore only, NO AGENTS.md / hooks)
    const consentPath = join(project, ".leina", "consent");
    assert.ok(existsSync(consentPath), "consent flag written by LIGHT init (T3-2)");
    assert.equal(
      readFileSync(consentPath, "utf8").trim(),
      "enabled",
      "consent=enabled after LIGHT init (T3-2)",
    );
    assert.ok(
      existsSync(join(project, ".gitignore")),
      ".gitignore written by LIGHT init (T3-2)",
    );
    assert.ok(
      !existsSync(join(project, ".devin", "hooks.v1.json")),
      ".devin/hooks.v1.json NOT written by LIGHT init (T3-2)",
    );

    // deinit
    const r2 = runCli(env, "deinit", "--project", project);
    assert.equal(r2.status, 0, `deinit exit 0 (T3-2) (stderr: ${r2.stderr})`);

    // T3-2: flag = disabled
    assert.equal(
      readFileSync(consentPath, "utf8").trim(),
      "disabled",
      "consent=disabled after deinit of LIGHT init (T3-2)",
    );

    // T3-2: .gitignore managed block removed. This .gitignore was created by init and held
    // only our block, so deinit removes the whole file (no 0-byte husk).
    assert.ok(
      !existsSync(join(project, ".gitignore")),
      "gitignore (ours-only) removed entirely by deinit (T3-2)",
    );

    // T3-2: .devin/hooks.v1.json absent before and after — MUST NOT produce errors
    assert.ok(
      !existsSync(join(project, ".devin", "hooks.v1.json")),
      ".devin/hooks.v1.json still absent after deinit (T3-2)",
    );

    // No unexpected stderr errors (MUST NOT error on absent hooks file)
    const unexpectedStderr = r2.stderr
      .split("\n")
      .filter((l) => /ENOENT|Error:|Uncaught/.test(l));
    assert.equal(
      unexpectedStderr.length,
      0,
      `no error output (T3-2): ${unexpectedStderr.join("; ")}`,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// OQ-2: deinit idempotente tras init LIGHT — segundo deinit imprime "nothing to revert".
// ---------------------------------------------------------------------------

test("(OQ-2) deinit idempotente tras init LIGHT: segundo deinit imprime 'nothing to revert'", () => {
  const { env, pdHome, cleanup } = makeSandbox();
  const project = tmpProject();
  try {
    // Activate blanket + LIGHT init
    const r0 = runCli(env, "setup");
    assert.equal(r0.status, 0, `setup exit 0 (stderr: ${r0.stderr})`);
    assert.ok(existsSync(join(pdHome, ".blanket")), ".blanket exists (OQ-2)");

    const r1 = runCli(env, "init", "--project", project);
    assert.equal(r1.status, 0, `init LIGHT exit 0 (stderr: ${r1.stderr})`);
    assert.match(r1.stdout, /LIGHT/, "init reports LIGHT mode (OQ-2)");

    // First deinit — cleans up consent + gitignore block
    const r2 = runCli(env, "deinit", "--project", project);
    assert.equal(r2.status, 0, `first deinit exit 0 (OQ-2) (stderr: ${r2.stderr})`);

    // Second deinit — nothing left to revert → "nothing to revert"
    const r3 = runCli(env, "deinit", "--project", project);
    assert.equal(r3.status, 0, `second deinit exit 0 (OQ-2) (stderr: ${r3.stderr})`);
    assert.match(
      r3.stdout,
      /nothing to revert/i,
      "second deinit after LIGHT init reports 'nothing to revert' (OQ-2)",
    );

    // No unexpected errors
    const unexpectedStderr = r3.stderr
      .split("\n")
      .filter((l) => /ENOENT|Error:|Uncaught/.test(l));
    assert.equal(
      unexpectedStderr.length,
      0,
      `no error output on idempotent deinit after LIGHT init (OQ-2): ${unexpectedStderr.join("; ")}`,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    cleanup();
  }
});

test("(T3-empty) deinit removes AGENTS.md/.gitignore entirely when they held ONLY leina blocks", () => {
  // A FULL init on a repo with no prior AGENTS.md/.gitignore creates files that contain
  // nothing but the managed blocks. deinit must remove the files, not leave 0-byte husks.
  const { env, cleanup } = makeSandbox();
  const project = tmpProject();
  try {
    let r = runCli(env, "init", "--project", project);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(join(project, "AGENTS.md")), "AGENTS.md created by init");
    assert.ok(existsSync(join(project, ".gitignore")), ".gitignore created by init");

    r = runCli(env, "deinit", "--project", project);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(join(project, "AGENTS.md")), "AGENTS.md removed (was only our block)");
    assert.ok(!existsSync(join(project, ".gitignore")), ".gitignore removed (was only our block)");
    assert.match(r.stdout, /AGENTS\.md \(file removed/);
    assert.match(r.stdout, /\.gitignore \(file removed/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    cleanup();
  }
});
