// application/harness/gates/diff-content.ts — native, shell-free check over
// ADDED diff lines. Replaces POSIX `git diff | grep` pipelines so gates work
// on Windows without bash.

import { type DiffContentGate } from "../../../domain/harness/model.ts";
import { type GateContext, type GateOutcome } from "./types.ts";

export async function runDiffContentGate(gate: DiffContentGate, ctx: GateContext): Promise<GateOutcome> {
  let re: RegExp;
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern comes from trusted rule files (.harness/rules/, bundled assets), invalid patterns map to an error outcome
    re = new RegExp(gate.forbidAdded, gate.ignoreCase ? "i" : "");
  } catch (err) {
    return { status: "error", detail: `invalid forbidAdded regex: ${(err as Error).message}` };
  }

  const paths = gate.paths && gate.paths.length > 0 ? gate.paths : undefined;
  const base = gate.base ?? ctx.baseRef;
  const baseOpts = {
    ...(base !== undefined ? { base } : {}),
    ...(paths !== undefined ? { paths } : {}),
  };

  let stdout = await ctx.ports.git.diffUnified(ctx.repoRoot, baseOpts);
  // No resolvable HEAD/base (fresh repo): diff the index against the empty tree.
  stdout ??= await ctx.ports.git.diffUnified(ctx.repoRoot, {
    cached: true,
    ...(paths !== undefined ? { paths } : {}),
  });
  if (stdout === null) {
    return { status: "skip", detail: "not a git repository — diff-content gates need git" };
  }

  const offending = stdout
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .filter((l) => re.test(l));

  if (offending.length > 0) {
    return {
      status: "fail",
      detail: `${offending.length} added line(s) match forbidden /${gate.forbidAdded}/`,
      output: offending.slice(0, 20).join("\n"),
    };
  }
  return { status: "pass", detail: `no added line matches /${gate.forbidAdded}/` };
}
