// application/install/harness-init.ts — harness bootstrap inside `leina init`
// (both FULL and LIGHT flows) and its per-repo inverse for `leina deinit`.
//
// bootstrapHarness (async, best-effort, idempotent):
//   1. Seeds `.harness/config.json` with the minimal `{}` when absent — the
//      builtin rule suite (including the leina-* rules shipped enabled:true)
//      governs by default; the file exists so the repo is visibly harnessed
//      and so project overrides have a home.
//   2. Runs the harness sync in-process (the SAME runSync as
//      `leina harness sync`) to generate CLAUDE.md/AGENTS.md managed blocks +
//      skills for whichever platforms are detected.
//
// deinitHarness (sync — `leina deinit` and its TUI caller are synchronous):
//   Removes ONLY sync-generated artifacts, driven by the committed lockfile —
//   the same orphan semantics as the writer's cleanup (owned files deleted
//   when untouched, managed blocks stripped, json-merge left inert). The
//   user's `.harness/rules/` and `.harness/state/` are never touched; the
//   minimal `{}` config seeded by init is removed only while still pristine.

import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runSync } from "../harness/sync.ts";
import { HARNESS_DIR } from "../harness/config-io.ts";
import { lockfilePath, parseLockfile, type Lockfile, type LockfileArtifact } from "../harness/adapters/writer.ts";
import { removeManagedBlock, sha256 } from "../harness/adapters/managed-block.ts";

/** Content init seeds into .harness/config.json — builtin rules govern by default. */
export const HARNESS_MINIMAL_CONFIG = "{}\n";

/**
 * Host ids from `leina init --hosts` → harness platform adapters. The windsurf
 * adapter is the Devin/Windsurf pair (byte-identical rule mirror).
 */
const HOST_TO_PLATFORM: Record<string, string> = {
  claude: "claude-code",
  devin: "windsurf",
};

/**
 * The platforms the bootstrap may target: the hosts the user named on the init
 * command line, plus agentsmd only when the repo already carries an AGENTS.md.
 * Never inferred from anything else — the harness inherits init's stance that
 * leina does not choose an AI host for the user.
 */
function bootstrapPlatforms(project: string, hosts: readonly string[]): string[] {
  const platforms = hosts.map((h) => HOST_TO_PLATFORM[h]).filter((p): p is string => p !== undefined);
  if (existsSync(join(project, "AGENTS.md")) && !platforms.includes("agentsmd")) {
    platforms.push("agentsmd");
  }
  return platforms;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface HarnessBootstrapResult {
  written: string[];
  failures: string[];
}

/** Idempotent harness bootstrap for `leina init` (FULL and LIGHT). */
export async function bootstrapHarness(
  project: string,
  hosts: readonly string[] = [],
): Promise<HarnessBootstrapResult> {
  const written: string[] = [];
  const failures: string[] = [];
  const platforms = bootstrapPlatforms(project, hosts);

  const configPath = join(project, HARNESS_DIR, "config.json");
  let seededThisRun = false;
  try {
    if (!existsSync(configPath)) {
      mkdirSync(dirname(configPath), { recursive: true });
      const seed =
        platforms.length > 0 ? `${JSON.stringify({ platforms }, null, 2)}\n` : HARNESS_MINIMAL_CONFIG;
      writeFileSync(configPath, seed);
      seededThisRun = true;
      written.push(
        platforms.length > 0
          ? `.harness/config.json (created — platforms: ${platforms.join(", ")})`
          : ".harness/config.json (created — builtin rules govern by default)",
      );
    }
  } catch (err) {
    failures.push(`.harness/config.json: ${errMsg(err)}`);
  }

  try {
    // Explicit platforms when the user (re-)named hosts on this invocation; a
    // pre-existing config keeps its own platforms unless hosts were given.
    const explicit = platforms.length > 0 && (seededThisRun || hosts.length > 0);
    const result = await runSync(project, explicit ? { platforms } : {});
    for (const e of result.errors) failures.push(`harness sync: ${e}`);
    if (result.outcome) {
      const changed = result.outcome.items.filter((i) => i.action === "created" || i.action === "updated");
      for (const item of result.outcome.items) {
        if (item.action === "conflict" || item.action === "error") {
          failures.push(`harness sync: ${item.path} — ${item.detail ?? item.action}`);
        }
      }
      written.push(
        changed.length > 0
          ? `harness sync: ${changed.map((i) => i.path).join(", ")}`
          : "harness sync: artifacts up to date",
      );
    }
  } catch (err) {
    failures.push(`harness sync: ${errMsg(err)}`);
  }

  return { written, failures };
}

export interface HarnessDeinitResult {
  removed: string[];
  failures: string[];
}

/** True for the exact shapes bootstrapHarness seeds: `{}` or `{ "platforms": [...] }`. */
function isPristineBootstrapConfig(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return true;
    return keys.length === 1 && keys[0] === "platforms" && Array.isArray((parsed as { platforms: unknown }).platforms);
  } catch {
    return false;
  }
}

