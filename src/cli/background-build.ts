// cli/background-build.ts — fire-and-forget detached graph build helper.
// Serialized via a best-effort lock file; fail-open on every error path.

import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { deriveCliCommand } from "../application/install/command.ts";
import type { McpCommand } from "../application/install/protocol.ts";

export type SpawnFn = (cmd: string, args: string[], opts: object) => { pid?: number; unref(): void };
export type BackgroundBuildOutcome = "spawned" | "skipped-lock-active" | "failed";

export interface SpawnDetachedOpts {
  cliBase?: McpCommand;
  spawner?: SpawnFn;
  now?: () => number;
}

const STALE_TTL_MS = 15 * 60_000;

export function buildLockPath(root: string): string {
  return join(resolvePath(root), ".leina", "graph.build.lock");
}

function defaultSpawner(cmd: string, args: string[], opts: object): { pid?: number; unref(): void } {
  return spawn(cmd, args, opts as Parameters<typeof spawn>[2]);
}

function parseLock(raw: string): { pid: number; startedAt: number } | null {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      obj !== null &&
      typeof obj === "object" &&
      typeof (obj as Record<string, unknown>).pid === "number" &&
      typeof (obj as Record<string, unknown>).startedAt === "number"
    ) {
      return obj as { pid: number; startedAt: number };
    }
  } catch {
    /* corrupt / unreadable — treat as not-held */
  }
  return null;
}

// True only when a *live* build currently holds the lock. Corrupt content, an expired TTL, or a
// dead PID all mean "not held" (reclaimable). Operates purely on already-read data — no I/O.
function holderIsAlive(data: { pid: number; startedAt: number } | null, now: () => number): boolean {
  if (!data) return false;
  if (now() - data.startedAt > STALE_TTL_MS) return false;
  try {
    process.kill(data.pid, 0);
    return true; // process is alive
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM → alive; ESRCH → dead
  }
}

/**
 * Acquire the build lock and return an open fd, or null if a live build already holds it.
 *
 * The lock path is touched EXACTLY ONCE — a single `openSync(…, "a+")` that creates the file if
 * absent and opens it otherwise. Inspection (fstat/read), reclaim (ftruncate) and the eventual
 * write all happen through that one fd, so there is no second path resolution to race against
 * (avoids the TOCTOU pattern CWE-367 / js/file-system-race). The trade-off is a weaker mutual
 * exclusion than O_EXCL: two simultaneous callers could both build, which is harmless for an
 * idempotent best-effort background build.
 */
function acquireLock(lockPath: string, now: () => number): number | null {
  const fd = openSync(lockPath, "a+"); // create-if-absent, read+write, never truncates
  if (fstatSync(fd).size > 0) {
    if (holderIsAlive(parseLock(readFileSync(fd, "utf8")), now)) {
      closeSync(fd);
      return null; // a live build owns it
    }
    ftruncateSync(fd, 0); // stale/corrupt → reclaim the same fd in place
  }
  return fd;
}

const DEFAULT_WAIT_MS = 120_000; // 2min — well under STALE_TTL_MS (15min)
const POLL_INTERVAL_MS = 500;

export interface AcquireForegroundLockOpts {
  /** Max time to wait for a live, foreign holder to release the lock. Defaults to
   *  `LEINA_BUILD_LOCK_WAIT_MS` env var or 120000ms. `0` → fail-fast immediately. */
  waitMs?: number;
  now?: () => number;
  /** Injectable sleep for tests — defaults to a real blocking wait via Atomics. */
  sleep?: (ms: number) => void;
}

// `{ fd }` on success: the fd is already closed by the time it's returned (the lock file
// has been written and the fd used to write it, matching the write-then-close pattern in
// spawnDetachedBuild). It is surfaced only as a truthy "acquired" marker for callers /
// tests — release always goes through `rmSync(lockPath)`, never through this fd.
//
// On timeout, the holder's pid/startedAt are surfaced (not just the string "timeout") so
// the CLI can print an actionable message ("another build is running (pid N, started
// <age>)") without re-reading and re-parsing the lock file itself.
export type AcquireForegroundLockResult =
  | { fd: number }
  | { timeout: true; holderPid: number; holderStartedAt: number };

