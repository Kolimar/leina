// env-cli.test.ts — `leina env` under the names-not-values contract, plus the pure store.
// The interactive hidden-prompt path needs a real TTY and is not exercised here; the piped
// stdin path (the agent/script form) covers persistence end-to-end.
// Run: node --no-warnings --experimental-strip-types --test test/env-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  maskValue,
  parseEnvFile,
  removeEnvVar,
  upsertEnvVar,
} from "../src/application/env/store.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function makeSandbox(): { env: NodeJS.ProcessEnv; home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "leina-env-cli-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEINA_HOME: join(home, ".leina"),
    HOME: home,
    USERPROFILE: home,
  };
  return { env, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runEnv(env: NodeJS.ProcessEnv, args: string[], input?: string) {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "env", ...args],
    { encoding: "utf8", env, input },
  );
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// (envs-*) Pure store
// ---------------------------------------------------------------------------

test("(envs-1) upsert creates the store with header, replaces in place, preserves comments", () => {
  const v1 = upsertEnvVar(null, "API_KEY", "secret-1");
  assert.match(v1, /^# leina env store/);
  assert.match(v1, /\nAPI_KEY=secret-1\n$/);

  const withComment = `${v1  }# mine\nOTHER=x\n`;
  const v2 = upsertEnvVar(withComment, "API_KEY", "secret-2");
  assert.match(v2, /API_KEY=secret-2/);
  assert.doesNotMatch(v2, /secret-1/);
  assert.match(v2, /# mine/);
  assert.match(v2, /OTHER=x/);
  // Idempotent
  assert.equal(upsertEnvVar(v2, "API_KEY", "secret-2"), v2);
});

test("(envs-2) parse handles quotes and skips malformed/comment lines; remove works", () => {
  const entries = parseEnvFile('# c\nA=1\nB="two words"\nBAD LINE\nC=\'x\'\n');
  assert.deepEqual(entries, [
    { key: "A", value: "1" },
    { key: "B", value: "two words" },
    { key: "C", value: "x" },
  ]);
  const removed = removeEnvVar("A=1\nB=2\n", "A");
  assert.equal(removed, "B=2\n");
  assert.equal(removeEnvVar("B=2\n", "A"), null);
});

test("(envs-3) masking never reconstructs the secret", () => {
  assert.equal(maskValue(""), "(empty)");
  assert.equal(maskValue("abc"), "****");
  assert.equal(maskValue("sk-1234567890"), "sk-****");
});

test("(envs-4) invalid names and multi-line values are rejected", () => {
  assert.throws(() => upsertEnvVar(null, "BAD NAME", "x"), /invalid variable name/);
  assert.throws(() => upsertEnvVar(null, "A", "x\ny"), /single-line/);
});

// ---------------------------------------------------------------------------
// (envc-*) CLI end-to-end (piped stdin path)
// ---------------------------------------------------------------------------

test("(envc-1) set via stdin → 0600 file; list masks; get masks; unset removes", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const set = runEnv(env, ["set", "API_KEY"], "super-secret-token\n");
    assert.equal(set.status, 0, set.stderr);

    const envFile = join(home, ".leina", ".env");
    assert.ok(existsSync(envFile), ".env created");
    if (process.platform !== "win32") {
      assert.equal(statSync(envFile).mode & 0o777, 0o600, "owner-only perms");
    }
    assert.match(readFileSync(envFile, "utf8"), /API_KEY=super-secret-token/);

    const list = runEnv(env, ["list"]);
    assert.match(list.stdout, /API_KEY=sup\*\*\*\*/);
    assert.doesNotMatch(list.stdout, /super-secret-token/, "list never shows the value");

    const get = runEnv(env, ["get", "API_KEY"]);
    assert.doesNotMatch(get.stdout, /super-secret-token/, "get without --reveal masks");

    const unset = runEnv(env, ["unset", "API_KEY"]);
    assert.equal(unset.status, 0);
    assert.doesNotMatch(readFileSync(envFile, "utf8"), /API_KEY/);
  } finally {
    cleanup();
  }
});

test("(envc-2) get --reveal REFUSES when stdout is piped (the agent-capture case)", () => {
  const { env, cleanup } = makeSandbox();
  try {
    runEnv(env, ["set", "TOKEN"], "hunter2\n");
    const r = runEnv(env, ["get", "TOKEN", "--reveal"]);
    assert.equal(r.status, 1, "refused");
    assert.match(r.stderr, /interactive terminal/);
    assert.doesNotMatch(r.stdout, /hunter2/, "value never reaches a piped stdout");
  } finally {
    cleanup();
  }
});

test("(envc-3) exec injects the stored values into the child process only", () => {
  const { env, cleanup } = makeSandbox();
  try {
    runEnv(env, ["set", "SVC_TOKEN"], "tok-123\n");
    runEnv(env, ["set", "OTHER"], "zzz\n");

    const r = runEnv(env, ["exec", "--", process.execPath, "-e", "console.log(process.env.SVC_TOKEN)"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /tok-123/);

    // --only scopes the injection
    const scoped = runEnv(env, [
      "exec", "--only", "OTHER", "--",
      process.execPath, "-e", "console.log(process.env.SVC_TOKEN ?? 'absent', process.env.OTHER)",
    ]);
    assert.match(scoped.stdout, /absent zzz/);

    // child exit code propagates
    const failCmd = runEnv(env, ["exec", "--", process.execPath, "-e", "process.exit(3)"]);
    assert.equal(failCmd.status, 3);
  } finally {
    cleanup();
  }
});

test("(envc-4) invalid subcommands and key names fail with usage", () => {
  const { env, cleanup } = makeSandbox();
  try {
    assert.equal(runEnv(env, []).status, 1);
    assert.match(runEnv(env, ["set", "BAD NAME"]).stderr, /Usage|invalid variable name/);
    assert.match(runEnv(env, ["get", "NOPE"]).stderr, /not set/);
    assert.match(runEnv(env, ["exec"]).stderr, /missing command/);
  } finally {
    cleanup();
  }
});
