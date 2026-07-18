// application/harness/tui-support.ts — pure building blocks for the TUI
// "armar arnés" flow. No IO, no prompts: the TUI layer asks the questions and
// writes the files; these helpers do the deterministic computation so they can
// be unit-tested without a terminal (test/harness-tui.test.ts).

import {
  type Rule,
  type RuleOverride,
  type TaskContract,
} from "../../domain/harness/model.ts";
import { type VerifyReport } from "./gates/report.ts";

// ---------------------------------------------------------------------------
// Rule adjustability — which resolved rules the TUI may toggle for this repo.
// ---------------------------------------------------------------------------

export interface AdjustableSplit {
  /**
   * Enabled blocking rules: the harness invariant says a local layer may never
   * weaken them, so the TUI shows them as fixed (marked, not selectable).
   */
  fixed: Rule[];
  /** Everything else: disabled rules (activatable) and advisory rules (toggleable). */
  adjustable: Rule[];
}

export function splitAdjustableRules(rules: Rule[]): AdjustableSplit {
  const fixed: Rule[] = [];
  const adjustable: Rule[] = [];
  for (const rule of rules) {
    if (rule.enabled && rule.severity === "blocking") fixed.push(rule);
    else adjustable.push(rule);
  }
  return { fixed, adjustable };
}

/**
 * Minimal `{ enabled }` overrides for the selection: only rules whose desired
 * state differs from their currently resolved state produce an entry.
 */
export function computeEnabledOverrides(
  adjustable: Rule[],
  selectedIds: readonly string[],
): Record<string, RuleOverride> {
  const overrides: Record<string, RuleOverride> = {};
  for (const rule of adjustable) {
    const want = selectedIds.includes(rule.id);
    if (want !== rule.enabled) overrides[rule.id] = { enabled: want };
  }
  return overrides;
}

/**
 * Merge `{ enabled }` overrides into the raw text of `.harness/config.json`
 * (project layer). Merge-safe: unknown top-level keys and unrelated per-rule
 * fields survive; malformed JSON is never clobbered (returns null — same
 * posture as the mcp-config writers).
 */
export function mergeRuleOverridesIntoConfig(
  existingRaw: string | null,
  overrides: Record<string, RuleOverride>,
): string | null {
  let parsed: Record<string, unknown> = {};
  if (existingRaw !== null && existingRaw.trim().length > 0) {
    let value: unknown;
    try {
      value = JSON.parse(existingRaw);
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  }
  const rulesRaw = parsed.rules;
  const rules: Record<string, unknown> =
    typeof rulesRaw === "object" && rulesRaw !== null && !Array.isArray(rulesRaw)
      ? { ...(rulesRaw as Record<string, unknown>) }
      : {};
  for (const [id, override] of Object.entries(overrides)) {
    const existing = rules[id];
    rules[id] = {
      ...(typeof existing === "object" && existing !== null && !Array.isArray(existing) ? existing : {}),
      ...override,
    };
  }
  return `${JSON.stringify({ ...parsed, rules }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Recipe suggestions — recipes embed their suggested contract in the body's
// `leina harness contract new …` command line; the TUI preloads those values.
// ---------------------------------------------------------------------------

export interface RecipeSuggestions {
  scope: string[];
  criteria: string[];
}

const SCOPE_FLAG_RE = /--scope\s+"([^"]+)"/g;
const CRITERION_FLAG_RE = /--criterion\s+"([^"]+)"/g;

function matchedValues(body: string, re: RegExp): string[] {
  const values: string[] = [];
  for (const match of body.matchAll(re)) {
    const value = match[1];
    if (value !== undefined && !values.includes(value)) values.push(value);
  }
  return values;
}

export function recipeSuggestions(body: string): RecipeSuggestions {
  return {
    scope: matchedValues(body, SCOPE_FLAG_RE),
    criteria: matchedValues(body, CRITERION_FLAG_RE),
  };
}

// ---------------------------------------------------------------------------
// Textual projections for p.note boxes.
// ---------------------------------------------------------------------------

/** Multi-line contract summary (goal, tipo, scope, criterios con su estado). */
export function contractSummary(contract: TaskContract): string {
  const lines = [`goal: ${contract.goal}`];
  if (contract.taskType) lines.push(`tipo: ${contract.taskType}`);
  lines.push(
    `scope: ${contract.scope.length > 0 ? contract.scope.join(", ") : "(vacío — el gate de diff no restringe nada)"}`,
  );
  if (contract.outOfScope.length > 0) lines.push(`fuera de scope: ${contract.outOfScope.join(", ")}`);
  if (contract.criteria.length > 0) {
    lines.push("criterios:");
    for (const c of contract.criteria) lines.push(`  [${c.done ? "x" : " "}] ${c.text}`);
  }
  return lines.join("\n");
}

const STATUS_ICON: Record<string, string> = {
  pass: "✔",
  fail: "✘",
  skip: "–",
  error: "⚠",
  timeout: "⏱",
};

/** Compact per-gate projection of a verify report (verde/rojo por gate). */
export function verifyReportLines(report: VerifyReport): string[] {
  const lines = report.results.map((r) => {
    const icon = STATUS_ICON[r.status] ?? "?";
    const base = `${icon} ${r.ruleId} [${r.gateType}] (${r.severity})`;
    return r.status === "pass" || r.status === "skip" ? base : `${base} — ${r.detail}`;
  });
  if (lines.length === 0) lines.push("(ningún gate aplicable)");
  const s = report.summary;
  lines.push("", `${s.passed} ok · ${s.failed} fallo(s) (${s.blockingFailures} bloqueante(s)) · ${s.skipped} omitido(s)`);
  return lines;
}
