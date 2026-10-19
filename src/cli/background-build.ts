// cli/background-build.ts — the cross-process graph build lock, and the fire-and-forget
// detached build (SessionStart self-heal) that uses it.
//
// One lock file per project, `<root>/.leina/graph.build.lock`, holding `{pid, startedAt}`,
// serializes EVERY graph build of that root across processes: an explicit `leina build` /
// `leina refresh` (acquireForegroundBuildLock — waits, synchronously), a read path's stale
// auto-rebuild and the MCP server's builds (acquireBuildLock — waits without blocking the
// event loop) and the detached self-heal (spawnDetachedBuild — never waits, skips).
//
// Acquisition is an O_EXCL create, so two processes can never both create it. A holder that
// is dead (ESRCH), older than the 15-minute TTL, or left unparseable content is reclaimed by
// renaming the file aside and re-creating it; the rename is verified against what was judged
// stale, so a racing reclaimer cannot silently take over a lock that was just re-created.
// A lock that is still EMPTY (its creator is between create and write) is treated as held for
// a short grace period. Release only removes a lock this process still owns.

import {
  closeSync,
  constants as fsConstants,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
/** An empty lock younger than this is a creator between its O_EXCL create and its write. */
const EMPTY_LOCK_GRACE_MS = 5_000;
const DEFAULT_WAIT_MS = 120_000; // 2min — well under STALE_TTL_MS (15min)
const POLL_INTERVAL_MS = 500;
/** Immediate re-attempts when the lock vanishes or is reclaimed between our own steps. */
const MAX_IMMEDIATE_RETRIES = 8;

const CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
const WIN_BUSY_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

export function buildLockPath(root: string): string {
  return join(resolvePath(root), ".leina", "graph.build.lock");
}

function defaultSpawner(cmd: string, args: string[], opts: object): { pid?: number; unref(): void } {
  return spawn(cmd, args, opts as Parameters<typeof spawn>[2]);
}

interface LockHolder {
  pid: number;
  startedAt: number;
}

function parseLock(raw: string): LockHolder | null {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      obj !== null &&
      typeof obj === "object" &&
      typeof (obj as Record<string, unknown>).pid === "number" &&
      typeof (obj as Record<string, unknown>).startedAt === "number"
    ) {
      return obj as LockHolder;
    }
  } catch {
    /* corrupt / unreadable — treat as not-held */
  }
  return null;
}

// True only when a *live* build currently holds the lock. An expired TTL or a dead PID mean
// "not held" (reclaimable). Operates purely on already-read data — no I/O on the lock.
function holderIsAlive(data: LockHolder, now: () => number): boolean {
  if (now() - data.startedAt > STALE_TTL_MS) return false;
  try {
    process.kill(data.pid, 0);
    return true; // process is alive
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM → alive; ESRCH → dead
  }
}

function lockContent(pid: number, startedAt: number): string {
  return JSON.stringify({ pid, startedAt });
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** O_EXCL-create the lock holding `content`; false when it already exists. */
function createExclusive(lockPath: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, CREATE_FLAGS);
  } catch (err) {
    if (errCode(err) === "EEXIST") return false;
    // Windows refuses to create a file another process is renaming or deleting (a reclaim or
    // release in flight) with EPERM/EACCES/EBUSY instead of EEXIST: also "held", retried.
    if (process.platform === "win32" && WIN_BUSY_CODES.has(errCode(err) ?? "")) return false;
    throw err;
  }
  try {
    writeSync(fd, content, 0);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Overwrite a lock this process already holds (or is entitled to, see self-ownership). */
function overwriteLock(lockPath: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, fsConstants.O_RDWR);
  } catch {
    return false; // vanished meanwhile — the caller retries the create
  }
  try {
    ftruncateSync(fd, 0); // never leave a tail of the previous content
    writeSync(fd, content, 0);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Move a lock judged stale (content `staleRaw`) out of the way. The rename is atomic; the
 * renamed file is then compared with what was judged stale. If another process re-created
 * the lock in between (we renamed THEIR fresh lock), it is linked back — never silently
 * taken over. Every outcome ends with the caller retrying the exclusive create.
 */
function reclaimStale(lockPath: string, staleRaw: string): void {
  const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return; // already reclaimed / released by someone else
  }
  try {
    if (readFileSync(aside, "utf8") !== staleRaw) linkSync(aside, lockPath);
  } catch {
    /* restore lost the race to a newer create — that holder wins */
  } finally {
    try { unlinkSync(aside); } catch { /* best-effort */ }
  }
}

