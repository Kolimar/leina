// env-cli.test.ts — `leina env` under the names-not-values contract, plus the pure store.
// The interactive hidden-prompt path needs a real TTY and is not exercised here; the piped
// stdin path (the agent/script form) covers persistence end-to-end.
// Run: node --no-warnings --experimental-strip-types --test test/env-cli.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile, writeEnvFile } from "../src/infrastructure/env/env-file.ts";
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

test("(envs-5) unset/set match every line the parser reads as KEY (hand-edited spacing)", () => {
  const edited = "# keep me: TOKEN=not-a-var\n  TOKEN =secret\nB=2\n";
  assert.deepEqual(parseEnvFile(edited), [{ key: "TOKEN", value: "secret" }, { key: "B", value: "2" }]);

  assert.equal(removeEnvVar(edited, "TOKEN"), "# keep me: TOKEN=not-a-var\nB=2\n", "the spaced line is removed, the comment kept");

  const replaced = upsertEnvVar(edited, "TOKEN", "fresh");
  assert.deepEqual(parseEnvFile(replaced), [{ key: "TOKEN", value: "fresh" }, { key: "B", value: "2" }], "replaced in place, not appended");
  assert.match(replaced, /# keep me: TOKEN=not-a-var/);
});

test("(envs-6) duplicate keys: one value everywhere, collapsed on write, all removed on unset", () => {
  const dup = "A=1\nB=2\nA=3\n";
  assert.deepEqual(parseEnvFile(dup), [{ key: "A", value: "3" }, { key: "B", value: "2" }], "last wins, listed once");
  assert.equal(upsertEnvVar(dup, "A", "9"), "A=9\nB=2\n", "set collapses the duplicates");
  assert.equal(removeEnvVar(dup, "A"), "B=2\n", "unset removes every occurrence");
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

test("(envc-5) unset/set on a hand-edited 'TOKEN =value' line: removed for real; get and exec agree", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const envFile = join(home, ".leina", ".env");
    runEnv(env, ["set", "OTHER"], "x\n");
    writeFileSync(envFile, `${readFileSync(envFile, "utf8")}TOKEN =old-secret\nTOKEN=shadow\n`, { mode: 0o600 });

    const set = runEnv(env, ["set", "TOKEN"], "new-secret\n");
    assert.equal(set.status, 0, set.stderr);
    assert.equal(readFileSync(envFile, "utf8").match(/TOKEN/g)?.length, 1, "a single TOKEN line remains");
    const r = runEnv(env, ["exec", "--only", "TOKEN", "--", process.execPath, "-e", "console.log(process.env.TOKEN)"]);
    assert.match(r.stdout, /new-secret/);

    const unset = runEnv(env, ["unset", "TOKEN"]);
    assert.match(unset.stdout, /TOKEN removed/);
    assert.doesNotMatch(readFileSync(envFile, "utf8"), /TOKEN/);
    assert.match(runEnv(env, ["get", "TOKEN"]).stderr, /not set/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (envf-*) env-file I/O: every write replaces the store atomically with a fresh 0600 file
// ---------------------------------------------------------------------------

// Point the in-process env-file adapter at a throwaway LEINA_HOME for the callback.
function withLeinaHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "leina-env-file-"));
  const saved = process.env.LEINA_HOME;
  process.env.LEINA_HOME = home;
  try {
    fn(home);
  } finally {
    if (saved === undefined) delete process.env.LEINA_HOME;
    else process.env.LEINA_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
}

test("(envf-1) a loosened (0644) store never receives the new secret: it is replaced, not rewritten", { skip: process.platform === "win32" ? "POSIX modes" : false }, () => {
  withLeinaHome((home) => {
    const p = join(home, ".env");
    writeFileSync(p, "OLD=1\n", { mode: 0o644 });
    chmodSync(p, 0o644);
    // A second name for the loose inode — what a reader holding the old file would see.
    linkSync(p, join(home, "old-inode"));

    writeEnvFile("OLD=1\nNEW=top-secret\n");

    assert.equal(statSync(p).mode & 0o777, 0o600, "the store is 0600");
    assert.match(readFileSync(p, "utf8"), /NEW=top-secret/);
    assert.doesNotMatch(readFileSync(join(home, "old-inode"), "utf8"), /top-secret/, "the 0644 inode never held it");
    assert.deepEqual(readdirSync(home).sort(), [".env", "old-inode"], "no temp file left behind");
  });
});

test("(envf-2) a write that fails midway (ENOSPC) leaves every stored secret intact", () => {
  withLeinaHome((home) => {
    writeEnvFile("A=1\nB=2\n");
    const enospc = (): never => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    // In-place writers truncate first, then run out of space; temp-file writers fail on
    // the temp. Both paths are simulated so the test does not depend on the implementation
    // (nothing else writes through fs during the synchronous call under test).
    const orig = fs.writeFileSync;
    const m1 = mock.method(fs, "writeFileSync", (file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === "string" && file.startsWith(home)) orig(file, "");
      if (typeof file === "number" || (typeof file === "string" && file.startsWith(home))) enospc();
      return (orig as (...a: unknown[]) => void)(file, ...rest);
    });
    const m2 = mock.method(fs, "writeSync", enospc);
    syncBuiltinESMExports();
    try {
      assert.throws(() => writeEnvFile("A=1\nB=2\nC=3\n"), /ENOSPC/);
    } finally {
      m1.mock.restore();
      m2.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(readEnvFile(), "A=1\nB=2\n", "previous store untouched");
    assert.deepEqual(readdirSync(home), [".env"], "the failed temp file is cleaned up");
  });
});

test("(envc-4) invalid subcommands and key names fail with usage", () => {
  const { env, cleanup } = makeSandbox();
  try {
    // Bare group → its help on stdout, exit 0.
    const bare = runEnv(env, []);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /leina env — /);
    // Usage errors → stderr + exit 2; a missing variable is a runtime failure (exit 1).
    const unknown = runEnv(env, ["frob"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown sub-command 'frob'/);
    const bad = runEnv(env, ["set", "BAD NAME"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /invalid variable name/);
    const nope = runEnv(env, ["get", "NOPE"]);
    assert.equal(nope.status, 1);
    assert.match(nope.stderr, /not set/);
    const exec = runEnv(env, ["exec"]);
    assert.equal(exec.status, 2);
    assert.match(exec.stderr, /missing command/);
  } finally {
    cleanup();
  }
});
