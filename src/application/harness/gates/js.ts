// application/harness/gates/js.ts — escape hatch: a module exporting
// `default async (ctx) => ({ pass, message?, output? })`. Kept deliberately
// rare — declarative gates are the norm. The module is loaded with a dynamic
// import (allowed in the application layer; only static infra imports are
// forbidden).

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

export async function runJsGate(gate: JsGate, ctx: GateContext): Promise<GateOutcome> {
  // Repo-relative first; fall back to the rule's own directory so builtin
  // rules can ship their gate module inside the package (assets/harness/rules/gates/).
  let file = path.resolve(ctx.repoRoot, gate.module);
  if (!(await fileExists(file)) && ctx.ruleSourcePath !== undefined) {
    const nearRule = path.resolve(path.dirname(ctx.ruleSourcePath), gate.module);
    if (await fileExists(nearRule)) file = nearRule;
  }
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
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
