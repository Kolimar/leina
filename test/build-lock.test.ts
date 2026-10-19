// build-lock.test.ts — the cross-process graph build lock (cli/background-build.ts) and the
// read path that now goes through it (cli/wiring.ts rebuildIfStillStale).
//
// Before: the lock was opened O_RDWR|O_CREAT (two simultaneous callers could both "acquire"
// it), and only `leina build`/`refresh` and the detached self-heal took it — N concurrent
// `leina query` processes against a stale graph each ran their own full rebuild (4 queries on
// a 790-file repo: 4 rebuilds, ~4.4 GB of combined peak RSS). Now acquisition is an O_EXCL
// create, the read path takes the same lock, and a reader that waited re-checks staleness
// and skips the rebuild another process just did.
// Run: node --no-warnings --experimental-strip-types --test test/build-lock.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireBuildLock,
  acquireForegroundBuildLock,
  buildLockPath,
  lockTimeoutMessage,
  releaseBuildLock,
} from "../src/cli/background-build.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const LOCK_MODULE = pathToFileURL(fileURLToPath(new URL("../src/cli/background-build.ts", import.meta.url))).href;

const SANDBOX = mkdtempSync(join(tmpdir(), "leina-lock-sandbox-"));
const CHILD_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: join(SANDBOX, "home"),
  XDG_CONFIG_HOME: join(SANDBOX, "home", ".config"),
  LEINA_HOME: join(SANDBOX, "leina-home"),
  LEINA_DISABLE_AUTOBUILD: "1",
  LEINA_FRESHNESS: "auto",
};
mkdirSync(join(SANDBOX, "home"), { recursive: true });
test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** A live pid that is not ours: the test runner's parent. */
const FOREIGN_LIVE_PID = process.ppid;

function tmpRoot(tag: string): string {
  const dir = mkdtempSync(join(SANDBOX, `${tag}-`));
  mkdirSync(join(dir, ".leina"), { recursive: true });
  return dir;
}

function holdLock(root: string, pid: number, startedAt = Date.now()): void {
  writeFileSync(buildLockPath(root), JSON.stringify({ pid, startedAt }));
}

test("(lock-1) a free lock is acquired at once, names this process, and is released", async () => {
  const root = tmpRoot("free");
  const r = await acquireBuildLock(root, { sleep: () => Promise.reject(new Error("must not wait")) });
  assert.deepEqual(r, { acquired: true, waited: false });
  assert.equal((JSON.parse(readFileSync(buildLockPath(root), "utf8")) as { pid: number }).pid, process.pid);
  releaseBuildLock(root);
  assert.equal(existsSync(buildLockPath(root)), false);
});

test("(lock-2) a live foreign holder: onWait fires once, then the lock is taken when it is released", async () => {
  const root = tmpRoot("wait");
  holdLock(root, FOREIGN_LIVE_PID);
  const seen: number[] = [];
  let sleeps = 0;
  const r = await acquireBuildLock(root, {
    waitMs: 10_000,
    onWait: (h) => seen.push(h.pid),
    sleep: () => {
      if (++sleeps === 3) rmSync(buildLockPath(root));
      return Promise.resolve();
    },
  });
  assert.deepEqual(r, { acquired: true, waited: true });
  assert.deepEqual(seen, [FOREIGN_LIVE_PID], "announced once, naming the holder");
  releaseBuildLock(root);
});

test("(lock-3) a holder that never releases → bounded wait, then a timeout naming it", async () => {
  const root = tmpRoot("timeout");
  holdLock(root, FOREIGN_LIVE_PID);
  const r = await acquireBuildLock(root, { waitMs: 50, sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)) });
  assert.ok("timeout" in r);
  assert.equal(r.holderPid, FOREIGN_LIVE_PID);
  const msg = lockTimeoutMessage(root, r.holderPid, r.holderStartedAt);
  assert.match(msg, new RegExp(`^another build is running \\(pid ${FOREIGN_LIVE_PID}, started \\d+s ago\\)`));
  assert.ok(msg.includes(buildLockPath(root)), "names the lock file to delete if stuck");
  assert.equal(existsSync(buildLockPath(root)), true, "the holder's lock is untouched");
});

test("(lock-4) release only removes a lock this process holds", () => {
  const root = tmpRoot("release");
  holdLock(root, FOREIGN_LIVE_PID);
  releaseBuildLock(root);
  assert.equal(existsSync(buildLockPath(root)), true, "a foreign lock survives our release");
});

test("(lock-5) an empty lock is a creator mid-write for a grace period, then abandoned", () => {
  const root = tmpRoot("empty");
  writeFileSync(buildLockPath(root), "");
  const young = acquireForegroundBuildLock(root, { waitMs: 0, sleep: () => assert.fail("waitMs 0 never sleeps") });
  assert.ok("timeout" in young, "a just-created empty lock is held");
  assert.equal(young.holderPid, 0);
  const old = new Date(Date.now() - 60_000);
  utimesSync(buildLockPath(root), old, old);
  const reclaimed = acquireForegroundBuildLock(root, { waitMs: 0 });
  assert.ok("fd" in reclaimed, "an empty lock a minute old is abandoned → reclaimed");
  releaseBuildLock(root);
});

