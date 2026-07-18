// application/harness/gates/checklist.ts — parses `- [ ]` items in a markdown
// checklist. Combines model self-attestation (it must literally check the
// boxes) with a mechanical pass condition.

import path from "node:path";
import { type ChecklistGate } from "../../../domain/harness/model.ts";
import { readTextIfExists } from "../io.ts";
import { type GateContext, type GateOutcome } from "./types.ts";

const ITEM_RE = /^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/gm;

export async function runChecklistGate(gate: ChecklistGate, ctx: GateContext): Promise<GateOutcome> {
  const file = path.join(ctx.repoRoot, gate.path);
  const content = await readTextIfExists(file);
  if (content === undefined) {
    // No checklist exists. That is only a violation when an active contract
    // declared criteria (contract new generates the checklist from them).
    if (!ctx.contract || ctx.contract.criteria.length === 0) {
      return { status: "skip", detail: "no active contract with criteria — nothing to check off" };
    }
    return { status: "fail", detail: `checklist file not found: ${gate.path}` };
  }

  const unchecked: string[] = [];
  let total = 0;
  for (const match of content.matchAll(ITEM_RE)) {
    total += 1;
    if (match[1] === " ") unchecked.push((match[2] ?? "").trim());
  }

  if (total === 0) {
    return { status: "fail", detail: `${gate.path} contains no checklist items ("- [ ] …")` };
  }
  if (gate.requireAllChecked && unchecked.length > 0) {
    return {
      status: "fail",
      detail: `${unchecked.length}/${total} items unchecked`,
      output: unchecked.map((item) => `- [ ] ${item}`).join("\n"),
    };
  }
  return { status: "pass", detail: `${total - unchecked.length}/${total} items checked` };
}
