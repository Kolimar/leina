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
import { type HarnessPorts } from "../../domain/harness/ports.ts";
import { matchesAny } from "../../domain/harness/glob.ts";
import { trustStoreDir } from "../install/trust.ts";
import { loadConfig, userHarnessDir } from "./config-io.ts";
import { ensureStateDir, loadContract, stateDir } from "./contract-io.ts";
import { filterRules, loadResolvedRules } from "./resolver.ts";
import { readJsonIfExists } from "./io.ts";
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

export function payloadCommand(payload: HookPayload): string | undefined {
  const fromTool = toolInput(payload).command;
  if (typeof fromTool === "string" && fromTool.length > 0) return fromTool;
  const flat = payload.command;
  return typeof flat === "string" && flat.length > 0 ? flat : undefined;
}

// ---------------------------------------------------------------------------
// Retry counter — persisted under .harness/state/current/ so the stop gate's
// cap survives across hook invocations of the same task.
// ---------------------------------------------------------------------------

function retriesPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), "retries.json");
}

async function readRetries(repoRoot: string): Promise<number> {
  const raw = await readJsonIfExists(retriesPath(repoRoot));
  const count = (raw.value as { count?: unknown } | undefined)?.count;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

async function writeRetries(repoRoot: string, count: number): Promise<void> {
  await ensureStateDir(repoRoot);
  await fs.writeFile(retriesPath(repoRoot), `${JSON.stringify({ count })}\n`, "utf8");
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

export type PreDecision = { block: false } | { block: true; message: string };

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
 * Freshness signal for the commit guard: every edit the harness ALLOWS
 * touches this marker BEFORE the edit lands, so a verify report written
 * earlier than the marker is provably older than the working tree. This is
 * what catches the Edit/Write tool path (including brand-new files) that the
 * git mtime signals miss until `git add` runs. Best-effort — a failed touch
 * must never turn into a blocked edit.
 */
async function touchLastEdit(repoRoot: string): Promise<void> {
  try {
    await ensureStateDir(repoRoot);
    await fs.writeFile(path.join(stateDir(repoRoot), "last-edit"), `${new Date().toISOString()}\n`, "utf8");
  } catch {
    // best-effort marker
  }
}

export async function decidePreEdit(repoRoot: string, filePath: string | undefined): Promise<PreDecision> {
  const decision = await decidePreEditInner(repoRoot, filePath);
  if (!decision.block && filePath !== undefined && filePath.length > 0) {
    const rel = repoRelative(repoRoot, filePath);
    if (!rel.startsWith("..")) await touchLastEdit(repoRoot);
  }
  return decision;
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

async function decidePreEditInner(repoRoot: string, filePath: string | undefined): Promise<PreDecision> {
  if (filePath === undefined || filePath.length === 0) return ALLOW;

  const userHit = await userIntegrityHit(path.resolve(repoRoot, filePath));
  if (userHit !== undefined) {
    return {
      block: true,
      message:
        `BLOCKED: ${filePath} is under ${userHit} (user-level harness rules/config or workspace ` +
        "trust) and is agent-read-only. Change it through `leina` commands driven by a human. " +
        "Do not modify the harness to get past a gate.",
    };
  }

  const rel = repoRelative(repoRoot, filePath);
  if (rel.startsWith("..")) return ALLOW; // outside the repo — not ours to police

  const [{ config, errors: configErrors }, { contract }] = await Promise.all([
    loadConfig(repoRoot),
    loadContract(repoRoot),
  ]);

  // Task state is always writable — plan.md, checklists, contract amendments.
  if (matchesAny(rel, [".harness/state/**"])) return ALLOW;

  // Enforcement integrity: rules, config and lockfile define the gates
  // themselves. Weakening them to get past a gate is the obvious escape
  // hatch, so these are agent-read-only in EVERY strictness mode — the CLI
  // (`leina harness` / the TUI), driven by a human, is the writing path.
  // Coverage honesty: this seals the Edit/Write tool path; the Bash path is
  // guarded best-effort by decidePreBash (writesIntegrityPaths). Together
  // they raise the bar against accidents — they are not a sandbox.
  const integrity = [".harness/rules/**", ".harness/config.json", ".harness/config.local.json", ".harness/harness.lock.json"];
  if (matchesAny(rel, integrity)) {
    return {
      block: true,
      message:
        `BLOCKED: ${rel} defines the harness gates and is agent-read-only. ` +
        "Rules and config change through `leina harness` commands driven by a human. " +
        "Do not modify the harness to get past a gate.",
    };
  }

  if (configErrors.length > 0) return invalidConfigBlock(configErrors);

  // The rest of .harness/ (generated files, future additions): strict seals it.
  if (matchesAny(rel, [".harness/**"]) && config.strictness === "strict") {
    return {
      block: true,
      message:
        `BLOCKED: ${rel} is harness-managed and strictness is "strict". ` +
        "Do not modify the harness to get past a gate.",
    };
  }

  if (!contract) {
    if (config.strictness === "strict") {
      return {
        block: true,
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
      message:
        `BLOCKED: ${rel} matches the contract's outOfScope [${contract.outOfScope.join(", ")}]. ` +
        "This area was explicitly declared off-limits for this task.",
    };
  }

  return ALLOW;
}

interface ShellToken {
  text: string;
  /** Any character of this token came from inside quotes. */
  quoted: boolean;
}

/**
 * Minimal quote-aware split: segments on UNQUOTED `&&`/`||`/`;`/`|`/newline,
 * tokens on unquoted whitespace. Not a shell parser — no expansion, no
 * subshell tracking — just enough structure for the guards below.
 */
function shellSegments(command: string): ShellToken[][] {
  const segments: ShellToken[][] = [];
  let tokens: ShellToken[] = [];
  let current = "";
  let quoted = false;
  let mode: '"' | "'" | undefined;

  const pushToken = () => {
    if (current.length > 0 || quoted) tokens.push({ text: current, quoted });
    current = "";
    quoted = false;
  };
  const pushSegment = () => {
    pushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (mode === "'") {
      if (ch === "'") mode = undefined;
      else current += ch;
      continue;
    }
    if (mode === '"') {
      if (ch === '"') mode = undefined;
      else if (ch === "\\" && i + 1 < command.length) current += command[(i += 1)];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      mode = ch;
      quoted = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[(i += 1)];
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === "|") {
      pushSegment();
      if (command[i + 1] === "|") i += 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      pushSegment();
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    current += ch;
  }
  pushSegment();
  return segments;
}

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const OUTPUT_ONLY = new Set(["echo", "printf"]);

function basenameOf(program: string): string {
  const slash = program.lastIndexOf("/");
  return slash === -1 ? program : program.slice(slash + 1);
}

/**
 * Best-effort git commit/push detection: per pipeline segment, an UNQUOTED
 * `git` program token whose first non-flag argument is `commit`/`push`
 * (quoted or not — the shell would still run it). Recurses into `sh -c '…'`
 * payloads; skips `echo`/`printf` segments (their arguments are data).
 *
 * This is NOT a shell parser: variable expansion (`git $x`), command
 * substitution and exotic nesting evade it. The harness is a guardrail
 * against accidents, not a sandbox against an adversarial agent — see
 * docs/concepts/07-harness.md.
 */
/**
 * Within a single shell segment, find the git subcommand (commit/push) if the
 * segment invokes `git` directly. Skips git's own global flags (some consume a
 * value); stops at the first non-flag token — that is the subcommand.
 */
function gitSubcommandOf(tokens: ShellToken[]): "commit" | "push" | undefined {
  const gitIdx = tokens.findIndex((t) => !t.quoted && (t.text === "git" || t.text.endsWith("/git")));
  if (gitIdx === -1) return undefined;
  for (let i = gitIdx + 1; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (!t.quoted && (t.text === "-c" || t.text === "-C" || t.text === "--git-dir" || t.text === "--work-tree")) {
      i += 1; // these global flags consume a value
      continue;
    }
    if (!t.quoted && t.text.startsWith("-")) continue; // other global flags
    if (t.text === "commit" || t.text === "push") return t.text;
    break; // some other subcommand — this segment is not a commit/push
  }
  return undefined;
}

function gitCommitOrPush(command: string, depth = 0): "commit" | "push" | undefined {
  if (depth > 3) return undefined;
  for (const tokens of shellSegments(command)) {
    const first = tokens[0];
    if (first !== undefined && !first.quoted && OUTPUT_ONLY.has(basenameOf(first.text))) continue;
    if (first !== undefined && !first.quoted && SHELL_WRAPPERS.has(basenameOf(first.text))) {
      const payload = tokens.slice(1).find((t) => t.quoted);
      if (payload) {
        const inner = gitCommitOrPush(payload.text, depth + 1);
        if (inner !== undefined) return inner;
      }
    }
    const sub = gitSubcommandOf(tokens);
    if (sub !== undefined) return sub;
  }
  return undefined;
}

/**
 * Enforcement-integrity paths (see decidePreEdit) reached through the shell:
 * the same escape hatch through another door. Blocks commands that BOTH
 * mention an integrity path (anything under .harness/ except state/) AND look
 * like a write — a redirection or a mutating program anywhere in the command.
 * Read-only mentions (cat, grep, diff …) stay allowed. Best-effort by the
 * same honesty rule as gitCommitOrPush: this raises the bar for accidents,
 * it does not make the files unwritable for a determined agent.
 */
const INTEGRITY_PATH_RE = /\.harness(?!\/state\b)[\w./-]*/;
// The user-level harness and trust store (see userIntegrityDirs) in the forms a
// command usually spells them: ~/.leina/…, $LEINA_HOME/…, ${LEINA_HOME}/….
const USER_INTEGRITY_PATH_RE = /(?:\.leina|\$\{?LEINA_HOME\}?)\/(?:harness|trust)\b[\w./-]*/;
const WRITE_HINT_RE = /(?:>|\b(?:tee|sed|mv|cp|rm|dd|truncate|ln|install|rsync|chmod|chown|sponge)\b)/;

function writesIntegrityPaths(command: string): string | undefined {
  const match =
    INTEGRITY_PATH_RE.exec(command)?.[0] ??
    USER_INTEGRITY_PATH_RE.exec(command)?.[0] ??
    userIntegrityDirs().find((dir) => command.includes(dir));
  if (match === undefined) return undefined;
  return WRITE_HINT_RE.test(command) ? match : undefined;
}

interface PersistedSummary {
  blockingFailures?: number;
}

interface VerifySummaryRead {
  /** Only set when the report is present AND fresh — a stale report yields nothing. */
  summary?: PersistedSummary;
  /** Report file exists and is fresher than every staleness signal. */
  present: boolean;
  /** Report file exists but the working tree moved on after it was written. */
  stale: boolean;
}

async function mtimeOf(p: string): Promise<number | undefined> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Hot-path bound: stat at most this many report-recorded files per commit guard check. */
const STALENESS_FILE_STAT_CAP = 500;

/**
 * Read the persisted verify report FOR THE COMMIT GUARD, treating it as
 * absent when it is STALE. Without this, guided mode would honor a green
 * report from before the agent introduced a failure (or a red report from
 * before the fix) — "commit only when the gates pass" must not trust
 * yesterday's verdict.
 *
 * Freshness criterion (documented, best-effort): the report's mtime must be
 * >= the newest of
 *   - .git/index, .git/HEAD, .git/logs/HEAD
 *                                       (stage / commit / checkout after verify —
 *                                        the reflog moves on every commit),
 *   - state/last-edit                   (marker touched by every allowed
 *                                        Edit/Write — covers new files too),
 *   - state/edit-log.jsonl              (Cursor afterFileEdit log),
 *   - the files the report itself recorded as changed (post-verify re-edits;
 *     capped at STALENESS_FILE_STAT_CAP, missing files are no-signal since
 *     deletions legitimately appear in a diff).
 * Known gap: a brand-new file written through the SHELL and committed in a
 * single `git add && git commit` command evades every signal above (the
 * guard fires before `git add` updates the index). The harness is a
 * guardrail against accidents, not a sandbox — see docs/concepts/07-harness.md.
 */
async function readVerifySummary(repoRoot: string): Promise<VerifySummaryRead> {
  const reportPath = path.join(stateDir(repoRoot), "verify-report.json");
  const report = await readJsonIfExists(reportPath);
  if (report.value === undefined) return { present: false, stale: false };
  const value = report.value as { summary?: PersistedSummary; changedFiles?: unknown };

  const reportMtime = await mtimeOf(reportPath);
  if (reportMtime !== undefined) {
    const recorded = Array.isArray(value.changedFiles)
      ? value.changedFiles
          .filter((f): f is string => typeof f === "string")
          .slice(0, STALENESS_FILE_STAT_CAP)
          .map((f) => path.join(repoRoot, f))
      : [];
    const signals = await Promise.all(
      [
        path.join(repoRoot, ".git", "index"),
        path.join(repoRoot, ".git", "HEAD"),
        path.join(repoRoot, ".git", "logs", "HEAD"),
        path.join(stateDir(repoRoot), "last-edit"),
        path.join(stateDir(repoRoot), "edit-log.jsonl"),
        ...recorded,
      ].map(mtimeOf),
    );
    const newest = Math.max(0, ...signals.filter((s): s is number => s !== undefined));
    if (newest > reportMtime) return { present: false, stale: true };
  }

  return {
    ...(value.summary !== undefined ? { summary: value.summary } : {}),
    present: true,
    stale: false,
  };
}

export async function decidePreBash(repoRoot: string, command: string | undefined): Promise<PreDecision> {
  if (command === undefined) return ALLOW;

  const integrityHit = writesIntegrityPaths(command);
  if (integrityHit !== undefined) {
    return {
      block: true,
      message:
        `BLOCKED: this command appears to write to ${integrityHit} — harness rules, config and ` +
        "lockfile are agent-read-only (they define the gates). Change them through " +
        "`leina harness` commands driven by a human. Task state under .harness/state/ stays writable.",
    };
  }

  const action = gitCommitOrPush(command);
  if (action === undefined) return ALLOW;

  const { config, errors: configErrors } = await loadConfig(repoRoot);
  if (configErrors.length > 0) return invalidConfigBlock(configErrors);

  // A STALE report reads as absent: guided mode stops trusting an outdated
  // green (or blocking on an outdated red); strict mode demands a re-verify.
  const { summary, present, stale } = await readVerifySummary(repoRoot);

  if (summary && typeof summary.blockingFailures === "number" && summary.blockingFailures > 0) {
    return {
      block: true,
      message:
        `BLOCKED: git ${action} while ${summary.blockingFailures} blocking gate(s) are failing. ` +
        "Run `leina harness verify`, fix the failing gates, and only then commit.",
    };
  }

  if (!present && config.strictness === "strict") {
    return {
      block: true,
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
// ---------------------------------------------------------------------------

export type StopDecision =
  | { kind: "allow" }
  | { kind: "yield"; message: string }
  | { kind: "block"; reason: string };

/**
 * Hard ceiling on contract.maxRetries. The contract file lives in gitignored
 * state but can be force-committed, so a hostile/typo'd value must not be able
 * to extend the Stop-block loop unboundedly. Floored at 0 (yield immediately),
 * non-finite values fall back to the default of 3.
 */
const MAX_RETRIES_CAP = 10;

function effectiveMaxRetries(declared: number | undefined): number {
  if (typeof declared !== "number" || !Number.isFinite(declared)) return 3;
  return Math.min(Math.max(Math.trunc(declared), 0), MAX_RETRIES_CAP);
}

export async function decideStop(
  repoRoot: string,
  ports: HarnessPorts,
  stopHookActive: boolean,
): Promise<StopDecision> {
  if (stopHookActive) return { kind: "allow" }; // we are already the blocker — never loop

  const { contract } = await loadContract(repoRoot);
  const maxRetries = effectiveMaxRetries(contract?.maxRetries);
  const retries = await readRetries(repoRoot);

  if (retries >= maxRetries) {
    await writeRetries(repoRoot, 0);
    return {
      kind: "yield",
      message:
        `[harness] Gates still failing after ${maxRetries} attempts — allowing stop so a human can look. ` +
        "The last report is in .harness/state/current/verify-report.json. Do NOT treat this task as complete.",
    };
  }

  const outcome = await runVerify(repoRoot, { ports });

  if (outcome.exitCode === 2) {
    // Broken config must not trap the user in an unstoppable session.
    return { kind: "yield", message: `[harness] verify could not run: ${outcome.loadErrors.join("; ")}` };
  }

  if (outcome.exitCode === 0) {
    await writeRetries(repoRoot, 0);
    return { kind: "allow" };
  }

  await writeRetries(repoRoot, retries + 1);
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

export async function decideCursorShell(
  repoRoot: string,
  command: string | undefined,
): Promise<CursorShellDecision> {
  if (command === undefined) return { permission: "allow" };

  const integrityHit = writesIntegrityPaths(command);
  if (integrityHit !== undefined) {
    return {
      permission: "deny",
      agentMessage:
        `write to ${integrityHit} denied: harness rules/config are agent-read-only. ` +
        "Change them through `leina harness` commands driven by a human.",
      userMessage: "harness: blocked a shell write to harness rules/config",
    };
  }

  const action = gitCommitOrPush(command);
  if (action === undefined) return { permission: "allow" };

  // readVerifySummary yields no summary for a STALE report — same "treat as
  // absent" rule as decidePreBash, so an outdated verdict never decides.
  const { summary } = await readVerifySummary(repoRoot);
  if (summary && typeof summary.blockingFailures === "number" && summary.blockingFailures > 0) {
    return {
      permission: "deny",
      agentMessage:
        `git ${action} denied: ${summary.blockingFailures} blocking harness gate(s) are failing. ` +
        "Run `leina harness verify`, fix every failing gate using its report, and commit only when it exits 0.",
      userMessage: "harness: commit blocked while verification gates are failing",
    };
  }
  return { permission: "allow" };
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
