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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface HarnessBootstrapResult {
  written: string[];
  failures: string[];
}

/** Idempotent harness bootstrap for `leina init` (FULL and LIGHT). */
export async function bootstrapHarness(project: string): Promise<HarnessBootstrapResult> {
  const written: string[] = [];
  const failures: string[] = [];

  const configPath = join(project, HARNESS_DIR, "config.json");
  try {
    if (!existsSync(configPath)) {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, HARNESS_MINIMAL_CONFIG);
      written.push(".harness/config.json (created — builtin rules govern by default)");
    }
  } catch (err) {
    failures.push(`.harness/config.json: ${errMsg(err)}`);
  }

  try {
    const result = await runSync(project, {});
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

  // The minimal `{}` config seeded by init is ours to remove — but only while
  // pristine; once the user configured anything, the file is theirs.
  const configPath = join(project, HARNESS_DIR, "config.json");
  try {
    if (existsSync(configPath) && readFileSync(configPath, "utf8").trim() === "{}") {
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
