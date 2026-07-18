// application/harness/gates/engine.ts — runs all gates of the applicable
// rules. Non-serial gates run in a bounded parallel pool; gates marked
// `serial` run one at a time afterwards. Fail-closed: an `error`/`timeout`
// on a blocking rule counts as a blocking failure downstream.

import { type Gate, type Rule, gatesOf } from "../../../domain/harness/model.ts";
import { anyFileMatches } from "../../../domain/harness/glob.ts";
import { runCommandGate } from "./command.ts";
import { runFileGate } from "./file.ts";
import { runDiffGate } from "./diff.ts";
import { runDiffContentGate } from "./diff-content.ts";
import { runChecklistGate } from "./checklist.ts";
import { runJsGate } from "./js.ts";
import {
  type GateContext,
  type GateOutcome,
  type GateRun,
  type GateRunResult,
} from "./types.ts";

async function dispatch(gate: Gate, ctx: GateContext): Promise<GateOutcome> {
  switch (gate.type) {
    case "command":
      return runCommandGate(gate, ctx);
    case "file":
      return runFileGate(gate, ctx);
    case "diff":
      return runDiffGate(gate, ctx);
    case "diff-content":
      return runDiffContentGate(gate, ctx);
    case "checklist":
      return runChecklistGate(gate, ctx);
    case "js":
      return runJsGate(gate, ctx);
  }
}

function withTimeout(promise: Promise<GateOutcome>, ms: number): Promise<GateOutcome> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<GateOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout", detail: `gate timed out after ${ms}ms` }), ms);
      timer.unref?.();
    }),
  ]);
}

export function plannedRuns(rules: Rule[]): GateRun[] {
  const runs: GateRun[] = [];
  for (const rule of rules) {
    gatesOf(rule).forEach((gate, gateIndex) => {
      runs.push({
        ruleId: rule.id,
        phase: rule.phase,
        severity: rule.severity,
        gate,
        gateIndex,
        remediation: rule.body,
        ruleSourcePath: rule.sourcePath,
      });
    });
  }
  return runs;
}

async function executeRun(run: GateRun, ctx: GateContext): Promise<GateRunResult> {
  const started = Date.now();
  const base = {
    ruleId: run.ruleId,
    phase: run.phase,
    severity: run.severity,
    gateType: run.gate.type,
    gateIndex: run.gateIndex,
  };

  if (run.gate.onlyIfChanged && !anyFileMatches(ctx.changedFiles, run.gate.onlyIfChanged)) {
    return {
      ...base,
      status: "skip",
      detail: `no changed file matches [${run.gate.onlyIfChanged.join(", ")}]`,
      durationMs: Date.now() - started,
    };
  }

  let outcome: GateOutcome;
  try {
    // Command gates own their timeout via the process runner; wrap the rest here.
    const raw = dispatch(run.gate, { ...ctx, ruleSourcePath: run.ruleSourcePath });
    outcome =
      run.gate.type === "command"
        ? await raw
        : await withTimeout(raw, run.gate.timeoutMs ?? ctx.defaultTimeoutMs);
  } catch (err) {
    outcome = { status: "error", detail: `gate crashed: ${(err as Error).message}` };
  }

  const failing = outcome.status === "fail" || outcome.status === "error" || outcome.status === "timeout";
  return {
    ...base,
    ...outcome,
    durationMs: Date.now() - started,
    ...(failing && run.gate.failureMessage !== undefined
      ? { failureMessage: run.gate.failureMessage.trim() }
      : {}),
    ...(failing ? { remediation: run.remediation } : {}),
  };
}

export async function runGates(rules: Rule[], ctx: GateContext, parallelism = 4): Promise<GateRunResult[]> {
  const runs = plannedRuns(rules);
  const parallel = runs.filter((r) => r.gate.serial !== true);
  const serial = runs.filter((r) => r.gate.serial === true);

  const results = new Map<GateRun, GateRunResult>();

  const queue = [...parallel];
  const workers = Array.from({ length: Math.max(1, parallelism) }, async () => {
    for (;;) {
      const run = queue.shift();
      if (!run) return;
      results.set(run, await executeRun(run, ctx));
    }
  });
  await Promise.all(workers);

  for (const run of serial) {
    results.set(run, await executeRun(run, ctx));
  }

  // Preserve planning order for stable reports.
  return runs.map((run) => results.get(run)!);
}

export function isBlockingFailure(result: GateRunResult): boolean {
  return (
    result.severity === "blocking" &&
    (result.status === "fail" || result.status === "error" || result.status === "timeout")
  );
}
