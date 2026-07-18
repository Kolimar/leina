// application/harness/verify.ts — "the wall". Loads rules, resolves the
// deterministic scope (contract + git diff), runs every applicable gate,
// persists the machine report for hooks/CI, and maps the outcome to the
// exit-code contract:
//   0 = all blocking gates pass · 1 = blocking failure · 2 = engine/config error.
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
import { type HarnessPorts } from "../../domain/harness/ports.ts";
import { loadResolvedRules, filterRules } from "./resolver.ts";
import { loadContract, stateDir } from "./contract-io.ts";
import { harnessDir } from "./config-io.ts";
import { readJsonIfExists } from "./io.ts";
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
  /** 0 = all blocking pass · 1 = blocking failure · 2 = engine/config error. */
  exitCode: 0 | 1 | 2;
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
    };
  }

  let baseRef: string | undefined;
  let changed: string[] = [];
  if (await git.isRepo(repoRoot)) {
    baseRef = contract?.baseRef ?? (await git.mergeBase(repoRoot, resolution.config.defaultBranch));
    changed = (await git.changedFiles(repoRoot, baseRef)) ?? [];
  }

  let rules = filterRules(resolution.rules, {
    phases,
    changedFiles: changed,
    ...(contract?.taskType !== undefined ? { taskType: contract.taskType } : {}),
  });
  if (options.ruleId) rules = rules.filter((r) => r.id === options.ruleId);

  const ctx: GateContext = {
    repoRoot,
    changedFiles: changed,
    generatedPaths: await readGeneratedPaths(repoRoot),
    ...(baseRef !== undefined ? { baseRef } : {}),
    ...(contract !== undefined ? { contract } : {}),
    defaultTimeoutMs: resolution.config.verify.defaultTimeoutMs,
    defaultBranch: resolution.config.defaultBranch,
    ports: options.ports,
  };

  const results = await runGates(rules, ctx, resolution.config.verify.parallelism);
  const report = buildReport(phases, startedAt, results);

  await persistReport(repoRoot, report);

  return {
    report,
    loadErrors: [],
    warnings: resolution.warnings,
    exitCode: report.summary.blockingFailures > 0 ? 1 : 0,
  };
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

async function persistReport(repoRoot: string, report: VerifyReport): Promise<void> {
  try {
    const dir = stateDir(repoRoot);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "verify-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {
    // Persisting the report is best-effort; the exit code is the contract.
  }
}
