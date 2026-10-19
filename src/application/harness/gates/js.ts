// application/harness/gates/js.ts — escape hatch: a module exporting
// `default async (ctx) => ({ pass, message?, output? })`. Kept deliberately
// rare — declarative gates are the norm. The module is loaded with a dynamic
// import (allowed in the application layer; only static infra imports are
// forbidden).

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type JsGate } from "../../../domain/harness/model.ts";
import { fileExists } from "../io.ts";
import { type GateContext, type GateOutcome } from "./types.ts";

interface JsGateModuleResult {
  pass: boolean;
  message?: string;
  output?: string;
}

/** True when `child` is `parent` itself or lies inside it (both absolute). */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Where the gate module lives — resolution follows the trust of the rule that
 * declared it:
 *  - builtin/user rules: next to their own rule file ONLY. Looking in the repo
 *    first would let a repo plant a look-alike (e.g. gates/<name>.js at its
 *    root) and have it imported under a trusted rule.
 *  - project rules (and direct callers without a layer): repo-relative first,
 *    then next to the rule file — and the real path (symlinks resolved) must
 *    stay inside the repo: no `../`, no absolute paths, no escaping links.
 */
async function resolveModule(gate: JsGate, ctx: GateContext): Promise<{ file: string } | { error: string }> {
  if (ctx.ruleLayer === "builtin" || ctx.ruleLayer === "user") {
    if (ctx.ruleSourcePath === undefined) {
      return { error: `cannot resolve js gate module ${gate.module}: rule source path unknown` };
    }
    return { file: path.resolve(path.dirname(ctx.ruleSourcePath), gate.module) };
  }

  if (path.isAbsolute(gate.module)) {
    return { error: `js gate module ${gate.module} must be a repo-relative path` };
  }
  let file = path.resolve(ctx.repoRoot, gate.module);
  if (!(await fileExists(file)) && ctx.ruleSourcePath !== undefined) {
    const nearRule = path.resolve(path.dirname(ctx.ruleSourcePath), gate.module);
    if (await fileExists(nearRule)) file = nearRule;
  }
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([fs.realpath(file), fs.realpath(ctx.repoRoot)]);
  } catch (err) {
    return { error: `cannot load js gate module ${gate.module}: ${(err as Error).message}` };
  }
  if (!isWithin(realRoot, real)) {
    return { error: `js gate module ${gate.module} resolves outside the repository — project gates must stay inside it` };
  }
  return { file: real };
}

export async function runJsGate(gate: JsGate, ctx: GateContext): Promise<GateOutcome> {
  const resolved = await resolveModule(gate, ctx);
  if ("error" in resolved) return { status: "error", detail: resolved.error };
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(resolved.file).href)) as { default?: unknown };
  } catch (err) {
    return { status: "error", detail: `cannot load js gate module ${gate.module}: ${(err as Error).message}` };
  }
  const fn = mod.default;
  if (typeof fn !== "function") {
    return { status: "error", detail: `${gate.module} must export a default function` };
  }
  try {
    const raw = (await (fn as (c: GateContext) => unknown)(ctx)) as JsGateModuleResult | undefined;
    if (!raw || typeof raw.pass !== "boolean") {
      return { status: "error", detail: `${gate.module} must resolve to { pass: boolean, message? }` };
    }
    return {
      status: raw.pass ? "pass" : "fail",
      detail: raw.message ?? (raw.pass ? "js gate passed" : "js gate failed"),
      ...(raw.output !== undefined ? { output: raw.output } : {}),
    };
  } catch (err) {
    return { status: "error", detail: `js gate threw: ${(err as Error).message}` };
  }
}
