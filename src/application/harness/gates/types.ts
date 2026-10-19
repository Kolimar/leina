// application/harness/gates/types.ts — execution-side contracts of the gate
// engine: per-gate outcome, the shared context handed to every runner, and
// the planned/finished run records the report is built from.
//
// Process and git access flow through the domain ports carried in the context
// (GateContext.ports) — gates never touch node:child_process directly.

import {
  type Gate,
  type Phase,
  type RuleLayer,
  type Severity,
  type TaskContract,
} from "../../../domain/harness/model.ts";
import { type HarnessPorts } from "../../../domain/harness/ports.ts";

export type GateStatus = "pass" | "fail" | "skip" | "error" | "timeout";

export interface GateOutcome {
  status: GateStatus;
  /** One-line machine-friendly explanation. */
  detail: string;
  /** Captured command output / matched lines, truncated by the runners. */
  output?: string;
}

export interface GateContext {
  repoRoot: string;
  /** Repo-relative changed files vs the resolved base (empty outside git). */
  changedFiles: string[];
  /**
   * Files harness itself generates (from the sync lockfile). Exempt from the
   * diff-scope allowed check — they are sync's responsibility, not the task's.
   */
  generatedPaths?: string[];
  /** Set per-run by the engine: source path of the rule owning the gate. */
  ruleSourcePath?: string;
  /** Set per-run by the engine: layer of that rule (js module resolution follows its trust). */
  ruleLayer?: RuleLayer;
  /** Base ref the changed files were computed against, if any. */
  baseRef?: string;
  contract?: TaskContract;
  defaultTimeoutMs: number;
  defaultBranch: string;
  /** Driven ports (process runner, git) wired by the composition root. */
  ports: HarnessPorts;
}

export interface GateRun {
  ruleId: string;
  phase: Phase;
  severity: Severity;
  gate: Gate;
  gateIndex: number;
  /** Rule markdown body — the remediation text surfaced on failure. */
  remediation: string;
  /** Where the rule file lives — lets builtin js gates resolve modules shipped next to them. */
  ruleSourcePath: string;
}

export interface GateRunResult extends GateOutcome {
  ruleId: string;
  phase: Phase;
  severity: Severity;
  gateType: Gate["type"];
  gateIndex: number;
  durationMs: number;
  /** failureMessage from the gate (if failing), for the feedback loop. */
  failureMessage?: string;
  remediation?: string;
}

export type GateRunner = (gate: Gate, ctx: GateContext) => Promise<GateOutcome>;
