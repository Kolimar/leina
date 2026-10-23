// test/sdd-routing-assets.test.ts — the SDD prompts route by size and pass specs by reference.
//
// Run: node --no-warnings --experimental-strip-types --test test/sdd-routing-assets.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const asset = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../assets/${rel}`, import.meta.url)), "utf8");

const ORCHESTRATOR = asset("skills/leina-sdd/SKILL.md");

// The orchestrator is read on every leina-sdd invocation, the direct route included. Raising
// this budget is a deliberate decision: say in the commit what the extra bytes buy.
const ORCHESTRATOR_BUDGET_BYTES = 10_240;

test("leina-sdd stays within its byte budget", () => {
  const bytes = Buffer.byteLength(ORCHESTRATOR, "utf8");
  assert.ok(bytes <= ORCHESTRATOR_BUDGET_BYTES, `leina-sdd is ${bytes} B, budget ${ORCHESTRATOR_BUDGET_BYTES} B`);
});

test("leina-sdd never spells the arguments placeholder", () => {
  // Claude Code substitutes every literal placeholder in a loaded skill body with the request,
  // duplicating it into prose; without one, the arguments are appended once at the end.
  assert.ok(!ORCHESTRATOR.includes("$ARGUMENTS"));
});

test("leina-sdd routes every change before any phase runs", () => {
  // The description is what makes the host invoke it: any non-direct change, before editing.
  assert.match(ORCHESTRATOR, /^description: Use before the first edit of any feature, bug fix, refactor or migration that is not a direct change/m);
  assert.match(ORCHESTRATOR, /## Step 0 — Route the change/);
  for (const route of ["**Direct**", "**Compact**", "**Full**"]) assert.ok(ORCHESTRATOR.includes(route), route);
  assert.match(ORCHESTRATOR, /`git diff` alone/);
  assert.match(ORCHESTRATOR, /never from counts of files|never comes from counts of files/);
  // Six named high-risk items decide escalation, not size.
  for (let item = 1; item <= 6; item++) assert.match(ORCHESTRATOR, new RegExp(`^${item}\\. `, "m"));
});

test("compact route keeps one plan in memory and hands work off by reference", () => {
  assert.match(ORCHESTRATOR, /--topic sdd\/\{change\}\/plan/);
  assert.match(ORCHESTRATOR, /## Specs[\s\S]*## Tasks[\s\S]*## Log/);
  assert.match(ORCHESTRATOR, /original request, verbatim/);
  assert.match(ORCHESTRATOR, /Hand off by reference, never by paraphrase/);
});

test("full route briefs carry the request verbatim and never launch phases through skill()", () => {
  assert.match(ORCHESTRATOR, /request, quoted\s+verbatim/);
  assert.match(ORCHESTRATOR, /Never launch a phase via the `skill\(\)` tool/);
  assert.match(ORCHESTRATOR, /leina affected <dir> <symbol>/);
});

test("phase prompts quote the user instead of paraphrasing", () => {
  assert.match(asset("skills/_shared/sdd-phase-common.md"), /### 0\.3 Quote, never paraphrase/);
  assert.match(asset("skills/sdd-propose/SKILL.md"), /## Request \(verbatim\)/);
  assert.match(asset("skills/sdd-spec/SKILL.md"), /Request \(verbatim\)/);
  assert.match(asset("skills/sdd-apply/SKILL.md"), /sdd\/\{change-name\}\/plan/);
  assert.match(asset("agents/sdd-apply.md"), /\*\*Compact route\.\*\*/);
});

test("the independent verifier defaults to a mid-tier model", () => {
  assert.match(asset("agents/sdd-verify.md"), /^model: sonnet$/m);
});
