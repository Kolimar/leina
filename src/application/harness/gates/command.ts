// application/harness/gates/command.ts — the `command` gate: run a shell
// one-liner through the ProcessRunnerPort and check exit code (and optionally
// a stdout regex). Owns its timeout (the runner kills the process), so the
// engine does not wrap it again.

import { type CommandGate } from "../../../domain/harness/model.ts";
import { type GateContext, type GateOutcome } from "./types.ts";

const OUTPUT_LIMIT = 4000;

export async function runCommandGate(gate: CommandGate, ctx: GateContext): Promise<GateOutcome> {
  const timeout = gate.timeoutMs ?? ctx.defaultTimeoutMs;
  const result = await ctx.ports.proc.runShell(gate.run, {
    cwd: ctx.repoRoot,
    timeoutMs: timeout,
    ...(gate.env !== undefined ? { env: gate.env } : {}),
  });

  const output = truncate(result.all);

  if (result.timedOut) {
    return { status: "timeout", detail: `timed out after ${timeout}ms: ${gate.run}`, output };
  }
  if (result.exitCode !== gate.expectExitCode) {
    return {
      status: "fail",
      detail: `exit ${result.exitCode} (expected ${gate.expectExitCode}): ${gate.run}`,
      output,
    };
  }
  if (gate.expectStdoutMatch !== undefined) {
    let re: RegExp;
    try {
      // eslint-disable-next-line security/detect-non-literal-regexp -- pattern comes from trusted rule files (.harness/rules/, bundled assets), invalid patterns map to an error outcome
      re = new RegExp(gate.expectStdoutMatch);
    } catch (err) {
      return { status: "error", detail: `invalid expectStdoutMatch regex: ${(err as Error).message}` };
    }
    if (!re.test(result.stdout)) {
      return { status: "fail", detail: `stdout did not match /${gate.expectStdoutMatch}/`, output };
    }
  }
  return { status: "pass", detail: `exit ${result.exitCode}: ${gate.run}` };
}

function truncate(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n… (${text.length - OUTPUT_LIMIT} chars truncated)`;
}
