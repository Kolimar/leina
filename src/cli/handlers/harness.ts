// cli/handlers/harness.ts — the `leina harness <sub>` command group: the task
// harness absorbed from the origin harness-framework. Transport only — the
// logic lives in application/harness/* (contract-io, verify, sync, hooks) and
// the driven ports are composed HERE (composition root): ShellProcessRunner +
// HarnessGit from infrastructure/harness/.
//
// Output contract (mirrors the origin CLI): stderr carries the human report,
// stdout is reserved for machine output (--json, hook protocol JSON, the
// session-start context). Exit codes: 0 ok · 1 gate/drift failure · 2 usage or
// engine/config error. Handlers set process.exitCode (never process.exit) so
// tests can drive them in-process.

import { existsSync } from "node:fs";
import path from "node:path";
import { hasFlag, optFlag } from "../args.ts";
import { fail, readStdin } from "../io.ts";
import { gatesOf, type TaskContract } from "../../domain/harness/model.ts";
import { type HarnessPorts } from "../../domain/harness/ports.ts";
import { endContract, loadContract, saveContract, writeChecklist } from "../../application/harness/contract-io.ts";
import { loadConfig } from "../../application/harness/config-io.ts";
import { loadResolvedRules } from "../../application/harness/resolver.ts";
import { parsePhases, runVerify } from "../../application/harness/verify.ts";
import { renderHuman } from "../../application/harness/gates/report.ts";
import { runSync } from "../../application/harness/sync.ts";
import {
  advisoryVerifyFeedback,
  decideCursorShell,
  decidePreBash,
  decidePreEdit,
  decideStop,
  isHookEvent,
  payloadCommand,
  payloadFilePath,
  recordCursorEdit,
  sessionStartContext,
  type HookPayload,
} from "../../application/harness/hooks.ts";
import { isWorkspaceTrusted } from "../../application/install/trust.ts";
import { ShellProcessRunner } from "../../infrastructure/harness/exec.ts";
import { HarnessGit } from "../../infrastructure/harness/git.ts";

const err = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};
const out = (msg: string): void => {
  process.stdout.write(`${msg}\n`);
};

/** Composition root for the driven ports — also used by the TUI harness flow. */
export function makeHarnessPorts(): HarnessPorts {
  return { proc: new ShellProcessRunner(), git: new HarnessGit() };
}

/**
 * Repo root resolution, mirroring the origin's findRepoRoot: walk up from cwd
 * until a directory containing `.harness/` or `.git` is found; fall back to
 * cwd itself (a bare directory can still hold rules/config).
 */
export function findHarnessRepoRoot(cwd: string = process.cwd()): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, ".harness")) || existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

/** Every value of a repeatable flag (`--scope a --scope b` → ["a", "b"]). */
function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`${name} requires a value`);
    values.push(v);
    i++;
  }
  return values;
}

// ---------------------------------------------------------------------------
// contract — lifecycle: new / show / edit / end
// ---------------------------------------------------------------------------

function printContract(contract: TaskContract): void {
  err(`goal: ${contract.goal}`);
  if (contract.taskType) err(`type: ${contract.taskType}`);
  err(`scope: ${contract.scope.length > 0 ? contract.scope.join(", ") : "(none — diff gate has nothing to enforce)"}`);
  if (contract.outOfScope.length > 0) err(`out of scope: ${contract.outOfScope.join(", ")}`);
  if (contract.criteria.length > 0) {
    err("criteria:");
    for (const c of contract.criteria) err(`  - [${c.done ? "x" : " "}] ${c.text}`);
  }
  err(`max retries: ${contract.maxRetries}`);
  if (contract.baseRef) err(`base ref: ${contract.baseRef}`);
}

export interface CreateContractOptions {
  goal?: string | undefined;
  taskType?: string | undefined;
  scope?: string[];
  outOfScope?: string[];
  criteria?: string[];
  /** Defaults to 3 (same as the CLI flag default). */
  maxRetries?: number | undefined;
}

export type CreateContractResult =
  | { ok: true; contract: TaskContract }
  | { ok: false; error: string; active?: TaskContract };

/**
 * Shared contract-creation path — the single implementation behind
 * `leina harness contract new` AND the TUI "armar arnés" flow. Validation
 * order mirrors the historical CLI behavior exactly (active contract → goal →
 * task type → max retries), so error messages and exit codes are unchanged.
 */