function defaultSleep(ms: number): void {
  // Synchronous blocking sleep — handlers here (handleBuild/handleRefresh) are not
  // inside an event loop turn that needs to stay responsive; a real await-based sleep
  // would require making every caller async-friendly for no benefit.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * Acquire the build lock for a FOREGROUND build (`leina build` / `leina refresh`),
 * waiting for a live foreign holder rather than silently skipping like
 * `spawnDetachedBuild` does for background self-heals.
 *
 * Centralizes the self-ownership rule here (single source of truth) so it applies
 * identically to the child process spawned by `spawnDetachedBuild`: the parent
 * pre-writes the CHILD's pid into the lock before the child's own `leina build`
 * re-enters this function. If `lock.pid === process.pid`, the caller already owns the
 * lock (case: I *am* that child) — reclaim it immediately without waiting. Without this
 * centralized check, the detached child would wait on itself forever (deadlock).
 *
 * Resolution order for a non-empty lock:
 *   1. self-owned (`lock.pid === process.pid`) → reclaim immediately, no wait
 *   2. stale (dead holder / TTL expired / corrupt) → reclaim immediately
 *   3. live foreign holder → poll every 500ms until it releases or `waitMs` elapses
 *      → on timeout, return `"timeout"` (caller fails fast with an actionable message)
 */
export function acquireForegroundBuildLock(
  root: string,
  opts?: AcquireForegroundLockOpts,
): AcquireForegroundLockResult {
  const now = opts?.now ?? (() => Date.now());
  const sleep = opts?.sleep ?? defaultSleep;
  const waitMs = opts?.waitMs ?? envWaitMs();
  const lockPath = buildLockPath(root);

  mkdirSync(dirname(lockPath), { recursive: true });

  const deadline = now() + waitMs;
  for (;;) {
    const fd = openSync(lockPath, "a+");
    const size = fstatSync(fd).size;
    if (size === 0) {
      writeSelfLock(fd, now());
      return { fd };
    }
    const lock = parseLock(readFileSync(fd, "utf8"));
    if (lock !== null && lock.pid === process.pid) {
      // Self-ownership: I already hold this lock (e.g. the detached child spawned by
      // spawnDetachedBuild, whose pid the parent pre-wrote). Reclaim without waiting —
      // waiting here would deadlock forever.
      writeSelfLock(fd, now());
      return { fd };
    }
    if (!holderIsAlive(lock, now)) {
      // Absent/corrupt/stale/dead holder → reclaim.
      ftruncateSync(fd, 0);
      writeSelfLock(fd, now());
      return { fd };
    }
    closeSync(fd);
    // lock is non-null here: holderIsAlive(null, now) always returns false, which would
    // have already returned via the reclaim branch above.
    if (now() >= deadline) {
      return { timeout: true, holderPid: lock!.pid, holderStartedAt: lock!.startedAt };
    }
    sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())));
  }
}

function writeSelfLock(fd: number, startedAt: number): void {
  const content = JSON.stringify({ pid: process.pid, startedAt });
  writeSync(fd, content, 0);
  closeSync(fd);
}

function envWaitMs(): number {
  const raw = process.env.LEINA_BUILD_LOCK_WAIT_MS;
  if (!raw) return DEFAULT_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_MS;
}

export function spawnDetachedBuild(root: string, opts?: SpawnDetachedOpts): BackgroundBuildOutcome {
  // Kill-switch suppresses only REAL (default-spawner) builds: in-process tests that drive the
  // self-heal path, and CI. A caller that injects a fake spawner bypasses it — no real process is
  // created, so the lock/spawn mechanics can still be unit-tested with the switch set globally.
  if (!opts?.spawner && process.env.LEINA_DISABLE_AUTOBUILD === "1") return "skipped-lock-active";

  const spawner = opts?.spawner ?? defaultSpawner;
  const now = opts?.now ?? (() => Date.now());
  const lockPath = buildLockPath(root);

  try {
    // The lock lives in .leina/, which may not exist yet at `init` time (the dir is
    // normally created by the build itself). Ensure it exists before reserving the lock.
    mkdirSync(dirname(lockPath), { recursive: true });

    const fd = acquireLock(lockPath, now);
    if (fd === null) return "skipped-lock-active";

    const cliBase = opts?.cliBase ?? deriveCliCommand({
      cliEntry: resolvePath(process.argv[1] ?? "."),
      execPath: process.execPath,
    });
    const args = [...cliBase.args, "build", resolvePath(root)];

    let child: { pid?: number; unref(): void };
    try {
      child = spawner(cliBase.command, args, { detached: true, stdio: "ignore" });
    } catch {
      try { ftruncateSync(fd, 0); } catch { /* ignore */ } // empty → reclaimable next run
      closeSync(fd);
      return "failed";
    }

    const lockContent = JSON.stringify({ pid: child.pid ?? 0, startedAt: now() });
    try { writeSync(fd, lockContent, 0); } catch { /* non-fatal */ }
    closeSync(fd);
    child.unref();
    return "spawned";
  } catch {
    return "failed";
  }
}
