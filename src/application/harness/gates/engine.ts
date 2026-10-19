// application/harness/gates/engine.ts — runs all gates of the applicable
// rules. Non-serial gates run in a bounded parallel pool; gates marked
// `serial` run one at a time afterwards. Fail-closed: an `error`/`timeout`
// on a blocking rule counts as a blocking failure downstream.

import vm from "node:vm";
import { type Gate, type Rule, type RuleLayer, gatesOf } from "../../../domain/harness/model.ts";
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

// TODO: withTimeout is cooperative — it resolves the race but cannot cancel
// the underlying gate work (a stuck fs call or js gate keeps running until the
// process exits). Acceptable for verify's process lifetime; revisit if gates
// ever run inside a long-lived daemon.
function withTimeout(promise: Promise<GateOutcome>, ms: number): Promise<GateOutcome> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<GateOutcome>((resolve) => {
      // NOT unref'd: a gate stuck on a promise that never settles holds no handle,
      // so an unref'd timer would let the event loop drain and the process exit
      // before the timeout is reported (fail-open). finally() above clears it.
      timer = setTimeout(() => resolve({ status: "timeout", detail: `gate timed out after ${ms}ms` }), ms);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Bounded regex evaluation — rule-supplied patterns are attacker-influenced
// (they travel with the repo). Catastrophic backtracking (ReDoS) blocks the
// event loop SYNCHRONOUSLY, so a Promise.race timeout like withTimeout above
// can never fire against it; a vm script timeout interrupts V8 execution and
// can. The pattern is passed as DATA (a context binding), never concatenated
// into the script source.
// ---------------------------------------------------------------------------

const REGEX_EVAL_TIMEOUT_MS = 5000;

export interface BoundedRegexMatch {
  /** Index into the `lines` argument. */
  index: number;
  /** First 3 chars of the match + "***" — never the full matched text. */
  masked: string;
}

/**
 * Compile `pattern` and exec it against every line, all inside a vm script
 * with a hard timeout. Returns per-line matches with a MASKED excerpt only —
 * callers surfacing gate output must never re-emit the matched text (the
 * no-secrets gate would echo the very secret it caught). Invalid patterns and
 * timeouts map to `{ error }` — the caller decides the gate outcome.
 */
export function matchLinesBounded(
  pattern: string,
  flags: string,
  lines: readonly string[],
  timeoutMs = REGEX_EVAL_TIMEOUT_MS,
): { matches: BoundedRegexMatch[] } | { error: string } {
  const sandbox = { pattern, flags, lines, out: [] as BoundedRegexMatch[] };
  try {
    vm.runInNewContext(
      "const re = new RegExp(pattern, flags);" +
        "for (let i = 0; i < lines.length; i += 1) {" +
        "  const m = re.exec(lines[i]);" +
        "  if (m !== null) out.push({ index: i, masked: m[0].slice(0, 3) + '***' });" +
        "}",
      sandbox,
      { timeout: Math.max(1, Math.round(timeoutMs)) },
    );
    // Re-create the result objects in THIS realm — vm-born objects carry the
    // sandbox's prototypes, which trips deep-equality and instanceof checks.
    return { matches: sandbox.out.map((m) => ({ index: m.index, masked: m.masked })) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Workspace trust — executable gates (js: dynamic import, command: `sh -c`)
// run arbitrary code. When they come from a PROJECT-layer rule they travel
// with the repo, so a cloned hostile repo could otherwise reach silent code
// execution through the Stop hook's verify run (a force-committed
// .harness/state/current/contract.json plus a project rule is all it takes).
// The policy below lets the composition point (runVerify) gate those on
// explicit workspace trust. Builtin/user rules are trusted (they come from the
// installed package or the user's own home); non-executable gate types
// (file/diff/diff-content/checklist) only inspect state and always run.
// ---------------------------------------------------------------------------

const EXECUTABLE_GATE_TYPES: ReadonlySet<Gate["type"]> = new Set(["js", "command"]);

export interface GateExecutionPolicy {
  /**
   * Whether js/command gates declared by 'project'-layer rules may execute.
   * Derived from explicit workspace trust (`leina init` → out-of-repo trust
   * record, see application/install/trust.ts).
   * When false those gates are SKIPPED with a visible result — they neither
   * run nor fail verify on their own. Omitting the policy entirely (unit
   * tests, direct engine callers) keeps the historical run-everything shape.
   */
  allowProjectExecutableGates: boolean;
}

/** GateRun plus the layer of the rule that declared it (trust decisions). */
export interface PlannedGateRun extends GateRun {
  ruleLayer: RuleLayer;
}

export function plannedRuns(rules: Rule[]): PlannedGateRun[] {
  const runs: PlannedGateRun[] = [];
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
        ruleLayer: rule.layer,
      });
    });
  }
  return runs;
}

async function executeRun(
  run: PlannedGateRun,
  ctx: GateContext,
  policy?: GateExecutionPolicy,
): Promise<GateRunResult> {
  const started = Date.now();
  const base = {
    ruleId: run.ruleId,
    phase: run.phase,
    severity: run.severity,
    gateType: run.gate.type,
    gateIndex: run.gateIndex,
  };

  if (
    policy !== undefined &&
    !policy.allowProjectExecutableGates &&
    run.ruleLayer === "project" &&
    EXECUTABLE_GATE_TYPES.has(run.gate.type)
  ) {
    return {
      ...base,
      status: "skip",
      detail:
        "skipped: executable gate (js/command) from untrusted 'project' layer rule — " +
        "run 'leina init' to trust this repo",
      durationMs: Date.now() - started,
    };
  }

  // An UNKNOWN changed-file set (no git) must not read as "nothing changed":
  // the gate runs, fail-closed, instead of skipping.
  if (
    run.gate.onlyIfChanged &&
    ctx.changedFilesUnknown !== true &&
    !anyFileMatches(ctx.changedFiles, run.gate.onlyIfChanged)
  ) {
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
    const raw = dispatch(run.gate, { ...ctx, ruleSourcePath: run.ruleSourcePath, ruleLayer: run.ruleLayer });
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

export async function runGates(
  rules: Rule[],
  ctx: GateContext,
  parallelism = 4,
  policy?: GateExecutionPolicy,
): Promise<GateRunResult[]> {
  const runs = plannedRuns(rules);
  const parallel = runs.filter((r) => r.gate.serial !== true);
  const serial = runs.filter((r) => r.gate.serial === true);

  const results = new Map<GateRun, GateRunResult>();

  const queue = [...parallel];
  const workers = Array.from({ length: Math.max(1, parallelism) }, async () => {
    for (;;) {
      const run = queue.shift();
      if (!run) return;
      results.set(run, await executeRun(run, ctx, policy));
    }
  });
  await Promise.all(workers);

  for (const run of serial) {
    results.set(run, await executeRun(run, ctx, policy));
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
