// application/install/harness-init.ts — harness bootstrap inside `leina init`
// (both FULL and LIGHT flows) and its per-repo inverse for `leina deinit`.
//
// bootstrapHarness (async, best-effort, idempotent):
//   1. Seeds `.harness/config.json` with the minimal `{}` when absent — the
//      builtin rule suite (including the leina-* rules shipped enabled:true)
//      governs by default; the file exists so the repo is visibly harnessed
//      and so project overrides have a home.
//      With --hosts it pins `platforms` — starting from what auto-detection
//      and the lockfile already govern, so pinning never drops a platform.
//   2. Runs the harness sync in-process (the SAME runSync as
//      `leina harness sync`) to generate CLAUDE.md/AGENTS.md managed blocks +
//      skills for whichever platforms are detected; orphans it deletes are
//      reported as removed.
//
// deinitHarness (sync — `leina deinit` and its TUI caller are synchronous):
//   Removes ONLY sync-generated artifacts, driven by the committed lockfile —
//   the same orphan semantics as the writer's cleanup (owned files deleted
//   when untouched, managed blocks stripped when their interior is untouched,
//   json-merge harness entries stripped so nothing dangles at deleted files).
//   The user's `.harness/rules/` and `.harness/state/` are never touched; the
//   config seeded by init is removed only while still pristine.

import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runSync } from "../harness/sync.ts";
import { presetRuleOverrides, type RulePreset } from "../harness/recipes.ts";
import { HARNESS_DIR } from "../harness/config-io.ts";
import {
  containedArtifactPath,
  LOCKFILE_REL,
  OUTSIDE_REPO_DETAIL,
  parseLockfile,
  type Lockfile,
  type LockfileArtifact,
} from "../harness/adapters/writer.ts";
import { blockHandEdited, removeManagedBlock, sha256 } from "../harness/adapters/managed-block.ts";
import { stripHarnessJsonEntries } from "../harness/adapters/json-merge.ts";
import { adapterById, detectAdapters } from "../harness/adapters/registry.ts";

/** Content init seeds into .harness/config.json — builtin rules govern by default. */
export const HARNESS_MINIMAL_CONFIG = "{}\n";

const CONFIG_REL = `${HARNESS_DIR}/config.json`;

/**
 * Host ids from `leina init --hosts` → harness platform adapters. The windsurf
 * adapter is the Devin/Windsurf pair (byte-identical rule mirror).
 */
const HOST_TO_PLATFORM: Record<string, string> = {
  claude: "claude-code",
  devin: "windsurf",
};

/**
 * The platforms the bootstrap adds: the hosts the user named on the init
 * command line, plus agentsmd only when the repo already carries an AGENTS.md.
 * Never inferred from anything else — the harness inherits init's stance that
 * leina does not choose an AI host for the user (platforms already governed by
 * evidence-based auto-detection are kept, see autoSelectedPlatforms). A host
 * with no harness adapter is reported, never silently dropped.
 */
function bootstrapPlatforms(
  project: string,
  hosts: readonly string[],
  warnings: string[],
): string[] {
  const platforms: string[] = [];
  for (const host of hosts) {
    const platform = HOST_TO_PLATFORM[host];
    if (platform !== undefined) platforms.push(platform);
    else warnings.push(`host "${host}" has no harness platform adapter — harness artifacts skipped for it`);
  }
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
  /** Orphaned artifacts the bootstrap sync deleted or stripped — never reported as written. */
  removed: string[];
  failures: string[];
}

/**
 * The platforms a config WITHOUT `platforms` currently governs: auto-detection
 * plus whatever the lockfile says was synced. Pinning an explicit list must
 * start from these, or the first sync after `init --hosts` would orphan-delete
 * every auto-detected platform's artifacts (and strand their hook wiring).
 * Only registered adapter ids survive (an origin lockfile may name others).
 */
async function autoSelectedPlatforms(project: string): Promise<string[]> {
  const lockPath = containedArtifactPath(project, LOCKFILE_REL);
  const lock = lockPath !== undefined ? readLockfileSync(lockPath) : undefined;
  const fromLock = (lock?.artifacts ?? []).map((a) => a.adapter).filter((id) => adapterById(id) !== undefined);
  const detected = (await detectAdapters({ repoRoot: project })).map((a) => a.id);
  return [...new Set([...fromLock, ...detected])];
}