type AttemptResult = { acquired: true } | { acquired: false; holder: LockHolder };

/** What is in the lock right now: its content and age, or null when it no longer exists. */
function readLock(lockPath: string): { raw: string; mtimeMs: number } | null {
  try {
    return { raw: readFileSync(lockPath, "utf8"), mtimeMs: statSync(lockPath).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * One non-blocking acquisition attempt. `selfOwned` lets a lock naming THIS process count as
 * ours (the detached child whose pid its parent pre-wrote); a live foreign holder (or an empty
 * lock still in its grace period) is returned as `holder`.
 */
function attemptAcquire(lockPath: string, now: () => number, selfOwned: boolean): AttemptResult {
  const content = lockContent(process.pid, now());
  for (let i = 0; i < MAX_IMMEDIATE_RETRIES; i++) {
    if (createExclusive(lockPath, content)) return { acquired: true };
    const current = readLock(lockPath);
    if (current === null) continue; // released between create and read
    if (current.raw === "" && Date.now() - current.mtimeMs < EMPTY_LOCK_GRACE_MS) {
      return { acquired: false, holder: { pid: 0, startedAt: current.mtimeMs } };
    }
    const holder = parseLock(current.raw);
    if (holder !== null && selfOwned && holder.pid === process.pid) {
      if (overwriteLock(lockPath, content)) return { acquired: true };
      continue;
    }
    if (holder !== null && holderIsAlive(holder, now)) return { acquired: false, holder };
    reclaimStale(lockPath, current.raw); // dead / expired / corrupt / abandoned-empty
  }
  // Pathological churn (many processes reclaiming at once): report "held" so the caller waits.
  return { acquired: false, holder: { pid: 0, startedAt: now() } };
}

/**
 * Remove the lock if THIS process still holds it. A lock reclaimed by someone else after our
 * TTL ran out is theirs now and is left alone. Best-effort; never throws.
 */
export function releaseBuildLock(root: string): void {
  const lockPath = buildLockPath(root);
  try {
    if (parseLock(readFileSync(lockPath, "utf8"))?.pid === process.pid) unlinkSync(lockPath);
  } catch {
    /* already gone, or unreadable — nothing of ours to release */
  }
}

/** The actionable message for a wait that timed out (shared by the CLI and the read path). */
export function lockTimeoutMessage(root: string, holderPid: number, holderStartedAt: number): string {
  const ageS = Math.max(0, Math.round((Date.now() - holderStartedAt) / 1000));
  const who = holderPid > 0 ? `pid ${holderPid}` : "pid unknown";
  return (
    `another build is running (${who}, started ${ageS}s ago) — ` +
    `wait for it to finish, retry, or delete ${buildLockPath(root)} if it is stuck.`
  );
}

export interface AcquireForegroundLockOpts {
  /** Max time to wait for a live, foreign holder to release the lock. Defaults to
   *  `LEINA_BUILD_LOCK_WAIT_MS` env var or 120000ms. `0` → fail-fast immediately. */
  waitMs?: number;
  now?: () => number;
  /** Injectable sleep for tests — defaults to a real blocking wait via Atomics. */
  sleep?: (ms: number) => void;
}

// `{ fd }` on success is only a truthy "acquired" marker kept for callers/tests (the lock has
// been written and its descriptor closed); release goes through releaseBuildLock(root).
//
// On timeout, the holder's pid/startedAt are surfaced so the CLI can print an actionable
// message ("another build is running (pid N, started <age>)") without re-reading the lock.
export type AcquireForegroundLockResult =
  | { fd: number }
  | { timeout: true; holderPid: number; holderStartedAt: number };

function defaultSleep(ms: number): void {
  // Synchronous blocking sleep — handlers here (handleBuild/handleRefresh) are not
  // inside an event loop turn that needs to stay responsive.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * Acquire the build lock for a FOREGROUND build (`leina build` / `leina refresh`),
 * waiting for a live foreign holder rather than silently skipping like
 * `spawnDetachedBuild` does for background self-heals.
 *
 * Self-ownership: the parent of a detached self-heal pre-writes the CHILD's pid into the
 * lock before the child's own `leina build` re-enters this function. A lock naming this
 * process is therefore already ours — taken over immediately; waiting would deadlock.
 *
 * Resolution order for an existing lock: self-owned → take over; stale (dead holder / TTL
 * expired / corrupt / abandoned empty) → reclaim; live foreign holder → poll every 500ms
 * until it releases or `waitMs` elapses, then return a timeout naming the holder.
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
    const attempt = attemptAcquire(lockPath, now, true);
    if (attempt.acquired) return { fd: 1 };
    if (now() >= deadline) {
      return { timeout: true, holderPid: attempt.holder.pid, holderStartedAt: attempt.holder.startedAt };
    }
    sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())));
  }
}

