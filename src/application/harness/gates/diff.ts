// application/harness/gates/diff.ts — scope enforcement over the actual git
// diff. `allowedPaths` defaults to the active contract's declared scope: the
// model's own declaration becomes the objective boundary it is held to.

import { type DiffGate } from "../../../domain/harness/model.ts";
import { matchesAny } from "../../../domain/harness/glob.ts";
import { type GateContext, type GateOutcome } from "./types.ts";

export async function runDiffGate(gate: DiffGate, ctx: GateContext): Promise<GateOutcome> {
  if (!(await ctx.ports.git.isRepo(ctx.repoRoot))) {
    return { status: "skip", detail: "not a git repository — diff gates need git" };
  }

  let changed = ctx.changedFiles;
  if (gate.base !== undefined && gate.base !== ctx.baseRef) {
    const recomputed = await ctx.ports.git.changedFiles(ctx.repoRoot, gate.base);
    if (recomputed === null) {
      return { status: "error", detail: `cannot diff against "${gate.base}"` };
    }
    changed = recomputed;
  }

  const allowed =
    gate.allowedPaths ?? (ctx.contract && ctx.contract.scope.length > 0 ? ctx.contract.scope : undefined);
  const forbidden = gate.forbiddenPaths ?? ctx.contract?.outOfScope;

  const problems = [
    ...scopeProblems(changed, allowed, forbidden, ctx),
    ...limitProblems(gate, changed),
  ];

  if (problems.length > 0) {
    return { status: "fail", detail: problems.join("; ") };
  }
  const nothingDeclared =
    allowed === undefined &&
    forbidden === undefined &&
    gate.maxChangedFiles === undefined &&
    gate.requireChangesIn === undefined;
  if (nothingDeclared) {
    return { status: "pass", detail: "no scope declared — nothing to violate" };
  }
  return { status: "pass", detail: `${changed.length} changed file(s) within declared scope` };
}

function scopeProblems(
  changed: string[],
  allowed: string[] | undefined,
  forbidden: string[] | undefined,
  ctx: GateContext,
): string[] {
  const problems: string[] = [];
  if (allowed !== undefined) {
    // Harness metadata (config, rules, lockfile), leina's own graph/cache
    // artifacts (.leina/ — the graph-fresh gate itself asks for a refresh that
    // writes them) and sync-generated artifacts (AGENTS.md, CLAUDE.md, …, per
    // the lockfile) are never part of a task's declared scope; hooks and
    // `sync --check` police those instead.
    const generated = new Set(ctx.generatedPaths ?? []);
    const outside = changed.filter(
      (f) => !f.startsWith(".harness/") && !f.startsWith(".leina/") && !generated.has(f) && !matchesAny(f, allowed),
    );
    if (outside.length > 0) {
      problems.push(`outside allowed scope [${allowed.join(", ")}]: ${outside.join(", ")}`);
    }
  }
  if (forbidden !== undefined && forbidden.length > 0) {
    const hit = changed.filter((f) => matchesAny(f, forbidden));
    if (hit.length > 0) {
      problems.push(`forbidden paths changed: ${hit.join(", ")}`);
    }
  }
  return problems;
}

function limitProblems(gate: DiffGate, changed: string[]): string[] {
  const problems: string[] = [];
  if (gate.maxChangedFiles !== undefined && changed.length > gate.maxChangedFiles) {
    problems.push(`${changed.length} files changed (max ${gate.maxChangedFiles})`);
  }
  if (gate.requireChangesIn !== undefined) {
    for (const requirement of gate.requireChangesIn) {
      if (!changed.some((f) => matchesAny(f, [requirement]))) {
        problems.push(`no changes in required path "${requirement}"`);
      }
    }
  }
  return problems;
}