function unionPlatforms(...lists: (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}

/**
 * Persist the chosen platforms INTO the config (create or union-merge) so the
 * config stays the single source of truth: running sync with explicit
 * platforms that the config does not record would make the very next plain
 * `harness sync` tear those artifacts back out as orphans (init/sync
 * ping-pong). Union, never replacement — the user's own platform list is
 * intent we extend, not state we own; and a config with no list yet (auto-
 * detection) is pinned to hosts ∪ `inherited` (what auto-detection governs
 * today), never to the hosts alone. Returns false when the config exists but
 * could not be honored (malformed / not an object): nothing is written.
 */
function persistPlatforms(
  configPath: string | undefined,
  platforms: readonly string[],
  inherited: readonly string[],
  preset: RulePreset | undefined,
  ruleOverrides: Record<string, { enabled: false }>,
  written: string[],
  failures: string[],
): boolean {
  const overrideCount = Object.keys(ruleOverrides).length;
  if (configPath === undefined) {
    failures.push(`${CONFIG_REL}: ${OUTSIDE_REPO_DETAIL}`);
    return false;
  }
  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    // Fresh seed only: platforms and/or a preset's rule overrides. `generic`
    // disables the leina-coupled builtin rules; `leina-native` (and no preset)
    // leaves the pristine `{}` so the full suite governs.
    const seedPlatforms = platforms.length > 0 ? unionPlatforms(platforms, inherited) : [];
    const seedObj: Record<string, unknown> = {};
    if (seedPlatforms.length > 0) seedObj.platforms = seedPlatforms;
    if (overrideCount > 0) seedObj.rules = ruleOverrides;
    const seed =
      Object.keys(seedObj).length > 0 ? `${JSON.stringify(seedObj, null, 2)}\n` : HARNESS_MINIMAL_CONFIG;
    writeFileSync(configPath, seed);
    const parts: string[] = [];
    if (seedPlatforms.length > 0) parts.push(`platforms: ${seedPlatforms.join(", ")}`);
    if (overrideCount > 0) parts.push(`preset ${preset} disables ${overrideCount} leina-* rule(s)`);
    written.push(
      parts.length > 0
        ? `.harness/config.json (created — ${parts.join("; ")})`
        : ".harness/config.json (created — builtin rules govern by default)",
    );
    return true;
  }
  // Config already exists: the preset is an init-time seed choice, so it is not
  // retro-applied here (that would clobber a user's own rule overrides).
  if (preset !== undefined && overrideCount > 0) {
    written.push(
      `harness: --harness-preset ${preset} ignored — .harness/config.json already exists (its rules govern)`,
    );
  }
  if (platforms.length === 0) return true; // nothing to merge — existing config governs

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    failures.push(`.harness/config.json: invalid JSON — platforms not merged (${errMsg(err)})`);
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    failures.push(".harness/config.json: not a JSON object — platforms not merged");
    return false;
  }
  const config = parsed as Record<string, unknown>;
  const existing = Array.isArray(config.platforms)
    ? (config.platforms as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  const merged =
    existing.length > 0 ? unionPlatforms(existing, platforms) : unionPlatforms(platforms, inherited);
  if (merged.length === existing.length) return true; // already recorded
  config.platforms = merged;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  written.push(`.harness/config.json (platforms merged: ${merged.join(", ")})`);
  return true;
}

/** Idempotent harness bootstrap for `leina init` (FULL and LIGHT). */
export async function bootstrapHarness(
  project: string,
  hosts: readonly string[] = [],
  opts: { preset?: RulePreset } = {},
): Promise<HarnessBootstrapResult> {
  const written: string[] = [];
  const removed: string[] = [];
  const failures: string[] = [];
  const platforms = bootstrapPlatforms(project, hosts, failures);

  // `generic` seeds rule overrides that disable the leina-coupled builtin rules;
  // `leina-native` (and the default: no preset) seeds none, so the full suite governs.
  const ruleOverrides = opts.preset ? await presetRuleOverrides(opts.preset) : {};

  const configPath = containedArtifactPath(project, CONFIG_REL);
  try {
    const inherited = platforms.length > 0 ? await autoSelectedPlatforms(project) : [];
    persistPlatforms(configPath, platforms, inherited, opts.preset, ruleOverrides, written, failures);
  } catch (err) {
    failures.push(`.harness/config.json: ${errMsg(err)}`);
  }

  try {
    // The config (just seeded or merged) is the single source of truth — the
    // sync never receives explicit platforms here, so what init writes and
    // what the next `harness sync` maintains cannot diverge.
    const result = await runSync(project, {});
    for (const e of result.errors) failures.push(`harness sync: ${e}`);
    if (result.outcome) {
      const changed = result.outcome.items.filter((i) => i.action === "created" || i.action === "updated");
      const orphans = result.outcome.items.filter((i) => i.action === "removed");
      for (const item of result.outcome.items) {
        if (item.action === "conflict" || item.action === "error") {
          failures.push(`harness sync: ${item.path} — ${item.detail ?? item.action}`);
        }
      }
      for (const item of orphans) removed.push(`${item.path} (harness sync: ${item.detail ?? "orphaned"})`);
      if (changed.length > 0) written.push(`harness sync: ${changed.map((i) => i.path).join(", ")}`);
      else if (orphans.length === 0) written.push("harness sync: artifacts up to date");
    }
  } catch (err) {
    failures.push(`harness sync: ${errMsg(err)}`);
  }

  return { written, removed, failures };
}

