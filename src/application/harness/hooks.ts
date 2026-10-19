// application/harness/hooks.ts — hook-event ENFORCEMENT decisions, ported from
// the origin harness-framework's cli/commands/hook.ts. This is the single
// place where "what should happen on this hook event" is decided, so the
// generated platform wiring (cursor/windsurf/opencode via `leina harness hook`)
// and leina's own agent-gate branch never drift apart.
//
// Pure application logic: every function returns a TYPED decision and performs
// no process.exit and no stdout/stderr writes — the transports
// (cli/handlers/harness.ts for `leina harness hook <event>`, cli/agent-gate.ts
// for the host-neutral agent hooks) own the per-host output protocol.
// Process/git access is injected through HarnessPorts where needed (stop /
// advisory verify); everything else is plain fs + pure glob matching.

import path from "node:path";
import fs from "node:fs/promises";
import { MAX_RETRIES_CAP } from "../../domain/harness/model.ts";
import { type GitPort, type HarnessPorts } from "../../domain/harness/ports.ts";
import { matchesAny } from "../../domain/harness/glob.ts";
import { trustStoreDir } from "../install/trust.ts";
import { loadConfig, userHarnessDir } from "./config-io.ts";
import { ensureStateDir, loadContract, stateDir } from "./contract-io.ts";
import { filterRules, loadResolvedRules } from "./resolver.ts";
import { readJsonIfExists } from "./io.ts";
import { worktreeMatches } from "./freshness.ts";
import { gitCommitOrPush, shellWriteTargets } from "./shell-words.ts";
import { runVerify } from "./verify.ts";
import { renderFeedback } from "./gates/report.ts";

export const HOOK_EVENTS = [
  "session-start",
  "pre-edit",
  "pre-bash",
  "stop",
  "cursor-shell",
  "cursor-after-edit",
  "cursor-stop",
  "idle",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Payload helpers — hook payloads arrive as loose JSON; these tolerate both
// the Claude Code shape ({ tool_input: { file_path } }) and the flat Cursor
// shape ({ file_path }). Unknown/missing fields simply yield undefined.
// ---------------------------------------------------------------------------

export type HookPayload = Record<string, unknown>;

function toolInput(payload: HookPayload): Record<string, unknown> {
  const ti = payload.tool_input;
  return typeof ti === "object" && ti !== null ? (ti as Record<string, unknown>) : {};
}

export function payloadFilePath(payload: HookPayload): string | undefined {
  const fromTool = toolInput(payload).file_path;
  if (typeof fromTool === "string" && fromTool.length > 0) return fromTool;
  const flat = payload.file_path;
  return typeof flat === "string" && flat.length > 0 ? flat : undefined;
}

/** Claude Code's Stop chain marker; undefined when the host does not send one (see decideStop). */
export function payloadStopHookActive(payload: HookPayload): boolean | undefined {
  return typeof payload.stop_hook_active === "boolean" ? payload.stop_hook_active : undefined;
}

export function payloadCommand(payload: HookPayload): string | undefined {
  const fromTool = toolInput(payload).command;
  if (typeof fromTool === "string" && fromTool.length > 0) return fromTool;
  const flat = payload.command;
  return typeof flat === "string" && flat.length > 0 ? flat : undefined;
}

// ---------------------------------------------------------------------------
// Retry counter — how many times the CURRENT stop chain was blocked (see the
// stop section below), persisted under .harness/state/current/ because every
// Stop is a separate hook process.
// ---------------------------------------------------------------------------

function retriesPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), "retries.json");
}

async function readRetries(repoRoot: string): Promise<number> {
  try {
    const raw = await readJsonIfExists(retriesPath(repoRoot));
    const count = (raw.value as { count?: unknown } | undefined)?.count;
    return typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  } catch {
    return 0;
  }
}

