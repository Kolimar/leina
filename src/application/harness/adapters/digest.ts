// application/harness/adapters/digest.ts — shared instruction rendering: the
// compact rule digest injected into model context by every adapter. The
// executable oracle (`leina harness verify`) is the same everywhere; this text
// is the persuasion half. Ported from the origin harness-framework with a full
// rebrand of the command surface: `npx harness X` → `leina harness X`.

import { type Rule, gatesOf, PHASES } from "../../../domain/harness/model.ts";
import { type RuleBundle } from "./types.ts";

export const COMPLETION_PROTOCOL = `## Completion protocol (non-negotiable)

You are NOT done until \`leina harness verify\` exits 0.

1. Before starting a non-trivial task, declare a task contract:
   \`leina harness contract new --goal "<goal>" --type <type> --scope "<glob>"\`.
   Only files matching the declared scope may change.
2. When you believe the task is complete, run \`leina harness verify\`.
3. If it fails, read the per-gate report: it names the failing gate, the exact
   command, the output, and how to remediate. Fix the cause and re-run.
4. Never weaken a rule, skip a test, or edit \`.harness/\` config to get past a
   gate. If a gate seems wrong, finish what you can and report the disagreement.
5. After 3 failed attempts, stop and report the failing gates verbatim.`;

const PHASE_TITLES: Record<string, string> = {
  intake: "Context (intake)",
  plan: "Before the task (plan)",
  execute: "While working (execute)",
  verify: "Before claiming completion (verify)",
  deliver: "Delivery (deliver)",
};

function ruleLine(rule: Rule): string {
  const summary = rule.summary ?? firstLine(rule.body);
  const gates = gatesOf(rule);
  const enforcement = gates.length > 0 ? ` (enforced: ${gates.map((g) => g.type).join(", ")})` : "";
  return `- **${rule.id}** [${rule.severity}]${enforcement}: ${summary}`;
}

function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  return line ?? "";
}

export function renderRuleDigest(bundle: RuleBundle): string {
  const sections: string[] = [];
  for (const phase of PHASES) {
    const rules = bundle.rules.filter((r) => r.phase === phase);
    if (rules.length === 0) continue;
    const sorted = [...rules].sort((a, b) =>
      a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === "blocking" ? -1 : 1,
    );
    sections.push(`### ${PHASE_TITLES[phase] ?? phase}\n${sorted.map(ruleLine).join("\n")}`);
  }
  return sections.join("\n\n");
}

export const CONTRACT_TEMPLATE = `## Task contract template

Before editing code, write \`.harness/state/current/contract.json\`
(or run \`leina harness contract new\` which scaffolds it):

\`\`\`json
{
  "goal": "<one sentence: what done looks like>",
  "taskType": "feature | bugfix | refactor | docs | chore",
  "scope": ["src/module/**"],
  "outOfScope": ["docs/**"],
  "criteria": [{ "text": "<observable acceptance criterion>" }],
  "maxRetries": 3
}
\`\`\`

The scope globs are enforced against the real git diff — declare them honestly
and amend the contract (with a stated reason) before touching anything outside.`;

export function renderInstructionBlock(
  bundle: RuleBundle,
  opts: { includeContractTemplate: boolean },
): string {
  const parts = [
    "# Harness rules",
    "_Generated from `.harness/rules/` by `leina harness sync` — edit the rule files, not this block._",
    COMPLETION_PROTOCOL,
    renderRuleDigest(bundle),
  ];
  if (opts.includeContractTemplate) parts.push(CONTRACT_TEMPLATE);
  parts.push("Full rule text: `.harness/rules/` and `leina harness list`.");
  return parts.join("\n\n");
}