export async function createContract(
  repoRoot: string,
  opts: CreateContractOptions,
): Promise<CreateContractResult> {
  const existing = await loadContract(repoRoot);
  if (existing.error) return { ok: false, error: existing.error };
  if (existing.contract) {
    return {
      ok: false,
      error: "a contract is already active — finish it with `leina harness contract end` first",
      active: existing.contract,
    };
  }

  const goal = opts.goal;
  if (goal === undefined || goal.trim().length === 0) {
    return { ok: false, error: 'contract new requires --goal "<one sentence: what done looks like>"' };
  }

  const { config } = await loadConfig(repoRoot);
  if (opts.taskType !== undefined && !config.taskTypes.includes(opts.taskType)) {
    return {
      ok: false,
      error: `unknown task type "${opts.taskType}" — configured types: ${config.taskTypes.join(", ")}`,
    };
  }

  const maxRetries = opts.maxRetries ?? 3;
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    return { ok: false, error: "--max-retries must be a positive integer" };
  }

  const git = new HarnessGit();
  const baseRef = (await git.isRepo(repoRoot)) ? await git.currentHead(repoRoot) : undefined;

  const created: TaskContract = {
    goal,
    ...(opts.taskType !== undefined ? { taskType: opts.taskType } : {}),
    scope: opts.scope ?? [],
    outOfScope: opts.outOfScope ?? [],
    criteria: (opts.criteria ?? []).map((text) => ({ text, done: false })),
    maxRetries,
    ...(baseRef !== undefined ? { baseRef } : {}),
    createdAt: new Date().toISOString(),
  };

  await saveContract(repoRoot, created);
  await writeChecklist(repoRoot, created);
  return { ok: true, contract: created };
}

async function contractNew(repoRoot: string, rest: string[]): Promise<void> {
  const maxRetriesRaw = optFlag(rest, "--max-retries", undefined);
  const result = await createContract(repoRoot, {
    goal: optFlag(rest, "--goal", undefined),
    taskType: optFlag(rest, "--type", undefined),
    scope: flagValues(rest, "--scope"),
    outOfScope: flagValues(rest, "--out-of-scope"),
    criteria: flagValues(rest, "--criterion"),
    maxRetries: maxRetriesRaw !== undefined ? Number.parseInt(maxRetriesRaw, 10) : undefined,
  });
  if (!result.ok) {
    err(result.error);
    if (result.active) printContract(result.active);
    process.exitCode = 2;
    return;
  }
  err("contract created");
  printContract(result.contract);
}

async function contractEdit(repoRoot: string, rest: string[]): Promise<void> {
  const { contract: active, error } = await loadContract(repoRoot);
  if (error) {
    err(error);
    process.exitCode = 2;
    return;
  }
  if (!active) {
    err("no active contract — create one with `leina harness contract new`");
    process.exitCode = 2;
    return;
  }

  const goal = optFlag(rest, "--goal", undefined);
  if (goal !== undefined) active.goal = goal;
  active.scope.push(...flagValues(rest, "--add-scope").filter((g) => !active.scope.includes(g)));
  active.outOfScope.push(
    ...flagValues(rest, "--add-out-of-scope").filter((g) => !active.outOfScope.includes(g)),
  );
  for (const text of flagValues(rest, "--add-criterion")) {
    if (!active.criteria.some((c) => c.text === text)) active.criteria.push({ text, done: false });
  }
  for (const text of flagValues(rest, "--check-criterion")) {
    const criterion = active.criteria.find((c) => c.text === text);
    if (!criterion) {
      err(`no criterion with text "${text}"`);
      process.exitCode = 2;
      return;
    }
    criterion.done = true;
  }

  await saveContract(repoRoot, active);
  await writeChecklist(repoRoot, active);
  err("contract updated");
  printContract(active);
}

async function contractShow(repoRoot: string): Promise<void> {
  const { contract: active, error } = await loadContract(repoRoot);
  if (error) {
    err(error);
    process.exitCode = 2;
    return;
  }
  if (!active) {
    err("no active contract");
    process.exitCode = 1;
    return;
  }
  printContract(active);
}

async function contractEnd(repoRoot: string): Promise<void> {
  const result = await endContract(repoRoot);
  if (!result.ok) {
    err(result.error);
    process.exitCode = 1;
    return;
  }
  err(`contract ended — state archived to ${path.relative(repoRoot, result.archivedTo)}`);
}