export interface HarnessDeinitResult {
  removed: string[];
  failures: string[];
}

/**
 * True only for the empty `{}` seed. A config carrying `platforms` encodes the
 * user's host choice (possibly hand-curated since) — deinit must never guess
 * that a non-empty config is disposable, so anything beyond `{}` stays.
 */
function isPristineBootstrapConfig(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 0
    );
  } catch {
    return false;
  }
}

function readLockfileSync(lockPath: string): Lockfile | undefined {
  try {
    const raw = readFileSync(lockPath, "utf8");
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
  const absolute = containedArtifactPath(project, artifact.path);
  if (absolute === undefined) {
    failures.push(`${artifact.path}: ${OUTSIDE_REPO_DETAIL} — left untouched`);
    return;
  }
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
      const blockId = artifact.blockId ?? "core";
      if (blockHandEdited(existing, blockId)) {
        failures.push(`${artifact.path}: harness block was hand-edited inside — left in place, remove manually`);
        return;
      }
      const { content, removed: stripped } = removeManagedBlock(existing, blockId);
      if (!stripped) return;
      if (content.trim() === "") {
        rmSync(absolute);
        removed.push(`${artifact.path} (file removed — contained only the harness block)`);
      } else {
        writeFileSync(absolute, content);
        removed.push(`${artifact.path} (harness block removed)`);
      }
      return;
    }
    if (artifact.kind === "json-merge") {
      // After deinit there is no "next merge" to strip stale entries, so the
      // harness-managed ones (hook wiring, instruction paths that now point at
      // deleted files) are stripped here; user entries stay verbatim.
      stripJsonMergeArtifact(project, absolute, artifact, existing, removed, failures);
    }
  } catch (err) {
    failures.push(`${artifact.path}: ${errMsg(err)}`);
  }
}

function stripJsonMergeArtifact(
  project: string,
  absolute: string,
  artifact: LockfileArtifact,
  existing: string,
  removed: string[],
  failures: string[],
): void {
  // Same strip the sync's orphan cleanup applies (strategy chosen by adapter).
  const result = stripHarnessJsonEntries(artifact.adapter, existing);
  if (result === undefined) return; // unknown strategy — leave the file alone
  if (result.error !== undefined) {
    failures.push(`${artifact.path}: ${result.error} — harness entries left in place`);
    return;
  }
  if (!result.changed) return;
  if (result.removeFile) {
    rmSync(absolute);
    pruneEmptyParents(project, absolute);
    removed.push(`${artifact.path} (file removed — held only harness entries)`);
  } else {
    writeFileSync(absolute, result.content);
    removed.push(`${artifact.path} (harness entries removed)`);
  }
}

/** Per-repo inverse of bootstrapHarness — synchronous by design (deinit is sync). */
export function deinitHarness(project: string): HarnessDeinitResult {
  const removed: string[] = [];
  const failures: string[] = [];

  // A .harness/ that resolves outside the repo (symlink) is never read,
  // written or pruned through — every path below is contained first.
  const lockPath = containedArtifactPath(project, LOCKFILE_REL);
  const lock = lockPath !== undefined ? readLockfileSync(lockPath) : undefined;
  if (lockPath !== undefined && lock) {
    for (const artifact of lock.artifacts) removeArtifact(project, artifact, removed, failures);
    try {
      rmSync(lockPath);
      removed.push(LOCKFILE_REL);
    } catch (err) {
      failures.push(`${LOCKFILE_REL}: ${errMsg(err)}`);
    }
  }

  // The config seeded by init is ours to remove — but only the empty `{}`
  // seed; a config recording platforms (or anything else) is the user's
  // host choice and stays.
  const configPath = containedArtifactPath(project, CONFIG_REL);
  try {
    if (configPath !== undefined && existsSync(configPath) && isPristineBootstrapConfig(readFileSync(configPath, "utf8"))) {
      rmSync(configPath);
      removed.push(".harness/config.json (pristine bootstrap — removed)");
    }
  } catch (err) {
    failures.push(`.harness/config.json: ${errMsg(err)}`);
  }

  // Drop .harness/ only when now empty — user rules/state keep it alive.
  // (rmdir never follows a symlinked .harness/: it fails on the link.)
  try {
    rmdirSync(join(project, HARNESS_DIR));
  } catch {
    /* non-empty, absent or a link — keep */
  }

  return { removed, failures };
}