/** Persist the counter; false when it could not be written. */
async function writeRetries(repoRoot: string, count: number): Promise<boolean> {
  try {
    await ensureStateDir(repoRoot);
    await fs.writeFile(retriesPath(repoRoot), `${JSON.stringify({ count })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * A new user turn opens a new stop chain: called on UserPromptSubmit so hosts
 * whose Stop payload carries no `stop_hook_active` do not carry blocks over
 * from an interrupted turn. No-op (no file created) when nothing is counted.
 */
export async function resetStopRetries(repoRoot: string): Promise<void> {
  if ((await readRetries(repoRoot)) > 0) await writeRetries(repoRoot, 0);
}

// ---------------------------------------------------------------------------
// session-start — deterministic context injection: contract status + the
// intake-phase rule bodies (blocking first). A weak model can ignore an
// instructions file; it cannot avoid what is already in its context.
// ---------------------------------------------------------------------------

export async function sessionStartContext(repoRoot: string): Promise<string> {
  const { contract } = await loadContract(repoRoot);
  const lines: string[] = ["[harness] This repository is governed by a harness."];
  if (contract) {
    lines.push(
      `Active task contract: goal="${contract.goal}"${contract.taskType ? ` type=${contract.taskType}` : ""}`,
      `Declared scope: ${contract.scope.length > 0 ? contract.scope.join(", ") : "(none declared)"}`,
      "Finish the contract before starting unrelated work; completion requires `leina harness verify` to exit 0.",
    );
    const ageMs = contract.createdAt ? Date.now() - Date.parse(contract.createdAt) : 0;
    if (ageMs > 24 * 60 * 60 * 1000) {
      lines.push(
        `WARNING: this contract is ${Math.round(ageMs / 3_600_000)}h old and may belong to an abandoned task. ` +
          "Confirm with the user whether to resume it or close it (`leina harness contract end` archives it, nothing is lost) " +
          "before starting new work — its scope will block unrelated edits.",
      );
    }
  } else {
    lines.push(
      "No active task contract. Before a non-trivial task, run:",
      '  leina harness contract new --goal "<goal>" --type <type> --scope "<glob>"',
      "Completion is defined by `leina harness verify` exiting 0.",
    );
  }

  const resolution = await loadResolvedRules(repoRoot);
  const intakeRules = filterRules(resolution.rules, { phases: ["intake"] }).sort((a, b) =>
    a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === "blocking" ? -1 : 1,
  );
  for (const rule of intakeRules) {
    lines.push("", `--- rule ${rule.id} [${rule.severity}] ---`, rule.body.trim());
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// pre-edit / pre-bash — the hard gates. A `block: true` decision means the
// transport must refuse the tool call (exit 2 + stderr on Claude Code).
// ---------------------------------------------------------------------------

/**
 * `kind` says WHY a call is refused: "integrity" (a write to what defines the
 * gates) or "gate" (scope, contract, commit guard, config) — transports with a
 * separate user-facing line (Cursor) word it accordingly.
 */
export type PreDecision = { block: false } | { block: true; kind: "integrity" | "gate"; message: string };

const ALLOW: PreDecision = { block: false };

/**
 * Fail CLOSED on config errors: loadConfig falls back to the built-in defaults
 * (guided) when a layer is invalid, so trusting that fallback would let one
 * broken file — e.g. config.local.json `{"verify":{"parallelism":0}}` — turn a
 * strict repo's hard gates into allows.
 */
function invalidConfigBlock(errors: string[]): PreDecision {
  return {
    block: true,
    kind: "gate",
    message:
      `BLOCKED: the harness config is invalid, so its enforcement cannot be evaluated: ${errors.join("; ")}. ` +
      "A human must fix it (.harness/config.json, .harness/config.local.json or the user config under " +
      "$LEINA_HOME/harness/); `leina harness verify` reports the same error.",
  };
}

function repoRelative(repoRoot: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  return path.relative(repoRoot, abs).replaceAll("\\", "/");
}

/**
 * User-level enforcement state OUTSIDE the repo: $LEINA_HOME/harness (user rules
 * + config — the user layers of every repo's resolution) and the workspace trust
 * store (where the harness runs at all). Agent-read-only like .harness/rules.
 */
function userIntegrityDirs(): string[] {
  return [userHarnessDir(), trustStoreDir()];
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/** The user integrity dir `abs` falls in, if any (lexical and symlink-resolved). */
async function userIntegrityHit(abs: string): Promise<string | undefined> {
  const candidates = [abs, await realpathOrSelf(abs)];
  for (const dir of userIntegrityDirs()) {
    for (const base of [path.resolve(dir), await realpathOrSelf(dir)]) {
      if (candidates.some((c) => c === base || c.startsWith(`${base}${path.sep}`))) return dir;
    }
  }
  return undefined;
}

/**
 * Whether the FULL hook enforcement applies to a repo with no active contract:
 * in strict mode (working without a contract is itself what strict forbids),
 * or when the config cannot be read (fail closed — the strictness is unknown).
 * Otherwise only the integrity seal applies. Used by the agent gate, whose
 * harness branch is otherwise keyed on an active contract.
 */
export async function enforcesWithoutContract(repoRoot: string): Promise<boolean> {
  const { config, errors } = await loadConfig(repoRoot);
  return errors.length > 0 || config.strictness === "strict";
}

/**
 * The integrity seal for the Edit/Write tool path, on its own: rules, config
 * and lockfile define the gates themselves. Weakening them to get past a gate
 * is the obvious escape hatch, so these are agent-read-only in EVERY
 * strictness mode, with or without a contract — the CLI (`leina harness` /
 * the TUI), driven by a human, is the writing path. The user-level harness and
 * trust store get the same seal. Coverage honesty: this seals the Edit/Write
 * tool path; the Bash path is guarded best-effort by decideIntegrityBash.
 * Together they raise the bar against accidents — they are not a sandbox.
 */
export async function decideIntegrityEdit(repoRoot: string, filePath: string | undefined): Promise<PreDecision> {
  if (filePath === undefined || filePath.length === 0) return ALLOW;

  const userHit = await userIntegrityHit(path.resolve(repoRoot, filePath));
  if (userHit !== undefined) {
    return {
      block: true,
      kind: "integrity",
      message:
        `BLOCKED: ${filePath} is under ${userHit} (user-level harness rules/config or workspace ` +
        "trust) and is agent-read-only. Change it through `leina` commands driven by a human. " +
        "Do not modify the harness to get past a gate.",
    };
  }

  const rel = repoRelative(repoRoot, filePath);
  const integrity = [".harness/rules/**", ".harness/config.json", ".harness/config.local.json", ".harness/harness.lock.json"];
  if (!rel.startsWith("..") && matchesAny(rel, integrity)) {
    return {
      block: true,
      kind: "integrity",
      message:
        `BLOCKED: ${rel} defines the harness gates and is agent-read-only. ` +
        "Rules and config change through `leina harness` commands driven by a human. " +
        "Do not modify the harness to get past a gate.",
    };
  }
  return ALLOW;
}

export async function decidePreEdit(repoRoot: string, filePath: string | undefined): Promise<PreDecision> {
  const sealed = await decideIntegrityEdit(repoRoot, filePath);
  if (sealed.block || filePath === undefined || filePath.length === 0) return sealed;

  const rel = repoRelative(repoRoot, filePath);
  if (rel.startsWith("..")) return ALLOW; // outside the repo — not ours to police

  // Task state is always writable — plan.md, checklists, contract amendments.
  if (matchesAny(rel, [".harness/state/**"])) return ALLOW;

  const [{ config, errors: configErrors }, { contract }] = await Promise.all([
    loadConfig(repoRoot),
    loadContract(repoRoot),
  ]);

  if (configErrors.length > 0) return invalidConfigBlock(configErrors);

  // The rest of .harness/ (generated files, future additions): strict seals it.
  if (matchesAny(rel, [".harness/**"]) && config.strictness === "strict") {
    return {
      block: true,
      kind: "gate",
      message:
        `BLOCKED: ${rel} is harness-managed and strictness is "strict". ` +
        "Do not modify the harness to get past a gate.",
    };
  }

  if (!contract) {
    if (config.strictness === "strict") {
      return {
        block: true,
        kind: "gate",
        message:
          'BLOCKED: no active task contract and strictness is "strict". Declare one first:\n' +
          '  leina harness contract new --goal "<goal>" --type <type> --scope "<glob>"',
      };
    }
    return ALLOW;
  }

  if (contract.scope.length > 0 && !matchesAny(rel, contract.scope)) {
    return {
      block: true,
      kind: "gate",
      message:
        `BLOCKED: ${rel} is outside the declared contract scope [${contract.scope.join(", ")}]. ` +
        "Stay in scope, or amend the contract first with " +
        '`leina harness contract edit --add-scope "<glob>"` and state why. ' +
        `If this edit belongs to a DIFFERENT task than "${contract.goal}", close the old contract ` +
        "(`leina harness contract end`) and open a new one instead.",
    };
  }

  if (contract.outOfScope.length > 0 && matchesAny(rel, contract.outOfScope)) {
    return {
      block: true,
      kind: "gate",
      message:
        `BLOCKED: ${rel} matches the contract's outOfScope [${contract.outOfScope.join(", ")}]. ` +
        "This area was explicitly declared off-limits for this task.",
    };
  }

  return ALLOW;
}

/**
 * Enforcement-integrity paths (see decidePreEdit) reached through the shell:
 * the same escape hatch through another door. Blocks a command when one of
 * the paths it WRITES (shellWriteTargets: redirection targets and writer
 * operands — rm, mv, tee, cp's destination, sed -i, git checkout …) is an
 * integrity path: anything under .harness/ except state/, or the user-level
 * harness / trust store. A read that merely mentions one (cat, grep, diff,
 * cp's source) stays allowed, even next to an unrelated redirection.
 * Best-effort by the same honesty rule as gitCommitOrPush (shell-words.ts):
 * this raises the bar for accidents, it does not make the files unwritable
 * for a determined agent.
 */
const HARNESS_PATH_RE = /(?:^|\/)\.harness(?:\/|$)/;
const HARNESS_STATE_RE = /(?:^|\/)\.harness\/state(?:\/|$)/;
// The user-level harness and trust store (see userIntegrityDirs) in the forms a
// command usually spells them: ~/.leina/…, $LEINA_HOME/…, ${LEINA_HOME}/….
const USER_INTEGRITY_PATH_RE = /(?:\.leina|\$\{?LEINA_HOME\}?)\/(?:harness|trust)\b/;

function isIntegrityPath(target: string): boolean {
  const norm = path.posix.normalize(target.replaceAll("\\", "/"));
  if (HARNESS_PATH_RE.test(norm) && !HARNESS_STATE_RE.test(norm)) return true;
  if (USER_INTEGRITY_PATH_RE.test(norm)) return true;
  return userIntegrityDirs().some((dir) => norm === dir || norm.startsWith(`${dir}/`));
}

function writesIntegrityPaths(command: string): string | undefined {
  return shellWriteTargets(command).find(isIntegrityPath);
}

interface PersistedSummary {
  blockingFailures?: number;
}

interface VerifySummaryRead {
  /** Only set when the report is present AND fresh — a stale report yields nothing. */
  summary?: PersistedSummary;
  /** Report file exists and still describes the current working tree. */
  present: boolean;
  /** Report file exists but the working tree is not the one it judged (or it cannot tell). */
  stale: boolean;
}

/**
 * Read the persisted verify report FOR THE COMMIT GUARD, treating it as
 * absent when it is STALE. Without this, guided mode would honor a green
 * report from before the agent introduced a failure (or a red report from
 * before the fix) — "commit only when the gates pass" must not trust
 * yesterday's verdict.
 *
 * Freshness is content-based (freshness.ts): the report carries the
 * working-tree fingerprint verify recorded, and it is fresh only while the
 * recomputed fingerprint matches — same changed-file set against the recorded
 * base, same content per file. Read-only git commands (which rewrite
 * .git/index) and writes to task state or leina's own artifacts do not stale
 * it; any change to the tree the gates judged — through the Edit tool or the
 * shell, staged or not, new or deleted files included — does. A report
 * without a fingerprint (older leina, hand-written) cannot vouch for any tree
 * and reads as stale.
 */
async function readVerifySummary(repoRoot: string, git: GitPort): Promise<VerifySummaryRead> {
  const report = await readJsonIfExists(path.join(stateDir(repoRoot), "verify-report.json"));
  if (report.value === undefined) return { present: false, stale: false };
  const value = report.value as { summary?: PersistedSummary; worktree?: unknown };
  if (!(await worktreeMatches(repoRoot, git, value.worktree))) return { present: false, stale: true };
  return {
    ...(value.summary !== undefined ? { summary: value.summary } : {}),
    present: true,
    stale: false,
  };
}

/** The integrity seal for the shell path (see decideIntegrityEdit), on its own. */
export function decideIntegrityBash(command: string | undefined): PreDecision {
  const integrityHit = command !== undefined ? writesIntegrityPaths(command) : undefined;
  if (integrityHit === undefined) return ALLOW;
  return {
    block: true,
    kind: "integrity",
    message:
      `BLOCKED: this command appears to write to ${integrityHit} — harness rules, config and ` +
      "lockfile are agent-read-only (they define the gates). Change them through " +
      "`leina harness` commands driven by a human. Task state under .harness/state/ stays writable.",
  };
}

export async function decidePreBash(
  repoRoot: string,
  command: string | undefined,
  git: GitPort,
): Promise<PreDecision> {
  if (command === undefined) return ALLOW;

  const sealed = decideIntegrityBash(command);
  if (sealed.block) return sealed;

  const action = gitCommitOrPush(command);
  if (action === undefined) return ALLOW;

  const { config, errors: configErrors } = await loadConfig(repoRoot);
  if (configErrors.length > 0) return invalidConfigBlock(configErrors);

  // A STALE report reads as absent: guided mode stops trusting an outdated
  // green (or blocking on an outdated red); strict mode demands a re-verify.
  const { summary, present, stale } = await readVerifySummary(repoRoot, git);

  if (summary && typeof summary.blockingFailures === "number" && summary.blockingFailures > 0) {
    return {
      block: true,
      kind: "gate",
      message:
        `BLOCKED: git ${action} while ${summary.blockingFailures} blocking gate(s) are failing. ` +
        "Run `leina harness verify`, fix the failing gates, and only then commit.",
    };
  }

  if (!present && config.strictness === "strict") {
    return {
      block: true,
      kind: "gate",
      message: stale
        ? "BLOCKED: the verify report is stale — the working tree changed after it was written. " +
          "Run `leina harness verify` again before committing."
        : 'BLOCKED: no verify report found and strictness is "strict". ' +
          "Run `leina harness verify` before committing.",
    };
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// stop — the completion gate. Failing blocking gates → block with the gate
// report as the model's next instruction; a retry cap keeps the loop honest
// instead of infinite (when exhausted, it YIELDS with an honest summary).
//
// Semantics of the cap — `maxRetries` = how many times ONE stop chain may be
// blocked. A chain is the run of Stop events from the agent's first attempt
// to end its turn until a stop is allowed:
//   - Claude Code marks a continuation with `stop_hook_active: true`, so
//     `false` opens a new chain and resets the counter (a red verify from the
//     previous turn never eats into this one); hosts that send no flag keep
//     counting across stops, and their UserPromptSubmit (resetStopRetries)
//     opens the new turn instead.
//   - EVERY stop runs a fresh verify: a pass allows and resets; a failure
//     blocks while the chain is under the cap, and at the cap yields — with
//     the failure just observed, never a stale claim — and resets.
//   - If the counter cannot be persisted the loop could not be bounded, so
//     the stop yields instead of blocking.
// ---------------------------------------------------------------------------

export type StopDecision =
  | { kind: "allow" }
  | { kind: "yield"; message: string }
  | { kind: "block"; reason: string };

/**
 * contract.maxRetries capped at MAX_RETRIES_CAP. The contract file lives in
 * gitignored state but can be force-committed, so a hostile/typo'd value must
 * not be able to extend the Stop-block loop unboundedly. Floored at 0 (yield
 * immediately), non-finite values fall back to the default of 3.
 */
function effectiveMaxRetries(declared: number | undefined): number {
  if (typeof declared !== "number" || !Number.isFinite(declared)) return 3;
  return Math.min(Math.max(Math.trunc(declared), 0), MAX_RETRIES_CAP);
}

/**
 * @param stopHookActive the host's chain marker: `false` = first stop of a new
 *   chain, `true` = a continuation after a block, `undefined` = the host does
 *   not say (the persisted counter carries the chain).
 */
export async function decideStop(
  repoRoot: string,
  ports: HarnessPorts,
  stopHookActive: boolean | undefined,
): Promise<StopDecision> {
  const { contract } = await loadContract(repoRoot);
  const maxRetries = effectiveMaxRetries(contract?.maxRetries);
  const blocked = stopHookActive === false ? 0 : await readRetries(repoRoot);

  const outcome = await runVerify(repoRoot, { ports });

  if (outcome.exitCode === 2) {
    // Broken config must not trap the user in an unstoppable session.
    await writeRetries(repoRoot, 0);
    return { kind: "yield", message: `[harness] verify could not run: ${outcome.loadErrors.join("; ")}` };
  }

  if (outcome.exitCode === 0) {
    await writeRetries(repoRoot, 0);
    return { kind: "allow" };
  }

  const failing = outcome.report.results
    .filter((r) => r.severity === "blocking" && (r.status === "fail" || r.status === "error" || r.status === "timeout"))
    .map((r) => r.ruleId);
  const failingNow =
    `${outcome.report.summary.blockingFailures} blocking gate(s) failing in the verify just run ` +
    `(${[...new Set(failing)].join(", ")}).`;

  if (blocked >= maxRetries) {
    await writeRetries(repoRoot, 0);
    return {
      kind: "yield",
      message:
        `[harness] Gates still failing after ${maxRetries} attempts — allowing stop so a human can look. ` +
        `${failingNow} The report is in .harness/state/current/verify-report.json. ` +
        "Do NOT treat this task as complete.",
    };
  }

  if (!(await writeRetries(repoRoot, blocked + 1))) {
    return {
      kind: "yield",
      message:
        `[harness] ${failingNow} The retry counter could not be saved, so the stop is not blocked again ` +
        "(an unbounded loop is worse) — allowing stop so a human can look. Do NOT treat this task as complete.",
    };
  }
  return { kind: "block", reason: renderFeedback(outcome.report) };
}

// ---------------------------------------------------------------------------
// Cursor protocol — beforeShellExecution answers on stdout with
// {"permission":"deny",...} (a real hard commit gate); afterFileEdit accrues
// the edit log the scope-audit can inspect.
// ---------------------------------------------------------------------------

export type CursorShellDecision =
  | { permission: "allow" }
  | { permission: "deny"; agentMessage: string; userMessage: string };

/**
 * Cursor's shell permission is the SAME decision as decidePreBash — integrity
 * seal, commit guard with its freshness and strictness rules, config errors —
 * mapped to Cursor's protocol, so the two hosts cannot drift apart.
 */
export async function decideCursorShell(
  repoRoot: string,
  command: string | undefined,
  git: GitPort,
): Promise<CursorShellDecision> {
  const decision = await decidePreBash(repoRoot, command, git);
  if (!decision.block) return { permission: "allow" };
  return {
    permission: "deny",
    agentMessage: decision.message,
    userMessage:
      decision.kind === "integrity"
        ? "harness: blocked a shell write to harness rules/config"
        : "harness: git commit/push blocked until `leina harness verify` passes",
  };
}

export async function recordCursorEdit(repoRoot: string, filePath: string | undefined): Promise<void> {
  if (filePath === undefined || filePath.length === 0) return;
  await ensureStateDir(repoRoot);
  const entry = { file: repoRelative(repoRoot, filePath), at: new Date().toISOString() };
  await fs.appendFile(path.join(stateDir(repoRoot), "edit-log.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Advisory completion nudge for platforms without a blocking stop primitive
 * (Cursor stop hook, OpenCode session.idle): run verify, persist the report,
 * and return the feedback text ("" when everything passes).
 */
export async function advisoryVerifyFeedback(repoRoot: string, ports: HarnessPorts): Promise<string> {
  const outcome = await runVerify(repoRoot, { ports });
  return outcome.exitCode === 1 ? renderFeedback(outcome.report) : "";
}