function readLockfileSync(project: string): Lockfile | undefined {
  try {
    const raw = readFileSync(lockfilePath(project), "utf8");
    return parseLockfile(JSON.parse(raw));
  } catch {
    return undefined; // absent or malformed — nothing to revert
  }
}

/** Best-effort: prune now-empty parent directories left by removed artifacts. */
function pruneEmptyParents(project: string, absolute: string): void {
  let dir = dirname(absolute);
  const root = join(project);
  while (dir !== root && dir.startsWith(root)) {
    try {
      rmdirSync(dir); // fails on non-empty — that's the stop condition
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

function removeArtifact(
  project: string,
  artifact: LockfileArtifact,
  removed: string[],
  failures: string[],
): void {
  const absolute = join(project, artifact.path);
  let existing: string;
  try {
    existing = readFileSync(absolute, "utf8");
  } catch {
    return; // already gone — idempotent no-op
  }
  try {
    if (artifact.kind === "owned") {
      if (sha256(existing) === artifact.contentHash) {
        rmSync(absolute);
        pruneEmptyParents(project, absolute);
        removed.push(`${artifact.path} (harness artifact)`);
      } else {
        failures.push(`${artifact.path}: harness artifact was hand-edited — left in place, delete manually`);
      }
      return;
    }
    if (artifact.kind === "managed-block") {
      const { content, removed: stripped } = removeManagedBlock(existing, artifact.blockId ?? "core");
      if (!stripped) return;
      if (content.trim() === "") {
        rmSync(absolute);
        removed.push(`${artifact.path} (file removed — contained only the harness block)`);
      } else {
        writeFileSync(absolute, content);
        removed.push(`${artifact.path} (harness block removed)`);
      }
    }
    // json-merge artifacts: the next merge strips stale entries and stale
    // `leina harness hook` wiring is inert once nothing answers it (same
    // policy as the sync writer's orphan cleanup).
  } catch (err) {
    failures.push(`${artifact.path}: ${errMsg(err)}`);
  }
}

/** Per-repo inverse of bootstrapHarness — synchronous by design (deinit is sync). */
export function deinitHarness(project: string): HarnessDeinitResult {
  const removed: string[] = [];
  const failures: string[] = [];

  const lock = readLockfileSync(project);
  if (lock) {
    for (const artifact of lock.artifacts) removeArtifact(project, artifact, removed, failures);
    try {
      rmSync(lockfilePath(project));
      removed.push(".harness/harness.lock.json");
    } catch (err) {
      failures.push(`.harness/harness.lock.json: ${errMsg(err)}`);
    }
  }

  // The config seeded by init is ours to remove — but only while pristine
  // (empty, or platforms-only as bootstrapHarness writes it); once the user
  // configured anything else, the file is theirs.
  const configPath = join(project, HARNESS_DIR, "config.json");
  try {
    if (existsSync(configPath) && isPristineBootstrapConfig(readFileSync(configPath, "utf8"))) {
      rmSync(configPath);
      removed.push(".harness/config.json (pristine bootstrap — removed)");
    }
  } catch (err) {
    failures.push(`.harness/config.json: ${errMsg(err)}`);
  }

  // Drop .harness/ only when now empty — user rules/state keep it alive.
  try {
    rmdirSync(join(project, HARNESS_DIR));
  } catch {
    /* non-empty or absent — keep */
  }

  return { removed, failures };
}
