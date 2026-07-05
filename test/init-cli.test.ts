// `leina init` end-to-end — spawns the real CLI against a temp project and asserts it
// writes the committable host config and is idempotent (the pure writers are unit-tested in
// install.test.ts; this covers the I/O wiring + argument handling).
// Run: node --no-warnings --experimental-strip-types --test test/init-cli.test.ts
//
// Devin is the only supported host now (the Windsurf editor migrated to the same on-disk
// shape, so the package consolidated on `.devin/`). All `--agent windsurf|all`, `--claude`,
// `--port`, `--no-write-mcp-config` tests were removed alongside those CLI surfaces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

// Isolate ALL home-dir writes: every child process spawned by these tests must redirect both
// the leina registry (LEINA_HOME) AND any host-config writes (HOME/USERPROFILE) to a
// throwaway dir under tmpdir. Defense in depth: if a future test path writes user-globally we
// stay sandboxed.
const TEMP_HOME = mkdtempSync(join(tmpdir(), "leina-init-cli-home-"));
const TEST_ENV = {
  ...process.env,
  LEINA_HOME: TEMP_HOME,
  HOME: TEMP_HOME,
  USERPROFILE: TEMP_HOME,
  // PR2: `init` never auto-builds (removed). LEINA_DISABLE_AUTOBUILD kept for back-compat
  // with other test utilities that may still reference this env variable.
  LEINA_DISABLE_AUTOBUILD: "1",
};

function runInit(project: string, ...args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", project, ...args],
    { encoding: "utf8", env: TEST_ENV },
  );
}

