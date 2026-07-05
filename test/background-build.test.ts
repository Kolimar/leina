// background-build.test.ts — unit tests for spawnDetachedBuild lock + spawn logic.
// Run: node --no-warnings --experimental-strip-types --test test/background-build.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  acquireForegroundBuildLock,
  buildLockPath,
  spawnDetachedBuild,
  type BackgroundBuildOutcome,
  type SpawnFn,
} from "../src/cli/background-build.ts";

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "leina-bg-build-"));
  mkdirSync(join(dir, ".leina"), { recursive: true });
  return dir;
}

function writeLock(lockPath: string, pid: number, startedAt: number): void {
  writeFileSync(lockPath, JSON.stringify({ pid, startedAt }));
}

const FAKE_CLI_BASE = { command: "/usr/bin/node", args: ["--no-warnings", "/path/to/cli.js"] };

// (bg-1) Live PID in lock → skip without spawning
test("(bg-1) live PID in existing lock → skipped-lock-active", () => {
  const root = makeTmpRoot();
  try {
    writeLock(buildLockPath(root), process.pid, Date.now());
    let spawned = false;
    const spawner: SpawnFn = () => { spawned = true; return { pid: 1, unref() {} }; };
    const result = spawnDetachedBuild(root, { spawner, cliBase: FAKE_CLI_BASE });
    assert.equal(result, "skipped-lock-active");
    assert.equal(spawned, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// (bg-2) Dead PID (ESRCH) → reclaim lock → spawned
test("(bg-2) dead PID (ESRCH) → reclaims lock → spawned", () => {
  const root = makeTmpRoot();
  try {
    const deadPid = 9_999_997;
    let pidAlive = false;
    try { process.kill(deadPid, 0); pidAlive = true; } catch { /* expected */ }
    if (pidAlive) {
      // PID happens to exist — skip gracefully
      return;
    }

    writeLock(buildLockPath(root), deadPid, Date.now());
    let capturedArgs: string[] = [];
    const spawner: SpawnFn = (_cmd, args) => { capturedArgs = args; return { pid: 12345, unref() {} }; };

    const result = spawnDetachedBuild(root, { spawner, cliBase: FAKE_CLI_BASE });
    assert.equal(result, "spawned");
    assert.ok(capturedArgs.includes("build"), "args must include 'build'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// (bg-3) TTL > 15 min (now injected) → stale → reclaim → spawned
test("(bg-3) TTL >15 min with injected now → stale lock reclaimed → spawned", () => {
  const root = makeTmpRoot();
  try {
    const base = 1_000_000_000;
    writeLock(buildLockPath(root), process.pid, base);
    const now = () => base + 16 * 60_000 + 1;

    let spawned = false;
    const spawner: SpawnFn = () => { spawned = true; return { pid: 1, unref() {} }; };

    const result = spawnDetachedBuild(root, { spawner, now, cliBase: FAKE_CLI_BASE });
    assert.equal(result, "spawned");
    assert.equal(spawned, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// (bg-4) Two sequential calls: first spawns (writes live PID), second skips
test("(bg-4) second call with live lock → skipped-lock-active", () => {
  const root = makeTmpRoot();
  try {
    let firstCalled = false;
    const firstSpawner: SpawnFn = () => {
      firstCalled = true;
      return { pid: process.pid, unref() {} };
    };
    const r1 = spawnDetachedBuild(root, { spawner: firstSpawner, cliBase: FAKE_CLI_BASE });
    assert.equal(r1, "spawned");
    assert.equal(firstCalled, true);

    let secondCalled = false;
    const secondSpawner: SpawnFn = () => { secondCalled = true; return { pid: 1, unref() {} }; };
    const r2 = spawnDetachedBuild(root, { spawner: secondSpawner, cliBase: FAKE_CLI_BASE });
    assert.equal(r2, "skipped-lock-active");
    assert.equal(secondCalled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// (bg-5) Spawner throws → fail-open → "failed", no exception propagated
test("(bg-5) spawner throws → returns 'failed', never propagates exception", () => {
  const root = makeTmpRoot();
  try {
    const throwingSpawner: SpawnFn = () => { throw new Error("spawn failed"); };
    let threw = false;
    let result: BackgroundBuildOutcome = "failed";
    try {
      result = spawnDetachedBuild(root, { spawner: throwingSpawner, cliBase: FAKE_CLI_BASE });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "must not propagate");
    assert.equal(result, "failed");
    // The lock is emptied (not removed) on spawn failure, leaving it reclaimable next run.
    assert.equal(readFileSync(buildLockPath(root), "utf8"), "", "lock emptied after spawn failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// (bg-6) Correct cmd, args, and opts passed to spawner
test("(bg-6) spawner receives correct cmd, args [...cliBase.args,'build',root], {detached,stdio}", () => {
  const root = makeTmpRoot();
  const absRoot = resolvePath(root);
  try {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let capturedOpts: Record<string, unknown> = {};
    const spawner: SpawnFn = (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = [...args];
      capturedOpts = opts as Record<string, unknown>;
      return { pid: 42, unref() {} };
    };

    const result = spawnDetachedBuild(root, { spawner, cliBase: FAKE_CLI_BASE });
    assert.equal(result, "spawned");
    assert.equal(capturedCmd, FAKE_CLI_BASE.command);
    assert.deepEqual(capturedArgs, [...FAKE_CLI_BASE.args, "build", absRoot]);
    assert.equal(capturedOpts.detached, true, "detached:true");
    assert.equal(capturedOpts.stdio, "ignore", "stdio:ignore");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// (bg-8) corrupt / non-JSON lock content → treated as stale → reclaimed → spawned
test("(bg-8) corrupt lock content → stale → reclaimed → spawned", () => {
  const root = makeTmpRoot();
  try {
    writeFileSync(buildLockPath(root), "}{ not json at all");
    let spawned = false;
    const spawner: SpawnFn = () => { spawned = true; return { pid: 4242, unref() {} }; };
    const result = spawnDetachedBuild(root, { spawner, cliBase: FAKE_CLI_BASE });
    assert.equal(result, "spawned", "corrupt lock is reclaimable");
    assert.equal(spawned, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// (bg-9) lock JSON missing required fields → treated as stale → reclaimed → spawned
test("(bg-9) lock JSON without pid/startedAt → stale → reclaimed → spawned", () => {
  const root = makeTmpRoot();
  try {
    writeFileSync(buildLockPath(root), JSON.stringify({ other: "field" }));
    let spawned = false;
    const spawner: SpawnFn = () => { spawned = true; return { pid: 99, unref() {} }; };
    const result = spawnDetachedBuild(root, { spawner, cliBase: FAKE_CLI_BASE });
    assert.equal(result, "spawned", "lock without pid/startedAt is reclaimable");
    assert.equal(spawned, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// (bg-7) .leina/ does not exist yet (the `init` case) → dir is created → spawned
test("(bg-7) missing .leina dir (init case) → lock dir created → spawned", () => {
  // A bare root WITHOUT the .leina subdir, exactly as `init` sees it before any build.
  const root = mkdtempSync(join(tmpdir(), "leina-bg-build-bare-"));
  try {
    assert.equal(existsSync(join(root, ".leina")), false, "precondition: .leina absent");
    let spawned = false;
    const spawner: SpawnFn = () => { spawned = true; return { pid: 12345, unref() {} }; };
    const result = spawnDetachedBuild(root, { spawner, cliBase: FAKE_CLI_BASE });
    assert.equal(result, "spawned", "must spawn even when .leina did not exist");
    assert.equal(spawned, true);
    assert.equal(existsSync(buildLockPath(root)), true, "lock (and its parent dir) created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// acquireForegroundBuildLock — foreground lock for `leina build`/`leina refresh`
// (REQ-D3a). Unlike spawnDetachedBuild's silent skip, this WAITS (bounded) for a
// live foreign holder instead of giving up immediately, and centralizes the
// self-ownership rule (fixing the spawnDetachedBuild child self-deadlock — see also
// agent-gate.test.ts (gate-autobuild-4) for the end-to-end regression).
// ---------------------------------------------------------------------------

// pid 1 stands in for "a live foreign process" in every test below: signalling it with
// process.kill(1, 0) reliably throws EPERM (never ESRCH) for a non-root test runner,
// which holderIsAlive() treats as "alive" — exactly like a real foreign build holder.

test("(fg-1) empty/absent lock → acquires immediately, never sleeps", () => {
  const root = makeTmpRoot();
  try {
    let slept = 0;
    const result = acquireForegroundBuildLock(root, { sleep: () => { slept++; } });
    assert.ok("fd" in result, "acquired");
    assert.equal(slept, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(fg-2) self-owned lock (lock.pid === process.pid) → reclaims immediately without waiting", () => {
  const root = makeTmpRoot();
  try {
    writeLock(buildLockPath(root), process.pid, Date.now());
    let slept = 0;
    const result = acquireForegroundBuildLock(root, { sleep: () => { slept++; } });
    assert.ok(
      "fd" in result,
      "self-pid reclaims without waiting — the fix for the spawnDetachedBuild child deadlock",
    );
    assert.equal(slept, 0, "must never sleep when it already owns the lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(fg-3) orphaned lock (dead pid, ESRCH) → reclaims immediately", () => {
  const root = makeTmpRoot();
  try {
    const deadPid = 9_999_995;
    let pidAlive = false;
    try { process.kill(deadPid, 0); pidAlive = true; } catch { /* expected */ }
    if (pidAlive) return; // happens to exist on this host — skip gracefully, like bg-2

    writeLock(buildLockPath(root), deadPid, Date.now());
    let slept = 0;
    const result = acquireForegroundBuildLock(root, { sleep: () => { slept++; } });
    assert.ok("fd" in result, "dead holder is reclaimable");
    assert.equal(slept, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(fg-4) TTL-expired lock (live pid, stale startedAt) → reclaims immediately", () => {
  const root = makeTmpRoot();
  try {
    const base = 1_000_000_000;
    writeLock(buildLockPath(root), 1, base); // pid 1: alive (EPERM), but stale by TTL
    const now = () => base + 16 * 60_000 + 1; // > 15min TTL
    let slept = 0;
    const result = acquireForegroundBuildLock(root, { now, sleep: () => { slept++; } });
    assert.ok("fd" in result, "TTL-expired holder is reclaimable even if technically alive");
    assert.equal(slept, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(fg-5) corrupt lock content → reclaims immediately (same reclaim rule as spawnDetachedBuild)", () => {
  const root = makeTmpRoot();
  try {
    writeFileSync(buildLockPath(root), "}{ not json at all");
    let slept = 0;
    const result = acquireForegroundBuildLock(root, { sleep: () => { slept++; } });
    assert.ok("fd" in result);
    assert.equal(slept, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(fg-6) live foreign holder releases mid-wait → polls, then acquires", () => {
  const root = makeTmpRoot();
  const lockPath = buildLockPath(root);
  try {
    writeLock(lockPath, 1, Date.now()); // pid 1 — alive foreign holder
    let sleeps = 0;
    const sleep = (): void => {
      sleeps++;
      if (sleeps === 2) {
        // Simulate the holder releasing the lock (its own finally{} rmSync running
        // concurrently, e.g. in another `leina build` process).
        rmSync(lockPath, { force: true });
      }
    };
    const result = acquireForegroundBuildLock(root, { waitMs: 5_000, sleep });
    assert.ok("fd" in result, "acquires once the foreign holder releases");
    assert.ok(sleeps >= 2, "polled at least twice before acquiring");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(fg-7) live foreign holder never releases → times out, reporting its pid/age", () => {
  const root = makeTmpRoot();
  try {
    const base = 1_000_000_000;
    writeLock(buildLockPath(root), 1, base);
    let virtualNow = base;
    const now = (): number => virtualNow;
    let sleeps = 0;
    const sleep = (ms: number): void => { sleeps++; virtualNow += ms; };
    const result = acquireForegroundBuildLock(root, { now, sleep, waitMs: 2_000 });
    assert.ok(typeof result === "object" && "timeout" in result && result.timeout === true, "gives up");
    if (typeof result === "object" && "timeout" in result) {
      assert.equal(result.holderPid, 1, "reports the live holder's pid for the CLI message");
      assert.equal(result.holderStartedAt, base, "reports startedAt so the CLI can compute age");
    }
    assert.ok(sleeps >= 1, "polled at least once before giving up");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(fg-8) waitMs=0 against a live foreign holder → fails fast, never sleeps", () => {
  const root = makeTmpRoot();
  try {
    writeLock(buildLockPath(root), 1, Date.now());
    let slept = 0;
    const result = acquireForegroundBuildLock(root, { waitMs: 0, sleep: () => { slept++; } });
    assert.ok(typeof result === "object" && "timeout" in result && result.timeout === true);
    assert.equal(slept, 0, "waitMs=0 is fail-fast — no polling at all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(fg-9) missing .leina dir (init case) → lock dir created, lock acquired", () => {
  const root = mkdtempSync(join(tmpdir(), "leina-fg-build-bare-"));
  try {
    assert.equal(existsSync(join(root, ".leina")), false, "precondition: .leina absent");
    const result = acquireForegroundBuildLock(root);
    assert.ok("fd" in result);
    assert.equal(existsSync(buildLockPath(root)), true, "lock (and its parent dir) created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
