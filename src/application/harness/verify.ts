// application/harness/verify.ts — "the wall". Loads rules, resolves the
// deterministic scope (contract + git diff), runs every applicable gate,
// persists the machine report for hooks/CI (full runs only — a --rule/--phase
// subset never replaces it), and maps the outcome to the exit-code contract:
//   0 = all blocking gates pass · 1 = blocking failure · 2 = engine/config/usage error.
//
// Process/git access is injected through domain ports (options.ports) — the
// composition root (cli, tests) wires infrastructure/harness/{exec,git}.ts.

import path from "node:path";
import fs from "node:fs/promises";
import {
  type Phase,
  DEFAULT_VERIFY_PHASES,
  isPhase,
} from "../../domain/harness/model.ts";
import { type GitPort, type HarnessPorts } from "../../domain/harness/ports.ts";
import { isTrustedWorkspaceDir } from "../install/trust.ts";
import { loadResolvedRules, filterRules } from "./resolver.ts";
import { ensureStateDir, loadContract } from "./contract-io.ts";
import { harnessDir } from "./config-io.ts";
import { readJsonIfExists } from "./io.ts";
import { fingerprintWorktree, type WorktreeFingerprint } from "./freshness.ts";
import { runGates } from "./gates/engine.ts";
import { buildReport, type VerifyReport } from "./gates/report.ts";
import { type GateContext } from "./gates/types.ts";

export interface VerifyOptions {
  /** Driven ports (process runner, git) — wired by the composition root. */
  ports: HarnessPorts;
  phases?: Phase[];
  /** Restrict to a single rule id. */
  ruleId?: string;
}

export interface VerifyOutcome {
  report: VerifyReport;
  /** Config/rule-loading problems — engine errors, distinct from gate failures. */
  loadErrors: string[];
  warnings: string[];
  /** 0 = all blocking pass · 1 = blocking failure · 2 = engine/config/usage error. */
  exitCode: 0 | 1 | 2;
  /** The caller asked for something that does not exist (unknown rule id). Also in loadErrors. */
  usageError?: string;
  /**
   * Whether this run (re)writes `.harness/state/current/verify-report.json` —
   * the report the commit guard trusts. Only FULL runs do (see isFullRun).
   */
  persisted: boolean;
}

/**
 * A run is FULL when nothing narrows it below the default: no `ruleId`, and
 * the phases include every default verify phase. Only a full run speaks for
 * the task, so only a full run may replace the persisted report — otherwise
 * `verify --rule <something green>` would overwrite a red verdict and unlock
 * the commit guard.
 */
function isFullRun(phases: readonly Phase[], ruleId: string | undefined): boolean {
  return ruleId === undefined && DEFAULT_VERIFY_PHASES.every((p) => phases.includes(p));
}

export function parsePhases(raw: string | undefined): Phase[] | { error: string } {
  if (!raw) return DEFAULT_VERIFY_PHASES;
  const phases: Phase[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (!isPhase(part)) return { error: `unknown phase "${part}"` };
    phases.push(part);
  }
  return phases.length > 0 ? phases : DEFAULT_VERIFY_PHASES;
}

