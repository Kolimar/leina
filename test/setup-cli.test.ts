// `leina setup` end-to-end + E1 validation workflow (blanket).
//
// Tests: B2-1 (fresh setup), B2-2 (idempotent re-run), and the full E1 scenario:
//   setup → init LIGHT → disable → second disable (idempotent).
//
// Sandbox pattern: LEINA_HOME + HOME + USERPROFILE all redirected to a temp dir
// so every child process stays fully isolated from the real user home.
//
// Run: node --no-warnings --experimental-strip-types --test test/setup-cli.test.ts

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

/**
 * Build a fully sandboxed environment: LEINA_HOME + HOME + USERPROFILE all
 * redirected to a fresh temp directory so no test can touch the real user home.
 */
function makeSandbox(): {
  env: NodeJS.ProcessEnv;
  home: string;
  pdHome: string;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "leina-setup-cli-"));
  const pdHome = join(home, ".leina");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEINA_HOME: pdHome,
    HOME: home,
    USERPROFILE: home,
  };
  // Remove APPDATA so devinSkillsRoot / devinAgentsRoot use HOME on Windows too.
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

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "leina-setup-proj-"));
}

// ---------------------------------------------------------------------------
// B2-1: fresh setup
// ---------------------------------------------------------------------------

test("(B2-1) fresh setup: .blanket exists, share populated, symlinks created, user-global grant+hooks", () => {
  const { env, home, pdHome, cleanup } = makeSandbox();
  try {
    const r = runCli(env, "setup");
    assert.equal(r.status, 0, `exit 0 (stderr: ${r.stderr})`);

    // B2-1: blanket sentinel written
    assert.ok(
      existsSync(join(pdHome, ".blanket")),
      "$LEINA_HOME/.blanket exists after setup (B2-1)",
    );

    // Share populated (activate side-effect)
    assert.ok(existsSync(join(pdHome, "share", ".version")), "share/.version written");
    assert.ok(existsSync(join(pdHome, "share", "skills")), "share/skills/ present");

    // Devin symlinks created
    const skillsRoot = join(home, ".config", "devin", "skills");
    assert.ok(existsSync(skillsRoot), "~/.config/devin/skills/ created");
    const skills = readdirSync(skillsRoot);
    assert.ok(skills.length > 0, "at least one skill symlinked into Devin (B2-1)");

    // User-global config: Exec grant present
    const userCfg = join(home, ".config", "devin", "config.json");
    assert.ok(existsSync(userCfg), "user-global config.json written");
    const cfg = JSON.parse(readFileSync(userCfg, "utf8")) as Record<string, unknown>;
    const allow = (cfg.permissions as { allow?: string[] } | undefined)?.allow ?? [];
    assert.ok(
      allow.includes("Exec(leina)"),
      "Exec(leina) grant in user-global config (B2-1)",
    );

    // User-global hooks present (setup defaults to userHooks=true via activate)
    const hooks = cfg.hooks as Record<string, unknown> | undefined;
    assert.ok(hooks && typeof hooks === "object", "user-global hooks key present (B2-1)");
    assert.ok(
      Array.isArray((hooks).SessionStart),
      "SessionStart hooks present in user-global (B2-1)",
    );

    // stdout contains a clear report
    assert.match(r.stdout, /setup/, "stdout mentions setup");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// B2-2: idempotent re-run
// ---------------------------------------------------------------------------

test("(B2-2) setup idempotente: re-run exit 0, sin duplicados en config, .blanket sigue existiendo", () => {
  const { env, home, pdHome, cleanup } = makeSandbox();
  try {
    const r1 = runCli(env, "setup");
    assert.equal(r1.status, 0, `first setup exit 0 (stderr: ${r1.stderr})`);

    const userCfg = join(home, ".config", "devin", "config.json");
    const cfgBefore = JSON.parse(readFileSync(userCfg, "utf8")) as Record<string, unknown>;

    const r2 = runCli(env, "setup");
    assert.equal(r2.status, 0, `second setup exit 0 (B2-2) (stderr: ${r2.stderr})`);

    // .blanket still exists
    assert.ok(existsSync(join(pdHome, ".blanket")), ".blanket still present after second setup (B2-2)");

    // Grant not duplicated
    const cfgAfter = JSON.parse(readFileSync(userCfg, "utf8")) as Record<string, unknown>;
    const allow = (cfgAfter.permissions as { allow?: string[] } | undefined)?.allow ?? [];
    const grantCount = allow.filter((g: string) => g === "Exec(leina)").length;
    assert.equal(grantCount, 1, "Exec grant appears exactly once after re-run (B2-2)");

    // Config stable: no spurious changes besides idempotent writes
    // (backup timestamps may differ but the content-relevant keys should be the same)
    const beforeAllow = (cfgBefore.permissions as { allow?: string[] } | undefined)?.allow ?? [];
    assert.equal(
      JSON.stringify(beforeAllow.sort()),
      JSON.stringify(allow.sort()),
      "permissions.allow unchanged on re-run (B2-2)",
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// E1 validation workflow: setup → init LIGHT → disable → idempotent second disable
// ---------------------------------------------------------------------------

test("(E1) blanket workflow completo: setup → init LIGHT (B2/I1-1) → disable (B3-1) → segundo disable (B3-2)", () => {
  const { env, home, pdHome, cleanup } = makeSandbox();
  const project = tmpProject();
  try {
    // ── Step 1: setup ────────────────────────────────────────────────────────
    const r1 = runCli(env, "setup");
    assert.equal(r1.status, 0, `setup exit 0 (stderr: ${r1.stderr})`);
    assert.ok(existsSync(join(pdHome, ".blanket")), ".blanket exists after setup (E1/B2-1)");

    const userCfg = join(home, ".config", "devin", "config.json");
    const cfgAfterSetup = JSON.parse(readFileSync(userCfg, "utf8")) as Record<string, unknown>;
    const allowAfterSetup = (cfgAfterSetup.permissions as { allow?: string[] } | undefined)?.allow ?? [];
    assert.ok(
      allowAfterSetup.includes("Exec(leina)"),
      "grant present after setup (E1)",
    );
    const hooksAfterSetup = cfgAfterSetup.hooks as Record<string, unknown[]> | undefined;
    assert.ok(
      hooksAfterSetup?.SessionStart && Array.isArray(hooksAfterSetup.SessionStart),
      "SessionStart hooks present after setup (E1)",
    );

    // Symlinks created
    const skillsRoot = join(home, ".config", "devin", "skills");
    const skillsBefore = readdirSync(skillsRoot);
    assert.ok(skillsBefore.length > 0, "skill symlinks present after setup (E1)");

    // ── Step 2: init in project (blanket active → LIGHT mode) ────────────────
    const r2 = runCli(env, "init", "--project", project);
    assert.equal(r2.status, 0, `init exit 0 (stderr: ${r2.stderr})`);
    assert.match(r2.stdout, /LIGHT/, "init reports LIGHT mode (E1/I1-1)");

    // Consent flag written (I1-1)
    const consentPath = join(project, ".leina", "consent");
    assert.ok(existsSync(consentPath), "consent flag written in LIGHT init (E1/I1-1)");
    assert.equal(
      readFileSync(consentPath, "utf8").trim(),
      "enabled",
      "consent = 'enabled' (E1/I1-1)",
    );

    // .gitignore written (I1-1)
    assert.ok(existsSync(join(project, ".gitignore")), ".gitignore written in LIGHT init (E1/I1-1)");

    // AGENTS.md NOT written (I1-1: LIGHT no escribe AGENTS.md)
    assert.ok(
      !existsSync(join(project, "AGENTS.md")),
      "AGENTS.md NOT written in LIGHT init (E1/I1-1)",
    );

    // .devin/ NOT created (I1-1: LIGHT no escribe hooks ni config local)
    assert.ok(
      !existsSync(join(project, ".devin")),
      ".devin/ NOT created in LIGHT init (E1/I1-1)",
    );

    // User-global NOT modified by init (I3)
    const cfgAfterInit = JSON.parse(readFileSync(userCfg, "utf8")) as Record<string, unknown>;
    assert.equal(
      JSON.stringify(cfgAfterSetup),
      JSON.stringify(cfgAfterInit),
      "user-global config unchanged after LIGHT init (E1/I3)",
    );

    // ── Step 3: disable ───────────────────────────────────────────────────────
    const r3 = runCli(env, "disable");
    assert.equal(r3.status, 0, `disable exit 0 (stderr: ${r3.stderr})`);

    // .blanket removed (B3-1)
    assert.ok(
      !existsSync(join(pdHome, ".blanket")),
      ".blanket removed after disable (E1/B3-1)",
    );

    // Managed skill symlinks removed (B3-1)
    const skillsAfterDisable = readdirSync(skillsRoot);
    assert.equal(
      skillsAfterDisable.length,
      0,
      "all managed skill symlinks removed by disable (E1/B3-1)",
    );

    // Exec grant removed from user-global (B3-1)
    const cfgAfterDisable = JSON.parse(readFileSync(userCfg, "utf8")) as Record<string, unknown>;
    const allowAfterDisable =
      (cfgAfterDisable.permissions as { allow?: string[] } | undefined)?.allow ?? [];
    assert.ok(
      !allowAfterDisable.includes("Exec(leina)"),
      "Exec grant removed from user-global config (E1/B3-1)",
    );

    // Managed SessionStart hooks removed (B3-1)
    const hooksAfterDisable = cfgAfterDisable.hooks as
      | Record<string, unknown[]>
      | undefined;
    const hasSessionStartEntries =
      hooksAfterDisable?.SessionStart &&
      Array.isArray(hooksAfterDisable.SessionStart) &&
      hooksAfterDisable.SessionStart.length > 0;
    assert.ok(
      !hasSessionStartEntries,
      "SessionStart hooks removed from user-global config (E1/B3-1)",
    );

    // ── Step 4: second disable — idempotent (B3-2) ───────────────────────────
    const r4 = runCli(env, "disable");
    assert.equal(r4.status, 0, `second disable exit 0 (E1/B3-2) (stderr: ${r4.stderr})`);

    // Blanket still absent after second disable
    assert.ok(
      !existsSync(join(pdHome, ".blanket")),
      ".blanket still absent after idempotent second disable (E1/B3-2)",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    cleanup();
  }
});