test("(lock-6) processes racing for a free lock: exactly one acquires it (O_EXCL)", async () => {
  const root = tmpRoot("race");
  // All children attempt at the same instant; the lead covers a slow process start (a cold
  // Windows/macOS runner takes well over a second to spawn six strip-types Node processes).
  const startAt = Date.now() + 4000;
  const script =
    `const m = await import(${JSON.stringify(LOCK_MODULE)});` +
    `while (Date.now() < ${startAt}) {}` +
    `const r = m.acquireForegroundBuildLock(${JSON.stringify(root)}, { waitMs: 0 });` +
    `process.stdout.write("fd" in r ? "acquired" : "busy");` +
    // the winner keeps its (live) lock until every contender has tried
    `setTimeout(() => { m.releaseBuildLock(${JSON.stringify(root)}); }, 3000);`;
  const runs = Array.from({ length: 6 }, () =>
    new Promise<string>((ok, ko) => {
      const child = spawn(
        process.execPath,
        ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script],
        { env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.stderr.on("data", (c: Buffer) => (err += c.toString()));
      child.on("error", ko);
      child.on("close", (code) => (code === 0 ? ok(out) : ko(new Error(`child exit ${code}: ${err}`))));
    }),
  );
  const outcomes = await Promise.all(runs);
  assert.equal(outcomes.filter((o) => o === "acquired").length, 1, `one winner: ${outcomes.join(",")}`);
  assert.equal(outcomes.filter((o) => o === "busy").length, 5);
  assert.equal(existsSync(buildLockPath(root)), false, "the winner released it");
});

function runCli(args: string[], env: NodeJS.ProcessEnv = CHILD_ENV): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    env,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function staleRepo(tag: string): string {
  const root = mkdtempSync(join(SANDBOX, `${tag}-`));
  writeFileSync(join(root, "b.ts"), "export function beta(): number { return 1; }\n");
  writeFileSync(join(root, "a.ts"), "import { beta } from \"./b\";\nexport function alpha(): number { return beta(); }\n");
  const built = runCli(["build", root]);
  assert.equal(built.code, 0, built.stderr);
  writeFileSync(join(root, "a.ts"), "import { beta } from \"./b\";\nexport function gamma(): number { return beta(); }\n");
  return root;
}

test("(lock-7) concurrent stale queries in separate processes run ONE rebuild; the rest reuse it", async () => {
  const root = staleRepo("queries");
  // Hold the lock as a live foreign builder so every query is provably waiting before any builds.
  holdLock(root, FOREIGN_LIVE_PID);
  const children = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, "query", root, "gamma"], {
      env: CHILD_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const run = { out: "", err: "", code: null as number | null };
    child.stdout.on("data", (c: Buffer) => (run.out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (run.err += c.toString()));
    const done = new Promise<void>((ok) => child.on("close", (code) => { run.code = code; ok(); }));
    return { run, done };
  });
  const deadline = Date.now() + 60_000;
  while (!children.every((c) => c.run.err.includes("waiting ...")) && Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, 100));
  }
  for (const c of children) {
    assert.match(c.run.err, new RegExp(`graph stale \\(touched:a\\.ts\\); another leina process \\(pid ${FOREIGN_LIVE_PID}\\) is rebuilding it; waiting \\.\\.\\.`));
  }
  rmSync(buildLockPath(root)); // the "foreign build" finishes without fixing anything
  await Promise.all(children.map((c) => c.done));

  const stderrs = children.map((c) => c.run.err);
  const rebuilds = stderrs.flatMap((e) => e.split("\n")).filter((l) => l.endsWith("; rebuilding ..."));
  assert.deepEqual(rebuilds, ["leina: graph still stale (touched:a.ts); rebuilding ..."], stderrs.join("\n---\n"));
  for (const c of children) {
    assert.equal(c.run.code, 0, c.run.err);
    assert.match(c.run.out, /^Seeds: gamma/m, "every query answers from the rebuilt graph");
  }
  assert.equal(existsSync(buildLockPath(root)), false, "the builder released the lock");
  assert.match(runCli(["status", root]).stdout, /^status: fresh \(fresh\)$/m);
});

test("(lock-8) a stale query whose builder never finishes gives up after LEINA_BUILD_LOCK_WAIT_MS", () => {
  const root = staleRepo("stuck");
  holdLock(root, FOREIGN_LIVE_PID);
  const r = runCli(["query", root, "gamma"], { ...CHILD_ENV, LEINA_BUILD_LOCK_WAIT_MS: "300" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`another build is running \\(pid ${FOREIGN_LIVE_PID}, started \\d+s ago\\)`));
  assert.match(r.stderr, /graph\.build\.lock if it is stuck/);
});
