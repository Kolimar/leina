// application/harness/gates/report.ts — builds the machine report persisted to
// `.harness/state/current/verify-report.json` and renders the two textual
// projections: the human summary and the compact enforcement→instruction
// feedback string (Stop-hook reason). Plain text, no color library — the
// primary consumer is a model, not a terminal.

import { type Phase } from "../../../domain/harness/model.ts";
import { isBlockingFailure } from "./engine.ts";
import { type GateRunResult } from "./types.ts";

export interface VerifySummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  blockingFailures: number;
  advisoryFailures: number;
}

export interface VerifyReport {
  schemaVersion: 1;
  phases: Phase[];
  startedAt: string;
  durationMs: number;
  results: GateRunResult[];
  summary: VerifySummary;
}

export function buildReport(phases: Phase[], startedAt: Date, results: GateRunResult[]): VerifyReport {
  const failing = results.filter((r) => r.status === "fail" || r.status === "error" || r.status === "timeout");
  return {
    schemaVersion: 1,
    phases,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: failing.length,
      skipped: results.filter((r) => r.status === "skip").length,
      errors: results.filter((r) => r.status === "error" || r.status === "timeout").length,
      blockingFailures: results.filter(isBlockingFailure).length,
      advisoryFailures: failing.filter((r) => r.severity === "advisory").length,
    },
  };
}

const STATUS_ICON: Record<string, string> = {
  pass: "✔",
  fail: "✘",
  skip: "–",
  error: "⚠",
  timeout: "⏱",
};

/** Human report — callers write it to stderr; stdout is reserved for machine output. */
export function renderHuman(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push(`harness verify — phases: ${report.phases.join(", ")}`);
  for (const r of report.results) {
    const icon = STATUS_ICON[r.status] ?? "?";
    lines.push(`  ${icon} ${r.ruleId} [${r.gateType}] (${r.severity}) ${r.durationMs}ms`);
    if (r.status !== "pass") lines.push(`      ${r.detail}`);
  }

  const failing = report.results.filter(
    (r) => r.status === "fail" || r.status === "error" || r.status === "timeout",
  );
  for (const r of failing) {
    lines.push("");
    lines.push(`FAILED ${r.ruleId} [${r.gateType}] — ${r.detail}`);
    if (r.output) lines.push(indent(r.output, 4));
    if (r.failureMessage) lines.push(indent(r.failureMessage, 4));
  }

  const s = report.summary;
  lines.push("");
  lines.push(`${s.passed} passed, ${s.failed} failed (${s.blockingFailures} blocking), ${s.skipped} skipped`);
  return lines.join("\n");
}

/**
 * Compact single-string report for the enforcement→instruction feedback loop
 * (Stop hook "reason", plugin throw message). Actionable per gate: id, command,
 * exit detail, first output lines, and the rule's remediation body.
 */
export function renderFeedback(report: VerifyReport, maxChars = 6000): string {
  const failing = report.results.filter(isBlockingFailure);
  if (failing.length === 0) return "";
  const parts: string[] = [
    `harness verify: ${failing.length} blocking gate(s) failing. The task is NOT complete. ` +
      "Fix each item and re-run `leina harness verify`.",
  ];
  for (const r of failing) {
    const chunk: string[] = [`\n[${r.ruleId}] ${r.detail}`];
    if (r.output) chunk.push(firstLines(r.output, 20));
    if (r.failureMessage) chunk.push(r.failureMessage);
    else if (r.remediation) chunk.push(firstLines(r.remediation, 8));
    parts.push(chunk.join("\n"));
  }
  const text = parts.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function firstLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return `${lines.slice(0, n).join("\n")}\n… (${lines.length - n} more lines)`;
}
