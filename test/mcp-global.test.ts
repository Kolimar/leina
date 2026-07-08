// mcp-global.test.ts — user-global MCP registration (src/infrastructure/install/mcp-hosts.ts)
// and the `leina mcp register|unregister|status` admin commands.
//
// Everything runs against a sandboxed $HOME/$LEINA_HOME. The claude host path is exercised
// only in its "skipped" form (no `claude` binary in the sandboxed PATH) — we never spawn the
// real CLI from tests. json-file hosts (cursor/windsurf) are exercised for the full contract:
// only-if-installed, merge-safe, idempotent, no-clobber, inverse.
// Run: node --no-warnings --experimental-strip-types --test test/mcp-global.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

// Sandboxed env: HOME redirected; PATH pointed at a dedicated EMPTY dir so neither
// `claude` nor `leina` ever resolve — deterministically, on every machine. (The subprocess
// is launched by absolute node path, so node itself doesn't need to be on PATH.) Using the
// node binary's own dir used to leak: a system-wide install puts `leina` right next to
// `node` in /usr/bin, so findOnPath("leina") found it and mcpg-7 (which asserts the server
// command is NOT on PATH) failed on such boxes. An empty dir keeps the claude host on its
// "skipped" branch and the mcp "server command" check on its not-on-PATH branch everywhere.
function sandboxEnv(home: string): NodeJS.ProcessEnv {
  const emptyBin = join(home, ".sandbox-bin");
  mkdirSync(emptyBin, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LEINA_HOME: join(home, ".leina"),
    PATH: emptyBin,
  };
}

function runCli(env: NodeJS.ProcessEnv, ...args: string[]) {
  // Host-selecting commands now require an explicit --hosts. Default the vendor-neutral
  // tests to "devin" when they don't pass one, leaving mcp register/unregister untouched.
  if (["setup", "activate", "init", "install-global"].includes(args[0]!) && !args.includes("--hosts")) {
    args = [...args, "--hosts", "devin"];
  }
  if (args[0] === "init" && !args.includes("--profile") && !args.includes("--agent")) {
    args = [...args, "--profile", "devin"];
  }
  return spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", env },
  );
}