function tmpProject(): string {
  const dir = join(tmpdir(), `cg-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("(i-a) init writes AGENTS.md (CLI-only — no MCP server block)", () => {
  const dir = tmpProject();
  try {
    runInit(dir, "--agent", "devin");

    assert.ok(existsSync(join(dir, "AGENTS.md")), "AGENTS.md written");
    // CLI-only build: init never writes a leina MCP server into .devin/config.json.
    const cfgPath = join(dir, ".devin", "config.json");
    if (existsSync(cfgPath)) {
      const devin = JSON.parse(readFileSync(cfgPath, "utf8"));
      assert.ok(
        !devin.mcpServers || !("leina" in devin.mcpServers),
        "no leina MCP server entry is written (CLI-only)",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-a2) init FULL agrega CLI grant en .devin/config.json preservando contenido pre-existente", () => {
  // PR2: init ya no hace el MCP-server strip del config local — solo añade el Exec grant.
  const dir = tmpProject();
  try {
    mkdirSync(join(dir, ".devin"), { recursive: true });
    writeFileSync(
      join(dir, ".devin", "config.json"),
      JSON.stringify({
        mcpServers: { other: { command: "x", args: [] } },
        extra: true,
      }),
    );

    runInit(dir, "--agent", "devin");

    const devin = JSON.parse(readFileSync(join(dir, ".devin", "config.json"), "utf8"));
    // CLI grant added
    assert.ok(
      Array.isArray(devin.permissions?.allow) && devin.permissions.allow.includes("Exec(leina)"),
      "Exec(leina) grant added to pre-existing .devin/config.json",
    );
    // Pre-existing content preserved
    assert.ok(devin.mcpServers?.other, "unrelated MCP server entry preserved");
    assert.equal(devin.extra, true, "unrelated top-level keys preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-perm) init pre-authorizes Exec(leina) in .devin/config.json, idempotently", () => {
  const dir = tmpProject();
  try {
    runInit(dir, "--agent", "devin");
    const cfgPath = join(dir, ".devin", "config.json");
    assert.ok(existsSync(cfgPath), ".devin/config.json written with the CLI grant");
    const once = readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(once);
    assert.ok(
      Array.isArray(cfg.permissions?.allow) && cfg.permissions.allow.includes("Exec(leina)"),
      "permissions.allow contains Exec(leina)",
    );

    runInit(dir, "--agent", "devin");
    const twice = readFileSync(cfgPath, "utf8");
    assert.equal(once, twice, ".devin/config.json stable across re-runs (idempotent grant)");
    assert.equal(
      JSON.parse(twice).permissions.allow.filter((g: string) => g === "Exec(leina)").length,
      1,
      "grant is not duplicated on re-run",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-perm2) init adds the CLI grant while preserving pre-existing .devin/config.json content", () => {
  const dir = tmpProject();
  try {
    mkdirSync(join(dir, ".devin"), { recursive: true });
    writeFileSync(
      join(dir, ".devin", "config.json"),
      JSON.stringify({ permissions: { allow: ["Exec(git)"] }, extra: true }),
    );

    runInit(dir, "--agent", "devin");

    const cfg = JSON.parse(readFileSync(join(dir, ".devin", "config.json"), "utf8"));
    assert.deepEqual(
      cfg.permissions.allow,
      ["Exec(git)", "Exec(leina)"],
      "existing grants preserved, CLI grant appended",
    );
    assert.equal(cfg.extra, true, "unrelated keys preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-b) init is idempotent and preserves pre-existing AGENTS.md content", () => {
  const dir = tmpProject();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# My Project\n\nKeep this line.\n");

    runInit(dir, "--agent", "devin");
    const firstAgents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const firstHooks = readFileSync(join(dir, ".devin", "hooks.v1.json"), "utf8");

    runInit(dir, "--agent", "devin");
    const secondAgents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const secondHooks = readFileSync(join(dir, ".devin", "hooks.v1.json"), "utf8");

    assert.equal(firstAgents, secondAgents, "AGENTS.md stable across re-runs");
    assert.equal(firstHooks, secondHooks, ".devin/hooks.v1.json stable across re-runs");
    assert.ok(secondAgents.includes("Keep this line."), "user content preserved");
    assert.equal(
      secondAgents.split("leina:protocol:start").length - 1,
      1,
      "exactly one managed section",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-gi) init writes a .gitignore that excludes the .leina/ runtime dir, idempotently", () => {
  const dir = tmpProject();
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

    runInit(dir, "--agent", "devin");
    const once = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.ok(once.split("\n").includes(".leina/*"), ".leina/* ignored on its own line");
    assert.ok(once.split("\n").includes("!.leina/config.json"), "config.json re-included");
    assert.ok(once.includes("node_modules/"), "pre-existing rule preserved");

    runInit(dir, "--agent", "devin");
    const twice = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.equal(once, twice, ".gitignore stable across re-runs");
    assert.equal(
      twice.split("leina:ignore:start").length - 1,
      1,
      "exactly one managed block",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-c) init fails cleanly on a malformed AGENTS.md managed section", () => {
  const dir = tmpProject();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# P\n\n<!-- leina:protocol:start -->\nhalf\n");
    assert.throws(() => runInit(dir, "--agent", "devin"), "must refuse, not append forever");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-d) init --project with no value fails instead of installing into cwd", () => {
  const dir = tmpProject();
  try {
    // --project immediately followed by another flag must FAIL, not swallow "--agent" as the dir.
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", "--agent", "devin"],
        { encoding: "utf8", cwd: dir, env: TEST_ENV },
      ),
    );
    assert.ok(!existsSync(join(dir, "--agent")), "must not create a directory named --agent");
    assert.ok(!existsSync(join(dir, "AGENTS.md")), "must not install into cwd on a bad flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-e) init rejects unknown --agent values (typos shouldn't silently install nothing)", () => {
  const dir = tmpProject();
  try {
    // --agent windsurf: removed; fails with a migration message that names --profile windsurf
    assert.throws(() => runInit(dir, "--agent", "windsurf"), /--profile windsurf/);
    // Other unsupported --agent values: generic unknown-agent message
    assert.throws(() => runInit(dir, "--agent", "all"), /unknown --agent/);
    assert.throws(() => runInit(dir, "--agent", "claude"), /unknown --agent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(reg-a) CLI-only: init does NOT create a project registry and leaves the real ~/.leina untouched", () => {
  const realRegistry = join(homedir(), ".leina", "projects.json");
  const before = existsSync(realRegistry) ? readFileSync(realRegistry, "utf8") : null;

  const dir = tmpProject();
  try {
    runInit(dir, "--agent", "devin");
    // The legacy global project registry is gone — the CLI is per-<dir>. init must not write one.
    const overrideRegistry = join(TEMP_HOME, "projects.json");
    assert.equal(existsSync(overrideRegistry), false, "no projects.json registry is written (CLI-only)");

    const after = existsSync(realRegistry) ? readFileSync(realRegistry, "utf8") : null;
    assert.equal(after, before, "real ~/.leina/projects.json is byte-identical before/after init");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Devin hooks surface — .devin/hooks.v1.json + user-global ~/.config/devin/config.json
// ---------------------------------------------------------------------------

test("(devin-init-1) init --agent devin writes .devin/hooks.v1.json with all 4 managed event keys", () => {
  const dir = tmpProject();
  try {
    runInit(dir, "--agent", "devin");
    const path = join(dir, ".devin", "hooks.v1.json");
    assert.ok(existsSync(path), ".devin/hooks.v1.json written");
    const hooks = JSON.parse(readFileSync(path, "utf8"));
    for (const ev of ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart"]) {
      assert.ok(Array.isArray(hooks[ev]), `${ev} present`);
    }
    // PreToolUse routes through `devin-hook` subcommand:
    assert.match(hooks.PreToolUse[0].hooks[0].command, /devin-hook PreToolUse/);
    // PostToolUse: freshness refresh + exec marker + native-nudge (Palanca C, ADR-1):
    const matchers = hooks.PostToolUse.map((m: { matcher: string }) => m.matcher).sort();
    assert.deepEqual(matchers, [
      "^(edit|write)$",
      "^exec$",
      "^(read|grep|glob)$",
    ].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(devin-init-3) .devin/hooks.v1.json is byte-identical across re-runs (idempotent)", () => {
  const dir = tmpProject();
  try {
    runInit(dir, "--agent", "devin");
    const once = readFileSync(join(dir, ".devin", "hooks.v1.json"), "utf8");
    runInit(dir, "--agent", "devin");
    const twice = readFileSync(join(dir, ".devin", "hooks.v1.json"), "utf8");
    assert.equal(once, twice);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(I3-no-user-global) init FULL nunca escribe ~/.config/devin/config.json (I3)", () => {
  // PR2: init no muta user-global en ninguna rama (LIGHT ni FULL). El Exec grant solo se escribe
  // en el config local del repo (.devin/config.json). Para el grant user-global, usar `activate`.
  const dir = tmpProject();
  const isolatedHome = mkdtempSync(join(tmpdir(), "leina-init-no-user-global-"));
  try {
    execFileSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir, "--agent", "devin"],
      { encoding: "utf8", env: { ...process.env, LEINA_HOME: isolatedHome, HOME: isolatedHome, USERPROFILE: isolatedHome } },
    );
    const userGlobal = join(isolatedHome, ".config", "devin", "config.json");
    assert.ok(!existsSync(userGlobal), "user-global config.json NOT written by init (I3)");
    // Project Exec grant IS written (local .devin/config.json).
    assert.ok(existsSync(join(dir, ".devin", "config.json")), "local .devin/config.json written");
    const localCfg = JSON.parse(readFileSync(join(dir, ".devin", "config.json"), "utf8"));
    assert.ok(
      Array.isArray(localCfg.permissions?.allow) && localCfg.permissions.allow.includes("Exec(leina)"),
      "local Exec(leina) grant present in .devin/config.json",
    );
    // Project hooks ARE still written in FULL mode.
    assert.ok(existsSync(join(dir, ".devin", "hooks.v1.json")), "project hooks file written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});



// ---------------------------------------------------------------------------
// WU-08: --name flag
// ---------------------------------------------------------------------------

test("(i-name-a) init --name <project-name> writes .leina/config.json with project_name", () => {
  const dir = tmpProject();
  try {
    runInit(dir, "--agent", "devin", "--name", "my-service");
    const cfgPath = join(dir, ".leina", "config.json");
    assert.ok(existsSync(cfgPath), ".leina/config.json written");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.project_name, "my-service");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-name-b) init --name is idempotent (re-run with same name preserves file)", () => {
  const dir = tmpProject();
  try {
    runInit(dir, "--agent", "devin", "--name", "locked-service");
    const cfgPath = join(dir, ".leina", "config.json");
    const once = readFileSync(cfgPath, "utf8");

    runInit(dir, "--agent", "devin", "--name", "locked-service");
    const twice = readFileSync(cfgPath, "utf8");

    assert.equal(once, twice, "config.json stable across re-runs with same --name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-name-c) init without --name does NOT write .leina/config.json", () => {
  const dir = tmpProject();
  try {
    runInit(dir, "--agent", "devin");
    const cfgPath = join(dir, ".leina", "config.json");
    assert.ok(!existsSync(cfgPath), ".leina/config.json must NOT be written without --name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// install-init-flow: init no longer activates global share; nudge + --activate
// ---------------------------------------------------------------------------

function spawnInit(
  project: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", project, ...args],
    { encoding: "utf8", env },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("(i-no-share) init does NOT populate the global share (no .version sentinel)", () => {
  const dir = tmpProject();
  const isolatedHome = mkdtempSync(join(tmpdir(), "leina-init-no-share-"));
  try {
    const env = { ...process.env, LEINA_HOME: join(isolatedHome, ".leina"), HOME: isolatedHome, USERPROFILE: isolatedHome };
    const { status } = spawnInit(dir, env, "--agent", "devin");
    assert.equal(status, 0, "init exits 0");
    // Share NOT populated by init
    assert.ok(
      !existsSync(join(isolatedHome, ".leina", "share", ".version")),
      "no .version sentinel — init no longer populates the global share",
    );
    // Project files ARE still written
    assert.ok(existsSync(join(dir, "AGENTS.md")), "AGENTS.md still written");
    assert.ok(existsSync(join(dir, ".devin", "hooks.v1.json")), ".devin/hooks.v1.json still written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("(i-nudge) init emits global-activation nudge to stderr when share is absent", () => {
  const dir = tmpProject();
  const isolatedHome = mkdtempSync(join(tmpdir(), "leina-init-nudge-"));
  try {
    const env = { ...process.env, LEINA_HOME: join(isolatedHome, ".leina"), HOME: isolatedHome, USERPROFILE: isolatedHome };
    const { status, stderr } = spawnInit(dir, env, "--agent", "devin");
    assert.equal(status, 0, "init exits 0");
    assert.match(stderr, /global activation not detected/, "nudge emitted on stderr");
    assert.match(stderr, /leina activate/, "nudge names the activate command");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("(i-no-nudge) init emits NO nudge when global activation is present", () => {
  const dir = tmpProject();
  const isolatedHome = mkdtempSync(join(tmpdir(), "leina-init-no-nudge-"));
  try {
    const env = { ...process.env, LEINA_HOME: join(isolatedHome, ".leina"), HOME: isolatedHome, USERPROFILE: isolatedHome };
    // Pre-activate by running `activate` first
    spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "activate", "--no-user-hooks"],
      { encoding: "utf8", env },
    );
    assert.ok(
      existsSync(join(isolatedHome, ".leina", "share", ".version")),
      "share populated (pre-condition)",
    );
    // Now init — should NOT emit nudge since activation is present
    const { status, stderr } = spawnInit(dir, env, "--agent", "devin");
    assert.equal(status, 0, "init exits 0");
    assert.doesNotMatch(stderr, /global activation not detected/, "no nudge when activation is present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});



// ---------------------------------------------------------------------------
// PR2: init adaptativo — tests de build y artefactos
// ---------------------------------------------------------------------------

// I2: init sin --build nunca lanza build automático (no auto-build).
test("(i-autobuild-1) init sin --build nunca crea graph.db ni dice 'Building graph in background'", () => {
  const dir = tmpProject();
  try {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir, "--agent", "devin"],
      { encoding: "utf8", env: TEST_ENV },
    );
    assert.equal(result.status, 0, `exit 0 (stdout: ${result.stdout}, stderr: ${result.stderr})`);
    // PR2: no hay auto-build; el report siempre dice cómo construir manualmente.
    assert.doesNotMatch(result.stdout, /Building graph in background/);
    assert.match(result.stdout, /leina build/);
    // graph.db no creado sin --build
    assert.ok(!existsSync(join(dir, ".leina", "graph.db")), "graph.db NOT created without --build");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-autobuild-2) init con graph.db pre-existente no dice 'Building graph in background'", () => {
  const dir = tmpProject();
  try {
    // Pre-create graph.db
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(join(dir, ".leina", "graph.db"), "");

    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir, "--agent", "devin"],
      { encoding: "utf8", env: TEST_ENV },
    );
    assert.equal(result.status, 0, `exit 0 (stdout: ${result.stdout}, stderr: ${result.stderr})`);
    assert.doesNotMatch(result.stdout, /Building graph in background/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PR2 — init adaptativo LIGHT/FULL (I1, I2, I3)
// ---------------------------------------------------------------------------

test("(I1-1) init LIGHT (blanket activo): solo consent + gitignore; AGENTS.md y .devin/* NO escritos", () => {
  // LIGHT branch: isBlanketActive()=true → writeConsentFlag("enabled") + ensure gitignore.
  // NO AGENTS.md, NO .devin/hooks.v1.json, NO .devin/config.json, NO user-global mutation.
  const dir = tmpProject();
  const isolatedHome = mkdtempSync(join(tmpdir(), "leina-init-light-"));
  const pdHome = join(isolatedHome, ".leina");
  try {
    // Crear el sentinel blanket
    mkdirSync(pdHome, { recursive: true });
    writeFileSync(join(pdHome, ".blanket"), "");

    const env = {
      ...process.env,
      LEINA_HOME: pdHome,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    };
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, `exit 0 (stderr: ${result.stderr})`);
    assert.match(result.stdout, /LIGHT/, "report indica modo LIGHT");

    // Consent flag written (I1-1)
    const consentPath = join(dir, ".leina", "consent");
    assert.ok(existsSync(consentPath), "consent flag written");
    assert.equal(readFileSync(consentPath, "utf8").trim(), "enabled", "consent = 'enabled'");

    // Gitignore written (I1-1)
    assert.ok(existsSync(join(dir, ".gitignore")), ".gitignore written");

    // AGENTS.md NOT written (I1-1: LIGHT no escribe AGENTS.md)
    assert.ok(!existsSync(join(dir, "AGENTS.md")), "AGENTS.md NOT written in LIGHT mode");

    // .devin/ NOT created (I1-1: LIGHT no escribe hooks ni config local)
    assert.ok(!existsSync(join(dir, ".devin")), ".devin/ NOT created in LIGHT mode");

    // User-global NOT written (I3)
    assert.ok(
      !existsSync(join(isolatedHome, ".config", "devin", "config.json")),
      "~/.config/devin/config.json NOT written in LIGHT mode (I3)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("(I1-2) init FULL (sin blanket): todos los artefactos del repo; user-global NO mutado (I3)", () => {
  // FULL branch: isBlanketActive()=false → AGENTS.md + hooks + local grant + gitignore + consent.
  // user-global ~/.config/devin/config.json nunca es tocado (I3).
  const dir = tmpProject();
  const isolatedHome = mkdtempSync(join(tmpdir(), "leina-init-full-"));
  const pdHome = join(isolatedHome, ".leina");
  try {
    const env = {
      ...process.env,
      LEINA_HOME: pdHome,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    };
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, `exit 0 (stderr: ${result.stderr})`);
    assert.match(result.stdout, /FULL/, "report indica modo FULL");

    // Consent flag (I1-2)
    const consentPath = join(dir, ".leina", "consent");
    assert.ok(existsSync(consentPath), "consent flag written");
    assert.equal(readFileSync(consentPath, "utf8").trim(), "enabled");

    // Gitignore (I1-2)
    assert.ok(existsSync(join(dir, ".gitignore")), ".gitignore written");

    // AGENTS.md written (I1-2)
    assert.ok(existsSync(join(dir, "AGENTS.md")), "AGENTS.md written in FULL mode");

    // .devin/hooks.v1.json written (I1-2)
    assert.ok(existsSync(join(dir, ".devin", "hooks.v1.json")), ".devin/hooks.v1.json written");

    // .devin/config.json with LOCAL Exec grant (I1-2)
    assert.ok(existsSync(join(dir, ".devin", "config.json")), ".devin/config.json written");
    const localCfg = JSON.parse(readFileSync(join(dir, ".devin", "config.json"), "utf8"));
    assert.ok(
      Array.isArray(localCfg.permissions?.allow) &&
        localCfg.permissions.allow.includes("Exec(leina)"),
      "local Exec(leina) grant present",
    );

    // User-global NOT written (I3)
    assert.ok(
      !existsSync(join(isolatedHome, ".config", "devin", "config.json")),
      "~/.config/devin/config.json NOT written in FULL mode (I3)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("(I1-3) init LIGHT idempotente — re-init no duplica bloques en .gitignore", () => {
  const dir = tmpProject();
  const isolatedHome = mkdtempSync(join(tmpdir(), "leina-init-light-idem-"));
  const pdHome = join(isolatedHome, ".leina");
  try {
    mkdirSync(pdHome, { recursive: true });
    writeFileSync(join(pdHome, ".blanket"), "");
    const env = {
      ...process.env,
      LEINA_HOME: pdHome,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    };
    const args = ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir];
    spawnSync(process.execPath, args, { encoding: "utf8", env });
    const gitignoreFirst = readFileSync(join(dir, ".gitignore"), "utf8");

    spawnSync(process.execPath, args, { encoding: "utf8", env });
    const gitignoreSecond = readFileSync(join(dir, ".gitignore"), "utf8");

    assert.equal(gitignoreFirst, gitignoreSecond, ".gitignore byte-idéntico en re-run LIGHT");
    assert.equal(
      gitignoreSecond.split("leina:ignore:start").length - 1,
      1,
      "exactamente un bloque gitignore gestionado",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("(I2-2) init --build construye el grafo síncronamente en foreground (graph.db creado)", () => {
  // --build: llamada síncrona a handleBuild; graph.db debe existir al retornar.
  const dir = tmpProject();
  try {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir, "--build"],
      { encoding: "utf8", env: TEST_ENV, timeout: 90_000 },
    );
    assert.equal(result.status, 0, `exit 0 (stderr: ${result.stderr})`);
    assert.ok(existsSync(join(dir, ".leina", "graph.db")), "graph.db creado con --build");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R-5 — --profile / --agent flag handling
// ---------------------------------------------------------------------------

test("(i-R5-agent-devin-alias) --agent devin is a back-compat alias: exit 0 and writes AGENTS.md", () => {
  const dir = tmpProject();
  try {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir, "--agent", "devin"],
      { encoding: "utf8", env: TEST_ENV },
    );
    assert.equal(result.status, 0, `exit 0 (stderr: ${result.stderr})`);
    assert.ok(existsSync(join(dir, "AGENTS.md")), "AGENTS.md written via --agent devin alias");
    // Devin profile: no capabilities section
    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(!content.includes("## Capabilities (leina)"), "no capabilities section for Devin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-R5-agent-devin-alias-identical) --agent devin produces AGENTS.md identical to --profile devin", () => {
  const dirAgent   = tmpProject();
  const dirProfile = tmpProject();
  try {
    spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dirAgent, "--agent", "devin"],
      { encoding: "utf8", env: TEST_ENV },
    );
    spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dirProfile, "--profile", "devin"],
      { encoding: "utf8", env: TEST_ENV },
    );
    const agentContent   = readFileSync(join(dirAgent, "AGENTS.md"), "utf8");
    const profileContent = readFileSync(join(dirProfile, "AGENTS.md"), "utf8");
    assert.equal(agentContent, profileContent, "--agent devin and --profile devin produce identical AGENTS.md");
  } finally {
    rmSync(dirAgent,   { recursive: true, force: true });
    rmSync(dirProfile, { recursive: true, force: true });
  }
});

test("(i-R5-agent-windsurf-fails) --agent windsurf fails with exit ≠ 0 and stderr mentioning --profile windsurf", () => {
  const dir = tmpProject();
  try {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir, "--agent", "windsurf"],
      { encoding: "utf8", env: TEST_ENV },
    );
    assert.notEqual(result.status, 0, "exit code must be non-zero");
    assert.match(result.stderr, /--profile windsurf/, "stderr mentions --profile windsurf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-R5-profile-windsurf-caps) --profile windsurf writes ## Capabilities section", () => {
  const dir = tmpProject();
  try {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir, "--profile", "windsurf"],
      { encoding: "utf8", env: TEST_ENV },
    );
    assert.equal(result.status, 0, `exit 0 (stderr: ${result.stderr})`);
    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(content.includes("## Capabilities (leina)"), "capabilities heading present");
    // One line per registry capability
    const capLines = content.split("\n").filter((l) => l.startsWith("- `"));
    assert.equal(capLines.length, 17, "17 capability lines present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-R5-profile-windsurf-idempotent) double --profile windsurf init produces byte-identical AGENTS.md", () => {
  const dir = tmpProject();
  try {
    const args = ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir, "--profile", "windsurf"];
    spawnSync(process.execPath, args, { encoding: "utf8", env: TEST_ENV });
    const first = readFileSync(join(dir, "AGENTS.md"), "utf8");

    spawnSync(process.execPath, args, { encoding: "utf8", env: TEST_ENV });
    const second = readFileSync(join(dir, "AGENTS.md"), "utf8");

    assert.equal(first, second, "AGENTS.md is byte-identical after double Windsurf init");
    // Only one capabilities block
    assert.equal(
      second.split("leina:capabilities:start").length - 1,
      1,
      "exactly one capabilities section",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Uniform error contract (F1.4): best-effort steps + ✖ report + exit 1
// ---------------------------------------------------------------------------

test("(i-err-1) a failing step does not abort init: remaining steps run, ✖ reported, exit 1", () => {
  const dir = tmpProject();
  try {
    // Make `.devin` a FILE so mkdirSync(.devin) fails for config.json AND hooks.v1.json,
    // while AGENTS.md / .gitignore / consent can still be written.
    writeFileSync(join(dir, ".devin"), "not a directory");

    const r = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir],
      { encoding: "utf8", env: TEST_ENV },
    );

    assert.equal(r.status, 1, "exit code 1 on partial failure");
    // The failing steps are reported, each with ✖
    assert.match(r.stdout, /✖ \.devin\/config\.json:/);
    assert.match(r.stdout, /✖ \.devin\/hooks\.v1\.json:/);
    assert.match(r.stdout, /finished with 2 error\(s\)/);
    assert.match(r.stdout, /re-run 'leina init'/);
    // Best-effort: the independent steps were still applied
    assert.ok(existsSync(join(dir, "AGENTS.md")), "AGENTS.md still written");
    assert.ok(existsSync(join(dir, ".gitignore")), ".gitignore still written");
    assert.ok(existsSync(join(dir, ".leina", "consent")), "consent still written");
    assert.match(r.stdout, /\+ AGENTS\.md/);
    assert.match(r.stdout, /\+ \.leina\/consent \(enabled\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(i-err-2) clean init still exits 0 with no ✖ lines", () => {
  const dir = tmpProject();
  try {
    const r = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", dir],
      { encoding: "utf8", env: TEST_ENV },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /✖/);
    assert.doesNotMatch(r.stdout, /error\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Host-aware init — host wiring follows --hosts / persisted selection / detection
// ---------------------------------------------------------------------------

// Fresh LEINA_HOME per test so a persisted selection never leaks into the suite's
// shared TEMP_HOME (where detection resolves to devin-only).
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "leina-init-hosts-home-"));
}

function runInitHome(home: string, project: string, ...args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "init", "--project", project, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, LEINA_HOME: home, HOME: home, USERPROFILE: home, LEINA_DISABLE_AUTOBUILD: "1" },
    },
  );
}

test("(i-h1) init --hosts claude writes .claude/settings.json hooks and NO .devin wiring", () => {
  const dir = tmpProject();
  const home = freshHome();
  try {
    const out = runInitHome(home, dir, "--hosts", "claude");
    assert.match(out, /hosts: claude/);
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.hooks, ".claude/settings.json hooks written");
    assert.ok(!existsSync(join(dir, ".devin", "hooks.v1.json")), "no devin hooks for a claude-only init");
    assert.ok(!existsSync(join(dir, ".devin", "config.json")), "no devin Exec grant for a claude-only init");
    assert.ok(existsSync(join(dir, "AGENTS.md")), "host-neutral AGENTS.md still written");
    assert.equal(readFileSync(join(dir, ".leina", "consent"), "utf8").trim(), "enabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("(i-h2) init --hosts devin,claude writes both hosts' wiring", () => {
  const dir = tmpProject();
  const home = freshHome();
  try {
    const out = runInitHome(home, dir, "--hosts", "devin,claude");
    assert.match(out, /hosts: devin, claude/);
    assert.ok(existsSync(join(dir, ".devin", "hooks.v1.json")), "devin hooks written");
    assert.ok(existsSync(join(dir, ".devin", "config.json")), "devin Exec grant written");
    assert.ok(existsSync(join(dir, ".claude", "settings.json")), "claude hooks written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("(i-h3) init --hosts with an unknown host fails naming the known ones", () => {
  const dir = tmpProject();
  const home = freshHome();
  try {
    assert.throws(() => runInitHome(home, dir, "--hosts", "cursor"), /unknown host "cursor"/);
    assert.ok(!existsSync(join(dir, "AGENTS.md")), "nothing written on a rejected --hosts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("(i-h4) without --hosts, init follows the persisted selection (activate/tui)", () => {
  const dir = tmpProject();
  const home = freshHome();
  try {
    mkdirSync(join(home, "share"), { recursive: true });
    writeFileSync(
      join(home, "share", ".selection.json"),
      JSON.stringify({ version: 1, skills: null, agents: null, hosts: ["claude"] }),
    );
    runInitHome(home, dir);
    assert.ok(existsSync(join(dir, ".claude", "settings.json")), "claude hooks from persisted selection");
    assert.ok(!existsSync(join(dir, ".devin", "hooks.v1.json")), "devin not selected → not wired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("(i-h5) without --hosts or selection, detection wires devin only (isolated HOME)", () => {
  const dir = tmpProject();
  const home = freshHome();
  try {
    const out = runInitHome(home, dir);
    assert.match(out, /hosts: devin/);
    assert.ok(existsSync(join(dir, ".devin", "hooks.v1.json")), "devin wired by default detection");
    assert.ok(!existsSync(join(dir, ".claude", "settings.json")), "no ~/.claude on this HOME → claude not wired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("(i-h6) detection lights up claude when ~/.claude exists on the machine", () => {
  const dir = tmpProject();
  const home = freshHome();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const out = runInitHome(home, dir);
    assert.match(out, /hosts: devin, claude/);
    assert.ok(existsSync(join(dir, ".devin", "hooks.v1.json")), "devin wired");
    assert.ok(existsSync(join(dir, ".claude", "settings.json")), "claude auto-detected and wired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("(i-h7) --claude-hooks still forces claude wiring when the host is not selected", () => {
  const dir = tmpProject();
  const home = freshHome();
  try {
    runInitHome(home, dir, "--hosts", "devin", "--claude-hooks");
    assert.ok(existsSync(join(dir, ".devin", "hooks.v1.json")), "devin wired");
    assert.ok(existsSync(join(dir, ".claude", "settings.json")), "--claude-hooks forces claude wiring");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("(i-h8) hasHookWiring sees claude-only wiring (repair evidence / tui badge)", async () => {
  const { hasHookWiring } = await import("../src/cli/handlers/install.ts");
  const dir = tmpProject();
  const home = freshHome();
  try {
    assert.equal(hasHookWiring(dir), false, "fresh repo: no wiring");
    runInitHome(home, dir, "--hosts", "claude");
    assert.equal(hasHookWiring(dir), true, "claude-only init counts as wiring evidence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test.after(() => {
  try {
    rmSync(TEMP_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
