// application/harness/contract-io.ts — persistence of the task contract under
// `.harness/state/current/`: load/save the contract, keep the acceptance-
// criteria checklist in sync, and archive the whole state dir on `end`.
//
// File names are contract (compatibility with repos initialized by the
// original harness-framework): contract.json, checklist.md,
// state/history/<timestamp>/.

import path from "node:path";
import fs from "node:fs/promises";
import { type TaskContract } from "../../domain/harness/model.ts";
import { validateContract } from "../../domain/harness/validate.ts";
import { harnessDir } from "./config-io.ts";
import { fileExists, readJsonIfExists } from "./io.ts";

export function stateDir(repoRoot: string): string {
  return path.join(harnessDir(repoRoot), "state", "current");
}

export function contractPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), "contract.json");
}

export function checklistPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), "checklist.md");
}

export interface LoadedContract {
  contract?: TaskContract;
  error?: string;
}

export async function loadContract(repoRoot: string): Promise<LoadedContract> {
  const raw = await readJsonIfExists(contractPath(repoRoot));
  if (raw.error) return { error: `${contractPath(repoRoot)}: ${raw.error}` };
  if (raw.value === undefined) return {};
  const parsed = validateContract(raw.value);
  if (!parsed.ok) {
    return { error: `${contractPath(repoRoot)}: ${parsed.errors.join("; ")}` };
  }
  return { contract: parsed.value };
}

export async function saveContract(repoRoot: string, contract: TaskContract): Promise<void> {
  await fs.mkdir(stateDir(repoRoot), { recursive: true });
  await fs.writeFile(contractPath(repoRoot), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
}

/**
 * (Re)generate the acceptance-criteria checklist from the contract. The
 * criteria-checklist gate reads this file; the model checks boxes literally.
 * No criteria → no checklist file is written.
 */
export async function writeChecklist(repoRoot: string, contract: TaskContract): Promise<void> {
  if (contract.criteria.length === 0) return;
  const lines = [
    "# Acceptance criteria",
    "",
    "<!-- Check each box ONLY when the criterion is verifiably met. -->",
    "",
    ...contract.criteria.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`),
    "",
  ];
  await fs.mkdir(stateDir(repoRoot), { recursive: true });
  await fs.writeFile(checklistPath(repoRoot), lines.join("\n"), "utf8");
}

export type EndContractResult =
  | { ok: true; archivedTo: string }
  | { ok: false; error: string };

/**
 * Close the active contract: move `.harness/state/current/` (contract,
 * checklist, verify report, plan…) to `.harness/state/history/<timestamp>/`.
 */
export async function endContract(repoRoot: string, now = new Date()): Promise<EndContractResult> {
  const current = stateDir(repoRoot);
  if (!(await fileExists(contractPath(repoRoot)))) {
    return { ok: false, error: "no active contract" };
  }
  const stamp = now.toISOString().replaceAll(":", "-").replace(/\..+$/, "");
  const historyDir = path.join(harnessDir(repoRoot), "state", "history");
  await fs.mkdir(historyDir, { recursive: true });
  // Second-resolution stamps can collide (two ends within a second) — suffix.
  let archive = path.join(historyDir, stamp);
  for (let n = 2; await fileExists(archive); n += 1) {
    archive = path.join(historyDir, `${stamp}-${n}`);
  }
  await fs.rename(current, archive);
  return { ok: true, archivedTo: archive };
}