test("(mcpg-1) register: json-file hosts written only when installed; claude skipped without binary", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcpg1-"));
  const env = sandboxEnv(home);
  try {
    // Nothing installed: cursor/windsurf skipped, claude skipped (no binary).
    const r1 = runCli(env, "mcp", "register", "--hosts", "cursor,windsurf,claude");
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    assert.match(r1.stdout, /· Cursor: .*not installed/);
    assert.match(r1.stdout, /· Windsurf: .*not installed/);
    assert.match(r1.stdout, /· Claude Code: .*claude mcp add --scope user leina leina mcp/);
    assert.ok(!existsSync(join(home, ".cursor", "mcp.json")), "never creates a host's tree");

    // Cursor "installed" (dir exists): register writes its config.
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const r2 = runCli(env, "mcp", "register", "--hosts", "cursor,windsurf,claude");
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /\+ Cursor: /);
    const cfg = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    assert.deepEqual(cfg.mcpServers.leina, { command: "leina", args: ["mcp"] });

    // Idempotent: second run → unchanged.
    const r3 = runCli(env, "mcp", "register", "--hosts", "cursor,windsurf,claude");
    assert.match(r3.stdout, /= Cursor: already registered/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("(mcpg-2) register preserves foreign servers; malformed JSON is never clobbered", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcpg2-"));
  const env = sandboxEnv(home);
  try {
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    const file = join(home, ".codeium", "windsurf", "mcp_config.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, custom: 1 }));

    const r = runCli(env, "mcp", "register", "--hosts", "windsurf");
    assert.equal(r.status, 0);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(cfg.mcpServers.other, "foreign server preserved");
    assert.equal(cfg.custom, 1, "unknown top-level key preserved");
    assert.deepEqual(cfg.mcpServers.leina, { command: "leina", args: ["mcp"] });

    // Malformed config → failed, file untouched.
    writeFileSync(file, "{ not json");
    const r2 = runCli(env, "mcp", "register", "--hosts", "windsurf");
    assert.equal(r2.status, 1, "no-clobber failure sets exit 1");
    assert.match(r2.stdout, /✖ Windsurf: .*not valid JSON/);
    assert.equal(readFileSync(file, "utf8"), "{ not json", "malformed file untouched");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("(mcpg-3) unregister strips only the leina entry; unknown --hosts rejected", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcpg3-"));
  const env = sandboxEnv(home);
  try {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { leina: { command: "leina", args: ["mcp"] }, other: { command: "x" } } }),
    );

    const r = runCli(env, "mcp", "unregister", "--hosts", "cursor");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\+ Cursor: leina entry removed/);
    const cfg = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    assert.ok(!("leina" in cfg.mcpServers), "leina removed");
    assert.ok(cfg.mcpServers.other, "foreign server preserved");

    // Second run: nothing to do.
    const r2 = runCli(env, "mcp", "unregister", "--hosts", "cursor");
    assert.match(r2.stdout, /= Cursor: no leina entry/);

    const bad = runCli(env, "mcp", "register", "--hosts", "vscode");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown MCP host "vscode"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("(mcpg-4) status reports per-host state without writing anything", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcpg4-"));
  const env = sandboxEnv(home);
  try {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { leina: { command: "leina", args: ["mcp"] } } }));

    const r = runCli(env, "mcp", "status");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✔ Cursor: registered/);
    assert.match(r.stdout, /· Windsurf: not-installed/);
    assert.match(r.stdout, /Claude Code: (not-installed|absent)/);
    assert.match(r.stdout, /leina mcp register/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("(mcpg-5) activate --mcp registers; deactivate removes the registration", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcpg5-"));
  const env = sandboxEnv(home);
  try {
    mkdirSync(join(home, ".cursor"), { recursive: true });

    // --mcp now needs its own explicit --mcp-hosts (MCP hosts differ from install --hosts).
    const r = runCli(env, "activate", "--mcp", "--mcp-hosts", "cursor", "--hosts", "claude");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /user-global MCP registration/);
    const cfg = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    assert.deepEqual(cfg.mcpServers.leina, { command: "leina", args: ["mcp"] });

    // Plain activate (no --mcp) must not touch registrations.
    rmSync(join(home, ".cursor", "mcp.json"));
    const r2 = runCli(env, "activate", "--hosts", "claude");
    assert.equal(r2.status, 0);
    assert.ok(!existsSync(join(home, ".cursor", "mcp.json")), "no registration without --mcp");

    // Re-register, then deactivate removes it (leaving the file's other content).
    runCli(env, "mcp", "register", "--hosts", "cursor");
    const r3 = runCli(env, "deactivate");
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
    const after = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    assert.ok(!("leina" in (after.mcpServers ?? {})), "deactivate removed the leina entry");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("(mcpg-6) init --mcp also grants mcp__leina in project .claude/settings.json; deinit revokes", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcpg6-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcpg6-proj-"));
  const env = sandboxEnv(home);
  try {
    const r = runCli(env, "init", "--project", dir, "--mcp");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.permissions.allow.includes("mcp__leina"), "server-level grant present");

    const d = runCli(env, "deinit", "--project", dir);
    assert.equal(d.status, 0, d.stdout + d.stderr);
    const after = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    assert.ok(!(after.permissions?.allow ?? []).includes("mcp__leina"), "grant revoked by deinit");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcpg-7) doctor reports the mcp group; registered-but-not-on-PATH is the only fail", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcpg7-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcpg7-proj-"));
  const env = sandboxEnv(home);
  try {
    // No registrations anywhere: mcp state reported as informational (optional transport,
    // so it lands in the trailing `info:` section, not the actionable groups), no PATH
    // check emitted.
    const r1 = runCli(env, "doctor", dir);
    assert.match(r1.stdout, /\ninfo:/, "info section present");
    assert.match(r1.stdout, /mcp\/\.mcp\.json: no project registration/);
    assert.ok(!r1.stdout.includes("server command"), "no PATH check without a registration");

    // Register in cursor (sandbox PATH has no `leina`): doctor must fail on the launch command.
    mkdirSync(join(home, ".cursor"), { recursive: true });
    runCli(env, "mcp", "register", "--hosts", "cursor");
    const r2 = runCli(env, "doctor", dir);
    assert.match(r2.stdout, /✔ Cursor: registered \(user scope\)/);
    assert.match(r2.stdout, /✘ server command: registered but 'leina' not on PATH/);
    assert.equal(r2.status, 1, "doctor exits 1 on the PATH fail");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