async function handleContract(repoRoot: string, rest: string[]): Promise<void> {
  const [sub, ...subRest] = rest;
  switch (sub) {
    case "new":
      await contractNew(repoRoot, subRest);
      return;
    case "edit":
      await contractEdit(repoRoot, subRest);
      return;
    case "show":
      await contractShow(repoRoot);
      return;
    case "end":
      await contractEnd(repoRoot);
      return;
    default:
      err("Usage: leina harness contract <new|show|edit|end> [flags]");
      process.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// verify — run the gates; the exit code IS the completion contract.
// ---------------------------------------------------------------------------

async function handleVerifySub(repoRoot: string, rest: string[]): Promise<void> {
  const phases = parsePhases(optFlag(rest, "--phase", undefined));
  if ("error" in phases) {
    err(phases.error);
    process.exitCode = 2;
    return;
  }

  const ruleId = optFlag(rest, "--rule", undefined);
  const outcome = await runVerify(repoRoot, {
    ports: makeHarnessPorts(),
    phases,
    ...(ruleId !== undefined ? { ruleId } : {}),
  });

  for (const warning of outcome.warnings) err(`warning: ${warning}`);
  for (const error of outcome.loadErrors) err(`error: ${error}`);

  if (outcome.loadErrors.length === 0) err(renderHuman(outcome.report));
  if (hasFlag(rest, "--json")) out(JSON.stringify(outcome.report, null, 2));
  process.exitCode = outcome.exitCode;
}

// ---------------------------------------------------------------------------
// sync — regenerate platform artifacts (idempotent); --check = CI drift mode.
// ---------------------------------------------------------------------------

async function handleSyncSub(repoRoot: string, rest: string[]): Promise<void> {
  const platformsFlag = optFlag(rest, "--platforms", undefined);
  const result = await runSync(repoRoot, {
    check: hasFlag(rest, "--check"),
    force: hasFlag(rest, "--force"),
    ...(platformsFlag !== undefined
      ? { platforms: platformsFlag.split(",").map((p) => p.trim()).filter(Boolean) }
      : {}),
  });

  for (const w of result.warnings) err(`warning: ${w}`);
  for (const e of result.errors) err(`error: ${e}`);

  if (result.outcome) {
    for (const item of result.outcome.items) {
      err(`${item.action.padEnd(9)} ${item.path} [${item.adapter}/${item.kind}]`);
      if (item.detail) err(`          ${item.detail}`);
    }
    if (hasFlag(rest, "--check")) {
      err(
        result.outcome.driftCount > 0
          ? `\n${result.outcome.driftCount} artifact(s) stale — run \`leina harness sync\``
          : "\nartifacts up to date",
      );
    } else if (result.outcome.conflictCount > 0) {
      err(`\n${result.outcome.conflictCount} conflict(s)/error(s) — resolve or rerun with --force`);
    }
  }

  process.exitCode = result.exitCode;
}

// ---------------------------------------------------------------------------
// list — resolved rules with layer/state/phase/gates.
// ---------------------------------------------------------------------------

async function handleListSub(repoRoot: string, rest: string[]): Promise<void> {
  const phase = optFlag(rest, "--phase", undefined);
  const tag = optFlag(rest, "--tag", undefined);

  const resolution = await loadResolvedRules(repoRoot);
  for (const error of resolution.errors) err(`error: ${error}`);

  let rules = resolution.rules;
  if (phase !== undefined) rules = rules.filter((r) => r.phase === phase);
  if (tag !== undefined) rules = rules.filter((r) => r.tags.includes(tag));

  if (hasFlag(rest, "--json")) {
    const projected = rules.map((r) => ({
      id: r.id,
      phase: r.phase,
      severity: r.severity,
      enabled: r.enabled,
      layer: r.layer,
      gates: gatesOf(r).map((g) => g.type),
      tags: r.tags,
      summary: r.summary ?? "",
    }));
    out(JSON.stringify(projected, null, 2));
    return;
  }

  const rows = rules.map((r) => [
    r.enabled ? "on " : "off",
    r.id,
    r.phase,
    r.severity,
    gatesOf(r).map((g) => g.type).join(",") || "none",
    r.layer,
  ]);
  const header = ["   ", "ID", "PHASE", "SEVERITY", "GATES", "LAYER"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");

  out(fmt(header));
  for (const row of rows) out(fmt(row));
  out(`\n${rules.length} rule(s)`);
}

// ---------------------------------------------------------------------------
// hook — the platform hook entry point used by the sync-generated wiring
// (cursor/windsurf/opencode). Payload JSON arrives on stdin; the decision
// logic lives in application/harness/hooks.ts; this transport maps decisions
// to the per-host output protocol.
// ---------------------------------------------------------------------------

function parsePayload(raw: string): HookPayload {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as HookPayload) : {};
  } catch {
    return {};
  }
}

/** Exported for in-process tests: same dispatch the CLI runs, minus stdin. */
export async function runHarnessHookEvent(event: string, rawPayload: string, repoRoot: string): Promise<void> {
  if (!isHookEvent(event)) {
    err(`unknown hook event "${event}"`);
    process.exitCode = 2;
    return;
  }
  // WORKSPACE TRUST: these hooks fire unattended, so in a workspace the user never
  // trusted (`leina init` → out-of-repo record) they are silent no-ops — no blocks, no
  // verify run, no contract/rule injection. Fail open: Cursor's shell hook still gets
  // its protocol answer.
  if (!isWorkspaceTrusted(repoRoot)) {
    if (event === "cursor-shell") out(JSON.stringify({ permission: "allow" }));
    return;
  }
  const payload = parsePayload(rawPayload);
  switch (event) {
    case "session-start":
      out(await sessionStartContext(repoRoot));
      return;
    case "pre-edit": {
      const decision = await decidePreEdit(repoRoot, payloadFilePath(payload));
      if (decision.block) {
        err(decision.message);
        process.exitCode = 2;
      }
      return;
    }
    case "pre-bash": {
      const decision = await decidePreBash(repoRoot, payloadCommand(payload));
      if (decision.block) {
        err(decision.message);
        process.exitCode = 2;
      }
      return;
    }
    case "stop": {
      const decision = await decideStop(repoRoot, makeHarnessPorts(), payload.stop_hook_active === true);
      if (decision.kind === "block") out(JSON.stringify({ decision: "block", reason: decision.reason }));
      else if (decision.kind === "yield") err(decision.message);
      return;
    }
    case "cursor-shell":
      out(JSON.stringify(await decideCursorShell(repoRoot, payloadCommand(payload))));
      return;
    case "cursor-after-edit":
      await recordCursorEdit(repoRoot, payloadFilePath(payload));
      return;
    case "cursor-stop":
    case "idle": {
      const feedback = await advisoryVerifyFeedback(repoRoot, makeHarnessPorts());
      if (feedback) err(feedback);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Group dispatcher + help
// ---------------------------------------------------------------------------

function printHarnessHelp(): void {
  out(
    `leina harness — rules + executable gates for agent tasks (.harness/)\n\n` +
      `  contract new --goal "<t>" [--type <t>] [--scope <glob>]... [--out-of-scope <glob>]...\n` +
      `               [--criterion <text>]... [--max-retries <n>]\n` +
      `                          declare the task contract (records the git base ref)\n` +
      `  contract show           print the active contract\n` +
      `  contract edit [--goal <t>] [--add-scope <g>]... [--add-out-of-scope <g>]...\n` +
      `               [--add-criterion <t>]... [--check-criterion <t>]...\n` +
      `                          amend the contract (scope widening is explicit, never silent)\n` +
      `  contract end            archive the task state and close the contract\n` +
      `  verify [--json] [--phase p1,p2] [--rule <id>]\n` +
      `                          run the gates; exit 0 = complete, 1 = blocking failure,\n` +
      `                          2 = engine/config error\n` +
      `  sync [--check] [--force] [--platforms a,b]   (alias: compile)\n` +
      `                          regenerate platform artifacts from the canonical rules\n` +
      `                          (idempotent); --check exits 1 on drift (CI mode);\n` +
      `                          --platforms touches only the named platforms\n` +
      `  list [--phase <p>] [--tag <t>] [--json]\n` +
      `                          resolved rules with source layer and enforcement\n` +
      `  hook <event>            platform hook entry point (session-start, pre-edit,\n` +
      `                          pre-bash, stop, cursor-shell, cursor-after-edit,\n` +
      `                          cursor-stop, idle); reads event JSON from stdin`,
  );
}

export async function handleHarness(rest: string[]): Promise<void> {
  const [sub, ...subRest] = rest;
  const repoRoot = findHarnessRepoRoot();
  switch (sub) {
    case "contract":
      await handleContract(repoRoot, subRest);
      break;
    case "verify":
      await handleVerifySub(repoRoot, subRest);
      break;
    case "sync":
    case "compile": // origin alias
      await handleSyncSub(repoRoot, subRest);
      break;
    case "list":
      await handleListSub(repoRoot, subRest);
      break;
    case "hook": {
      const event = subRest[0];
      if (event === undefined) {
        err("Usage: leina harness hook <event>   (payload JSON on stdin)");
        process.exitCode = 2;
        break;
      }
      await runHarnessHookEvent(event, readStdin(), repoRoot);
      break;
    }
    case undefined:
    case "help":
      printHarnessHelp();
      break;
    default:
      err(`unknown harness sub-command "${sub}"`);
      printHarnessHelp();
      process.exitCode = 1;
  }
}