export async function runVerify(repoRoot: string, options: VerifyOptions): Promise<VerifyOutcome> {
  const startedAt = new Date();
  const phases = options.phases ?? DEFAULT_VERIFY_PHASES;
  const { git } = options.ports;

  const resolution = await loadResolvedRules(repoRoot);
  const { contract, error: contractError } = await loadContract(repoRoot);
  const loadErrors = [...resolution.errors, ...(contractError ? [contractError] : [])];

  if (loadErrors.length > 0) {
    return {
      report: buildReport(phases, startedAt, []),
      loadErrors,
      warnings: resolution.warnings,
      exitCode: 2,
      persisted: false,
    };
  }

  // An unknown rule id would otherwise run zero gates and report green.
  if (options.ruleId !== undefined && !resolution.rules.some((r) => r.id === options.ruleId)) {
    const usageError = `unknown rule "${options.ruleId}" — \`leina harness list\` shows the resolved rule ids`;
    return {
      report: buildReport(phases, startedAt, []),
      loadErrors: [usageError],
      warnings: resolution.warnings,
      exitCode: 2,
      usageError,
      persisted: false,
    };
  }

  const { baseRef, changed: changedOrUnknown } = await resolveChangedFiles(
    repoRoot,
    git,
    contract?.baseRef,
    resolution.config.defaultBranch,
  );
  // No diff (not a repository, git unavailable): the changed files are
  // UNKNOWN, not empty — fail closed instead of skipping everything diff-scoped.
  const changedUnknown = changedOrUnknown === null;
  const changed = changedOrUnknown ?? [];

  let rules = filterRules(resolution.rules, {
    phases,
    // Unknown → no path/language filtering: every rule applies.
    ...(changedUnknown ? {} : { changedFiles: changed }),
    ...(contract?.taskType !== undefined ? { taskType: contract.taskType } : {}),
  });
  const warnings = [...resolution.warnings];
  if (changedUnknown) {
    warnings.push(
      "not a git repository (or git is unavailable): the changed files are unknown — " +
        "onlyIfChanged gates run unconditionally and diff gates fail closed",
    );
  }
  if (options.ruleId !== undefined) {
    rules = rules.filter((r) => r.id === options.ruleId);
    if (rules.length === 0) {
      warnings.push(
        `rule "${options.ruleId}" does not apply to this run (disabled, outside phases ` +
          `[${phases.join(", ")}], or out of the task's scope) — nothing ran`,
      );
    }
  }

  const ctx: GateContext = {
    repoRoot,
    changedFiles: changed,
    ...(changedUnknown ? { changedFilesUnknown: true } : {}),
    generatedPaths: await readGeneratedPaths(repoRoot),
    ...(baseRef !== undefined ? { baseRef } : {}),
    ...(contract !== undefined ? { contract } : {}),
    defaultTimeoutMs: resolution.config.verify.defaultTimeoutMs,
    defaultBranch: resolution.config.defaultBranch,
    ports: options.ports,
  };

  // WORKSPACE TRUST: js/command gates from PROJECT-layer rules execute
  // repo-supplied code — a cloned hostile repo (force-committed contract +
  // project rule) must not reach code execution just by being opened. Only a
  // workspace the user explicitly trusted (`leina init` → record in the
  // out-of-repo trust store; a committed .leina/consent grants nothing) may
  // run them; otherwise the engine skips them with a visible result.
  // Builtin/user rules and non-executable gate types are unaffected.
  const policy = { allowProjectExecutableGates: isTrustedWorkspaceDir(repoRoot) };
  const results = await runGates(rules, ctx, resolution.config.verify.parallelism, policy);
  const report = buildReport(phases, startedAt, results);

  const persisted = isFullRun(phases, options.ruleId);
  if (persisted) {
    // Fingerprint the tree AFTER the gates ran: the report covers the tree as
    // verify leaves it (gate outputs included). No diff → no fingerprint →
    // the commit guard treats the report as stale.
    const worktree = changedUnknown ? undefined : await fingerprintWorktree(repoRoot, git, baseRef);
    await persistReport(repoRoot, report, changed, worktree);
  }

  return {
    report,
    loadErrors: [],
    warnings,
    exitCode: report.summary.blockingFailures > 0 ? 1 : 0,
    persisted,
  };
}

/**
 * The base ref (contract baseRef, else merge-base with the default branch) and
 * the files changed against it; `changed: null` when no diff can be computed.
 */
async function resolveChangedFiles(
  repoRoot: string,
  git: GitPort,
  contractBaseRef: string | undefined,
  defaultBranch: string,
): Promise<{ baseRef?: string; changed: string[] | null }> {
  if (!(await git.isRepo(repoRoot))) return { changed: null };
  const baseRef = contractBaseRef ?? (await git.mergeBase(repoRoot, defaultBranch));
  const changed = await git.changedFiles(repoRoot, baseRef);
  return { ...(baseRef !== undefined ? { baseRef } : {}), changed };
}

/**
 * Paths of sync-generated artifacts from the committed lockfile
 * (`.harness/harness.lock.json`) — exempt from the diff-scope allowed check.
 * Tolerant reader: a missing or malformed lockfile yields no exemptions.
 */
async function readGeneratedPaths(repoRoot: string): Promise<string[]> {
  const raw = await readJsonIfExists(path.join(harnessDir(repoRoot), "harness.lock.json"));
  if (raw.value === undefined || typeof raw.value !== "object" || raw.value === null) return [];
  const artifacts = (raw.value as Record<string, unknown>).artifacts;
  if (!Array.isArray(artifacts)) return [];
  const paths: string[] = [];
  for (const artifact of artifacts) {
    if (typeof artifact === "object" && artifact !== null) {
      const p = (artifact as Record<string, unknown>).path;
      if (typeof p === "string") paths.push(p);
    }
  }
  return paths;
}

async function persistReport(
  repoRoot: string,
  report: VerifyReport,
  changedFiles: string[],
  worktree: WorktreeFingerprint | undefined,
): Promise<void> {
  try {
    const dir = await ensureStateDir(repoRoot);
    // The persisted document carries, on top of the report, the changed files
    // the run judged and the working-tree fingerprint the commit guard
    // (hooks.ts readVerifySummary) recomputes to detect a report gone STALE —
    // working tree changed after verify (freshness.ts).
    const persisted = { ...report, changedFiles, ...(worktree !== undefined ? { worktree } : {}) };
    await fs.writeFile(path.join(dir, "verify-report.json"), `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  } catch {
    // Persisting the report is best-effort; the exit code is the contract.
  }
}