export interface AcquireBuildLockOpts {
  /** As for acquireForegroundBuildLock (env `LEINA_BUILD_LOCK_WAIT_MS`, default 120000ms). */
  waitMs?: number;
  /** Called once, when the first attempt finds a live foreign holder (before waiting). */
  onWait?: (holder: { pid: number; startedAt: number }) => void;
  /** Injectable async sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type AcquireBuildLockResult =
  | { acquired: true; waited: boolean }
  | { timeout: true; holderPid: number; holderStartedAt: number };

/**
 * Event-loop-friendly acquisition for builds nobody ran explicitly — the read path's stale
 * auto-rebuild and the MCP server — which must not freeze a long-lived process while another
 * one builds. `waited: true` means another process held the lock first: it has most likely
 * just rebuilt the graph, so the caller should re-check staleness before building again.
 */
export async function acquireBuildLock(root: string, opts: AcquireBuildLockOpts = {}): Promise<AcquireBuildLockResult> {
  const now = (): number => Date.now();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = opts.waitMs ?? envWaitMs();
  const lockPath = buildLockPath(root);
  mkdirSync(dirname(lockPath), { recursive: true });

  const deadline = now() + waitMs;
  let waited = false;
  for (;;) {
    const attempt = attemptAcquire(lockPath, now, true);
    if (attempt.acquired) return { acquired: true, waited };
    if (now() >= deadline) {
      return { timeout: true, holderPid: attempt.holder.pid, holderStartedAt: attempt.holder.startedAt };
    }
    if (!waited) opts.onWait?.(attempt.holder);
    waited = true;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())));
  }
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

    // Never waits, and never treats a lock naming this process as its own: a hook process
    // finding any live build (even one it started) simply skips.
    if (!attemptAcquire(lockPath, now, false).acquired) return "skipped-lock-active";

    const cliBase = opts?.cliBase ?? deriveCliCommand({
      cliEntry: resolvePath(process.argv[1] ?? "."),
      execPath: process.execPath,
    });
    const args = [...cliBase.args, "build", resolvePath(root)];

    let child: { pid?: number; unref(): void };
    try {
      // cwd: the project, not the hook's directory, which a running child would pin (Windows
      // cannot delete a live process's cwd); windowsHide: no console window per session start.
      child = spawner(cliBase.command, args, { detached: true, stdio: "ignore", cwd: resolvePath(root), windowsHide: true });
    } catch {
      releaseBuildLock(root); // nothing will build — free the lock for the next run
      return "failed";
    }

    // Hand the lock to the child: its own `leina build` finds its pid there and takes over.
    overwriteLock(lockPath, lockContent(child.pid ?? 0, now()));
    child.unref();
    return "spawned";
  } catch {
    return "failed";
  }
}
