// agent-gate.ts — HOST-NEUTRAL agent hooks ADVISORY bridge.
//
// This module is host-neutral: it implements the freshness check + self-heal of the graph
// and the memory-advisory logic that runs when ANY supported agentic host (Devin, Claude
// Code, Windsurf, ...) fires a lifecycle hook. It carries no Devin-specific behaviour; the
// per-host wiring (which events are registered, on-disk hook config shape) lives in the
// install writers (e.g. application/install/devin-hooks.ts, claude-hooks.ts).
//
// History: the module was born as `devin-gate.ts` because Devin was the first host wired to
// it. Leina originally shipped two hook surfaces — Cascade (Windsurf editor) with the
// `hook` subcommand and Devin with `devin-hook`. The Windsurf editor migrated to the same
// on-disk shape as the Devin CLI (`.devin/hooks.v1.json`, PreToolUse / PostToolUse /
// UserPromptSubmit / SessionStart), so the Cascade-specific path was removed and the gate
// became the single shared entry point; it was later renamed to `agent-gate.ts` to reflect
// that. The CLI keeps `devin-hook` as a compatibility alias of `agent-hook` because
// already-emitted `.devin/hooks.v1.json` files invoke it by that name.
//
// Behaviour: ADVISORY only. The gate never returns exit 2 / block:true. A non-empty `reason`
// means "emit as a stderr nudge so the agent sees it in tool output"; nothing is blocked. The
// per-session marker short-circuits the advisory once a memory tool has been called, so a
// well-behaved agent sees the nudge at most once per fresh session.
//
// ALWAYS-ON CONTEXT: At SessionStart and PostCompaction, the gate actively injects real project
// memory observations + graph stats into the agent's additionalContext. The session marker is
// written only when injection is successfully delivered (`delivered===true`). On any failure,
// the gate falls back to a static advisory text (SESSION_START_CONTEXT) and does NOT write the
// marker — letting the PostToolUse/advisory path take over naturally.
//
// SCOPE-AWARE: runAgentGate early-returns 0 silently when the project root does not have
// the consent flag set to "enabled" (`.leina/consent`) or is not a TRUSTED workspace on
// this machine (the out-of-repo record `leina init` writes — a committed consent flag
// alone grants nothing). A user-global agent hook therefore stays completely quiet in any
// repo that isn't leina-initialized here. Repos with `.devin/hooks.v1.json` but no consent
// flag resolve to "unknown" — gate stays silent until the user explicitly consents via
// `leina init .`. This is what makes the gate safe to install user-globally without
// polluting unrelated projects.
//
// Honest scope: this is a workflow NUDGE, not a security control and not an obstacle. The
// project root is resolved by resolveHookProjectRoot(): it prefers Devin's documented
// `DEVIN_PROJECT_DIR` env var (the contract for telling a hook its workspace root — no hook
// stdin payload carries a cwd) and falls back to the process cwd when the var is absent.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildActiveContext } from "./active-context.ts";
import { spawnDetachedBuild } from "./background-build.ts";
import { graphDbPath } from "./wiring.ts";
import { isStale } from "../application/graph/manifest.ts";
import { readConsentFlag } from "../application/install/consent.ts";
import { isWorkspaceTrusted } from "../application/install/trust.ts";
import { type HookHost, type HookScope, isHookHost } from "../application/install/hook-command.ts";

// Running any of these `leina memory <sub>` CLI commands counts as "project memory
// loaded" for the session. Detected by inspecting the exec tool's command line (there is no
// MCP tool to key on in the CLI-only build).
export const MEMORY_LOAD_SUBCOMMANDS = new Set(["context", "search", "verified"]);

export const GATE_MESSAGE =
  "leina advisory: run `leina memory context <dir>` to load this project's " +
  "memory — decisions, conventions and SDD artifacts live there, so you don't re-derive " +
  "what's already saved. This is a nudge, not a block; proceed if you've decided memory isn't needed.";

// Steer the agent toward the graph CLI instead of grep, and still nudge memory context.
export const GREP_GATE_MESSAGE =
  "leina advisory: prefer `leina query <dir> \"<question>\"` / " +
  "`leina affected <dir> <symbol>` over grep for structural questions, and consider " +
  "`leina memory context <dir>` to restore project memory first. This is a nudge, not a block.";

// First-turn advisory: a fresh session is a good moment to load memory before reasoning
// about the repo. Paired with the SessionStart additionalContext below so the agent has the
// context before its first turn; this advisory is just a stderr reminder, never a block.
export const FIRST_TURN_GATE_MESSAGE =
  "leina advisory: fresh session — running `leina memory context <dir>` first " +
  "loads prior decisions, conventions and SDD artifacts so you don't reason about this repo " +
  "from scratch. This is a nudge, not a block.";

// Re-export types and constants from the extracted active-context module so existing
// call-sites that import from gate.ts continue to compile.
export { SESSION_START_CONTEXT, buildActiveContext } from "./active-context.ts";
export type { ActiveContextDeps, ActiveContextResult } from "./active-context.ts";

// ---------------------------------------------------------------------------
// Scope guard + pure decision
// ---------------------------------------------------------------------------

/**
 * Scope check: is `cwd` a leina-initialized project with explicit consent?
 *
 * Returns `true` ONLY when `.leina/consent` contains `"enabled"` — i.e. the
 * user has explicitly opted in via `leina init .`. Both `"disabled"` and
 * `"unknown"` (absent file) return `false`:
 *
 *   - `enabled`  → true  (active, full gate behavior)
 *   - `disabled` → false (user opted out, silent no-op)
 *   - `unknown`  → false (flag absent; includes legacy repos with `.devin/hooks.v1.json`
 *                         but no consent flag — gate stays silent until leina-setup
 *                         re-prompts once and the user opts in)
 *
 * Backed by `readConsentFlag` which is fail-safe: any I/O error → `"unknown"` → false.
 * Safe to call on every hook invocation.
 */
export function isLeinaProject(cwd: string): boolean {
  try {
    return readConsentFlag(cwd) === "enabled";
  } catch {
    return false;
  }
}

/**
 * Resolve the project root for a Devin hook invocation. Devin's documented contract sets the
 * workspace root in the `DEVIN_PROJECT_DIR` env var (Devin/Claude-compatible hooks docs); none
 * of the hook stdin payloads carry a cwd. We prefer that documented signal and fall back to the
 * process cwd (the historical behaviour) when the var is absent or blank. This is strictly
 * safer: correct when Devin exports the var, byte-for-byte identical to before when it doesn't.
 *
 * Pure function of its inputs — no `process.*` access — so it is fully unit-testable. The caller
 * (the `devin-hook` CLI branch) passes `process.env` and `process.cwd()`.
 */
export function resolveHookProjectRoot(env: NodeJS.ProcessEnv, fallbackCwd: string): string {
  // Host-neutral: Claude Code documents CLAUDE_PROJECT_DIR, Devin documents
  // DEVIN_PROJECT_DIR — same contract, different name. First non-blank wins.
  const claudeEnv = typeof env.CLAUDE_PROJECT_DIR === "string" ? env.CLAUDE_PROJECT_DIR.trim() : "";
  if (claudeEnv.length > 0) return claudeEnv;
  const fromEnv = typeof env.DEVIN_PROJECT_DIR === "string" ? env.DEVIN_PROJECT_DIR.trim() : "";
  return fromEnv.length > 0 ? fromEnv : fallbackCwd;
}

/** Which host fired the hook and which copy of the wiring it ran (see hook-command.ts). */
export interface AgentHookInvocation {
  event?: string;
  host: HookHost;
  scope: HookScope;
}

/**
 * Parse `agent-hook <Event> [--host claude|devin] [--scope user]`. The installers always
 * write `--host`; an entry without it (written before the flag existed) falls back to the
 * environment: Claude Code exports CLAUDE_PROJECT_DIR to its hooks, so its presence means
 * Claude Code, anything else is Devin (the only other host that runs these entries).
 */
export function parseAgentHookArgs(rest: string[], env: NodeJS.ProcessEnv): AgentHookInvocation {
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i < 0 ? undefined : rest[i + 1];
  };
  const explicit = flag("--host");
  const claudeEnv = typeof env.CLAUDE_PROJECT_DIR === "string" && env.CLAUDE_PROJECT_DIR.trim().length > 0;
  const event = rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : undefined;
  return {
    ...(event !== undefined ? { event } : {}),
    host: isHookHost(explicit) ? explicit : claudeEnv ? "claude" : "devin",
    scope: flag("--scope") === "user" ? "user" : "project",
  };
}

export interface AgentHookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: unknown; [k: string]: unknown };
  /** Claude Code Stop payloads: true when a Stop hook already blocked once. */
  stop_hook_active?: unknown;
  /** PostCompaction summary text — present but intentionally ignored; re-injection is unconditional. */
  summary?: string | null;
}

export interface AgentGateDecision {
  /**
   * Always false. Kept for shape stability with older callers, but the advisory gate never
   * blocks — a non-empty `reason` means "emit as a stderr nudge", not "stop the agent".
   */
  block: false;
  reason: string;
}

// Anchor at trimmed start so `echo "git commit"` is NOT a commit. \b after `commit` keeps
// `git commit-tree` / `git commit-graph` out.
const GIT_COMMIT_RE = /^\s*git\s+commit(?:\s|$)/;
// Whole-word match for the grep family anywhere in the command line.
const GREP_RE = /\b(rg|grep|find)\b/;

// Matches a `leina memory (context|search|verified) ...` invocation anywhere in an exec
// command line — the CLI-only signal that project memory was loaded this session.
const MEMORY_LOAD_CMD_RE = /leina\b[\s\S]*\bmemory\s+(context|search|verified)\b/;

// Matches a `leina memory (save|session|update) ...` invocation anywhere in an exec
// command line — the CLI-only signal that project memory was saved this session.
// Negative lookahead (?![-\w]) prevents false matches on `memory session-start` / `memory saved`
// / `memory updated` (subcommands that begin save|session|update but are NOT a save operation).
const MEMORY_SAVE_CMD_RE = /leina\b[\s\S]*\bmemory\s+(save|session|update)(?![-\w])/;

const DEVIN_MARKER_REL = ".leina/session.memory-loaded";

// Marker path for save-side loop closure (symmetric to DEVIN_MARKER_REL).
export const SAVE_MARKER_REL = ".leina/session.memory-saved";

// Marker for the one-shot retrospective native-search nudge (Palanca C, ADR-3).
// Reset at SessionStart alongside the other two; PostCompaction does NOT reset it.
export const NATIVE_NUDGE_MARKER_REL = ".leina/session.native-search-nudge-shown";

// Retrospective advisory emitted the first time a native grep/read/glob tool fires (Palanca C).
// Acknowledges the tool already ran (valid for locating specific content), then steers toward
// the graph CLI for structural questions. English; one-shot per session; never blocks.
export const NATIVE_SEARCH_NUDGE =
  "leina advisory: a native search/read tool just ran — that is valid for locating " +
  "specific strings or file content. For structural questions (\"what calls X?\", " +
  "\"what depends on Y?\") prefer `leina query <dir> \"<question>\"` next time; " +
  "run `leina affected <dir> <symbol>` before any rename or migration; and run " +
  "`leina memory search <dir> \"<query>\"` before re-deriving context that may " +
  "already be saved. One-time nudge per session — not a block; proceed as planned.";

// Advisory text emitted on Stop when the session.memory-saved marker is absent.
// Exported so tests can assert on the exact content or partial match.
export const STOP_SAVE_NUDGE =
  "leina advisory: before finishing, persist this session — run " +
  "`leina memory session <dir> --content \"...\"` for a session summary, or " +
  "`leina memory save <dir> --title ... --content ...` for a specific decision/discovery. " +
  "This is a one-time nudge, not a block; ignore it if nothing is worth saving.";

/**
 * Advisory reason for a PreToolUse event. Pure; no side effects. Extracted from
 * decideAgentGate to keep that function's cognitive complexity within budget.
 *
 * Returns the empty string when no advisory applies (the tool/command is benign).
 */
function preToolUseReason(tool: string | undefined, cmd: string): string {
  if (tool === "edit" || tool === "write") return GATE_MESSAGE;
  // Palanca A: native grep/glob tool (lowercase tool_name from Devin) → steer toward graph CLI.
  // Silenced by the same marker as all other PreToolUse advisories (preventive, consistent).
  if (tool === "grep" || tool === "glob") return GREP_GATE_MESSAGE;
  if (tool === "exec") {
    if (GIT_COMMIT_RE.test(cmd)) return GATE_MESSAGE;
    if (GREP_RE.test(cmd)) return GREP_GATE_MESSAGE;
  }
  return "";
}

/**
 * Pure decision for a parsed Devin hook payload. Output never carries side effects.
 * Marker fs writes/deletes are handled by runAgentGate.
 *
 * Never returns `block: true`. A non-empty `reason` means the I/O wrapper should emit a
 * stderr advisory; the agent still proceeds. The marker short-circuits all advisories so
 * a well-behaved session sees the nudge at most once per fresh session.
 */
export function decideAgentGate(
  payload: AgentHookPayload,
  markerExists: boolean,
): AgentGateDecision {
  // Once memory is loaded for this session, no advisories — short-circuit before any branching.
  if (markerExists) return { block: false, reason: "" };

  const event = payload.hook_event_name;
  const tool = payload.tool_name;
  const cmd =
    typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";

  if (event === "PreToolUse") return { block: false, reason: preToolUseReason(tool, cmd) };
  if (event === "UserPromptSubmit") {
    // First-turn advisory only. The SessionStart additionalContext (emitted by runAgentGate
    // below) already tells the agent the recommended flow, so this nudge is for agents that
    // ignored that hint — emitted on stderr, never blocking the user's prompt.
    return { block: false, reason: FIRST_TURN_GATE_MESSAGE };
  }
  // PostToolUse / SessionStart / PostCompaction never emit advisories — informational / state transitions.
  return { block: false, reason: "" };
}

// ---------------------------------------------------------------------------
// I/O wrapper
// ---------------------------------------------------------------------------

/**
 * Write the session marker at `markerPath`. Fails open (caught internally).
 */
function writeMarker(markerPath: string): void {
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, "memory-loaded\n");
  } catch {
    /* fail open — marker write failure is never fatal */
  }
}

/**
 * Pure decision: does the graph need a (re)build? True when graph.db is absent or the manifest
 * is stale. Fail-open: any error answers `false` so the self-heal never disrupts the session.
 * Extracted from maybeSelfHealGraph so the branch is unit-testable without spawning a process.
 */
export function graphNeedsBuild(cwd: string): boolean {
  try {
    return !existsSync(graphDbPath(cwd)) || isStale(cwd).stale;
  } catch {
    return false;
  }
}

/**
 * Fail-open self-heal: if graph.db is absent or manifest is stale, fire a detached build.
 * Never throws — any error is silently swallowed.
 */
function maybeSelfHealGraph(cwd: string): void {
  try {
    if (graphNeedsBuild(cwd)) spawnDetachedBuild(cwd);
  } catch {
    /* fail open */
  }
}

/**
 * I/O wrapper for the Devin hooks gate. Reads a payload from `rawStdin`, consults the
 * per-project session marker under `cwd`, applies side effects (marker write on a memory-load
 * PostToolUse, marker delete + re-arm on SessionStart, re-arm on PostCompaction), emits stderr
 * advisories when applicable, and always returns exit 0.
 *
 * SCOPE-AWARE: if `cwd` does not have the consent flag set to `"enabled"` (i.e. flag absent,
 * `"disabled"`, or `"unknown"` — which covers both fresh repos and legacy repos with only
 * `.devin/hooks.v1.json`), or has no workspace-trust record on this machine, returns 0
 * silently — no stderr advisories, no SessionStart additionalContext, no graph self-heal.
 * This is what lets a user-global Devin hook stay quiet in unrelated repos.
 *
 * Fails OPEN on every error path (malformed JSON, missing fields, fs errors) → exit 0.
 *
 * @param rawStdin       the JSON the hook received on stdin
 * @param cwd            project root; marker lives at `<cwd>/.leina/session.memory-loaded`
 * @param fallbackEvent  event name passed as the CLI arg, used if the payload omits it
 */

// Claude Code names its tools Bash/Grep/Read/Glob; the gate's decision logic speaks the
// Devin vocabulary (exec/grep/read/glob). Same semantics, different casing/name — mapped
// in place so ONE gate serves both hosts. Unknown names pass through untouched.
const HOST_TOOL_ALIASES: Record<string, string> = {
  Bash: "exec",
  Grep: "grep",
  Read: "read",
  Glob: "glob",
};

function normalizeHostToolNames(payload: AgentHookPayload): void {
  const mapped = payload.tool_name !== undefined ? HOST_TOOL_ALIASES[payload.tool_name] : undefined;
  if (mapped !== undefined) payload.tool_name = mapped;
}

export function runAgentGate(
  rawStdin: string,
  cwd: string,
  fallbackEvent?: string,
  harnessSessionContext?: string,
): void {
  // Scope guard: silent no-op unless consent=enabled. A user-global hook fires in every Devin
  // project on the machine; this keeps it quiet in repos without explicit consent (including
  // legacy repos with .devin/hooks.v1.json but no consent flag — those resolve to "unknown").
  // WORKSPACE TRUST as well: the consent flag lives in the repo, so a clone can commit
  // `.leina/consent = enabled`; without the out-of-repo record `leina init` writes on this
  // machine it gets the same silence as consent "unknown" — no memory/graph context
  // injection and no background `leina build` self-heal.
  if (!isLeinaProject(cwd) || !isWorkspaceTrusted(cwd)) return;

  const payload = parseHookPayload(rawStdin, fallbackEvent);
  if (!payload) return;
  normalizeHostToolNames(payload);

  const markerPath = join(cwd, DEVIN_MARKER_REL);
  const saveMarkerPath = join(cwd, SAVE_MARKER_REL);
  const event = payload.hook_event_name;

  // Palanca C: PostToolUse on native grep/read/glob → one-shot retrospective nudge.
  // DOES NOT check session.memory-loaded (ADR-2: that marker would silence it in Gap 2 —
  // the exact case where memory was already loaded yet the agent still used grep natively).
  if (event === "PostToolUse" &&
      (payload.tool_name === "grep" || payload.tool_name === "read" || payload.tool_name === "glob")) {
    emitNativeSearchNudge(cwd);
    return;
  }

  // Marker writes: PostToolUse on an exec that ran a leina memory command.
  // - Load RE (`context|search|verified`): flip the per-session memory-loaded marker.
  // - Save RE (`save|session|update`): flip the per-session memory-saved marker.
  // Subcommand sets are disjoint — both checks are independent and idempotent.
  // Done BEFORE decideAgentGate so the decision sees an up-to-date markerExists.
  if (event === "PostToolUse" && payload.tool_name === "exec") {
    handleMemoryMarkerWrites(commandOf(payload), markerPath, saveMarkerPath);
    return;
  }

  // SessionStart: reset BOTH markers (load + save) before injection runs. Per-session semantics:
  // a fresh session starts as "not loaded, not saved". Save marker is NEVER re-written at
  // SessionStart (only deleted here); load marker is re-armed when injection succeeds.
  if (event === "SessionStart") {
    maybeSelfHealGraph(cwd);
    emitInjectedContext(cwd, markerPath, saveMarkerPath, "SessionStart", true, harnessSessionContext);
    return;
  }

  // PostCompaction: re-inject context after a compaction event. No marker reset (unlike
  // SessionStart) — PostCompaction re-arms the existing marker. `summary` is intentionally
  // ignored; re-injection is unconditional (design §5).
  if (event === "PostCompaction") {
    emitInjectedContext(cwd, markerPath, saveMarkerPath, "PostCompaction", false);
    return;
  }

  // Stop: advisory nudge to persist session memory if the save marker is absent.
  // NFR-1: stdout MUST be empty. Advisory only — never blocks. Fail-open on fs errors.
  if (event === "Stop") {
    emitStopNudge(saveMarkerPath);
    return;
  }

  // UserPromptSubmit: active injection (one-shot, guarded by marker). If the marker is already
  // present (memory already loaded this session) → total silence. If absent → inject
  // additionalContext on stdout + write marker on delivery. No stderr advisory — the
  // stdout injection replaces it.
  if (event === "UserPromptSubmit") {
    emitUpsInjection(cwd, markerPath, saveMarkerPath);
    return;
  }

  emitAdvisory(payload, markerPath);
}

// Parse + validate the hook payload, applying the CLI-arg fallback event. Fails OPEN
// (empty/malformed JSON, missing fields) → returns null so the caller silently no-ops.
function parseHookPayload(rawStdin: string, fallbackEvent?: string): AgentHookPayload | null {
  if (!rawStdin?.trim()) return null;
  let payload: AgentHookPayload;
  try {
    payload = JSON.parse(rawStdin) as AgentHookPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (!payload.hook_event_name && fallbackEvent) payload.hook_event_name = fallbackEvent;
  return payload;
}

function commandOf(payload: AgentHookPayload): string {
  return typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
}

function handleMemoryMarkerWrites(postCmd: string, markerPath: string, saveMarkerPath: string): void {
  if (MEMORY_LOAD_CMD_RE.test(postCmd)) writeMarker(markerPath);
  if (MEMORY_SAVE_CMD_RE.test(postCmd)) writeMarker(saveMarkerPath);
}

// UserPromptSubmit injection wrapper. Guard: if the session marker is already present, return
// silently (injection already happened this session). If absent, delegate to emitInjectedContext
// with resetMarkers=false — injects additionalContext on stdout and re-arms the marker on
// delivery. Total silence when marker is present (stdout and stderr both empty).
function emitUpsInjection(cwd: string, markerPath: string, saveMarkerPath: string): void {
  try {
    if (existsSync(markerPath)) return; // marker present → total silence
  } catch {
    /* fail open: treat as absent and proceed to inject */
  }
  emitInjectedContext(cwd, markerPath, saveMarkerPath, "UserPromptSubmit", false);
}

// Build + emit the SessionStart/PostCompaction/UserPromptSubmit additionalContext JSON. When
// resetMarkers is true (SessionStart) both markers are deleted first; the load marker is
// re-armed on delivery.
function emitInjectedContext(
  cwd: string,
  markerPath: string,
  saveMarkerPath: string,
  eventName: "SessionStart" | "PostCompaction" | "UserPromptSubmit",
  resetMarkers: boolean,
  harnessSessionContext?: string,
): void {
  if (resetMarkers) {
    try {
      rmSync(markerPath, { force: true });
    } catch {
      /* fail open */
    }
    try {
      rmSync(saveMarkerPath, { force: true });
    } catch {
      /* fail open */
    }
    try {
      rmSync(join(cwd, NATIVE_NUDGE_MARKER_REL), { force: true });
    } catch {
      /* fail open */
    }
  }
  const { text, delivered } = buildActiveContext(cwd);
  // Harness contract context (active contract + intake rules) rides in the SAME
  // additionalContext payload — two separate JSON objects on stdout would break
  // the host's hook-output parsing. Present only when the full harness branch
  // applies (active contract, or strict — see runHarnessAgentGate below);
  // undefined otherwise, leaving the advisory output byte-for-byte identical
  // to the pre-harness behaviour.
  const combined = harnessSessionContext ? `${harnessSessionContext}\n\n${text}` : text;
  const out = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: combined,
    },
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (delivered) writeMarker(markerPath);
}

// Palanca C: emit NATIVE_SEARCH_NUDGE on stderr the first time a native grep/read/glob fires
// per session. One-shot via NATIVE_NUDGE_MARKER_REL. stdout ALWAYS empty. Fail-open.
function emitNativeSearchNudge(cwd: string): void {
  const nudgePath = join(cwd, NATIVE_NUDGE_MARKER_REL);
  try {
    if (existsSync(nudgePath)) return;
  } catch {
    /* fail open: treat as absent */
  }
  process.stderr.write(`${NATIVE_SEARCH_NUDGE}\n`);
  writeMarker(nudgePath);
}

function emitStopNudge(saveMarkerPath: string): void {
  let saved = false;
  try {
    saved = existsSync(saveMarkerPath);
  } catch {
    /* fail open: read error → treat as absent → emit nudge */
  }
  if (!saved) process.stderr.write(`${STOP_SAVE_NUDGE}\n`); // NEVER writes to stdout
}

// ===========================================================================
// HARNESS ENFORCEMENT BRANCH — PRODUCT INVARIANT (non-negotiable):
//
//   The agent gate may return a BLOCKING decision (PreToolUse edit/bash exit 2,
//   Stop {"decision":"block"}) ONLY in a TRUSTED WORKSPACE (isWorkspaceTrusted:
//   the out-of-repo record `leina init` writes under $LEINA_HOME/trust/, and
//   consent not "disabled"). Contract, rules and even `.leina/consent` can all
//   be committed by a hostile clone; the trust record cannot. Untrusted → no
//   block, no verify run, no SessionStart injection of contract or rule bodies.
//
//   In a trusted workspace — the same decisions `leina harness hook` makes
//   for Cursor/OpenCode, so hosts do not drift apart:
//     - the INTEGRITY SEAL (edits and shell writes to harness rules, config,
//       lockfile, the user-level harness and the trust store) applies in every
//       strictness mode, contract or not;
//     - the FULL branch (contract scope, commit guard, stop gate, SessionStart
//       context) applies with an ACTIVE contract
//       (.harness/state/current/contract.json), in strictness "strict" even
//       without one, and when the config cannot be read (fail closed).
//   Guided mode without a contract is otherwise untouched: every event that is
//   not an integrity write returns { handled: false } and the caller falls
//   through to runAgentGate exactly as before.
//
//   Covered explicitly by test/harness-agent-gate.test.ts (with contract →
//   blocks; strict without contract → blocks; guided without contract →
//   only the integrity seal; consent disabled or untrusted → never blocks
//   nor injects).
//
// The decision logic itself lives in application/harness/hooks.ts (shared with
// `leina harness hook <event>`); this wrapper maps host payloads to those
// decisions and emits the per-host output protocol. All harness modules are
// loaded via dynamic import so the ~0.15s read-path startup of every other
// leina command never pays for the harness engine.
// ===========================================================================

export interface HarnessAgentGateResult {
  /** True when the harness branch fully handled the event (caller exits with exitCode). */
  handled: boolean;
  exitCode: number;
  /**
   * SessionStart with an active contract: harness context (contract status +
   * intake rules) for the caller to merge into the advisory injection.
   * `handled` stays false — the advisory gate still owns the event.
   */
  sessionContext?: string;
}

const HARNESS_NOT_HANDLED: HarnessAgentGateResult = { handled: false, exitCode: 0 };

/** Sync existence probe for the active-contract sentinel. Fail-open → false. */
export function hasActiveHarnessContract(cwd: string): boolean {
  try {
    return existsSync(join(cwd, ".harness", "state", "current", "contract.json"));
  } catch {
    return false;
  }
}

// Host tool vocabularies for the enforcement branch: Devin lowercase
// (edit/write/exec) and Claude Code capitalized (Edit/Write/MultiEdit/
// NotebookEdit/Bash). Deliberately NOT added to HOST_TOOL_ALIASES: that map
// feeds the ADVISORY decision, and widening it would change advisory behaviour
// in guided repos without a contract — forbidden by the invariant above.
export const HARNESS_EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const HARNESS_BASH_TOOLS: ReadonlySet<string> = new Set(["exec", "Bash"]);
/** Events the enforcement branch acts on besides PreToolUse. */
const HARNESS_EVENTS = new Set(["Stop", "UserPromptSubmit", "SessionStart"]);

type HooksModule = typeof import("../application/harness/hooks.ts");

async function harnessPorts(): Promise<import("../domain/harness/ports.ts").HarnessPorts> {
  const [{ ShellProcessRunner }, { HarnessGit }] = await Promise.all([
    import("../infrastructure/harness/exec.ts"),
    import("../infrastructure/harness/git.ts"),
  ]);
  return { proc: new ShellProcessRunner(), git: new HarnessGit() };
}

async function harnessPreToolUse(
  cwd: string,
  payload: AgentHookPayload,
  hooks: HooksModule,
): Promise<HarnessAgentGateResult> {
  const tool = payload.tool_name;
  if (tool !== undefined && HARNESS_EDIT_TOOLS.has(tool)) {
    const decision = await hooks.decidePreEdit(cwd, hooks.payloadFilePath(payload as unknown as Record<string, unknown>));
    if (decision.block) {
      process.stderr.write(`${decision.message}\n`);
      return { handled: true, exitCode: 2 };
    }
    return HARNESS_NOT_HANDLED;
  }
  if (tool !== undefined && HARNESS_BASH_TOOLS.has(tool)) {
    const decision = await hooks.decidePreBash(
      cwd,
      hooks.payloadCommand(payload as unknown as Record<string, unknown>),
      (await harnessPorts()).git,
    );
    if (decision.block) {
      process.stderr.write(`${decision.message}\n`);
      return { handled: true, exitCode: 2 };
    }
  }
  return HARNESS_NOT_HANDLED;
}

/** The integrity seal alone (guided mode, no contract): edits and shell writes to what defines the gates. */
async function harnessIntegritySeal(
  cwd: string,
  payload: AgentHookPayload,
  hooks: HooksModule,
): Promise<HarnessAgentGateResult> {
  const raw = payload as unknown as Record<string, unknown>;
  const tool = payload.tool_name ?? "";
  const decision = HARNESS_EDIT_TOOLS.has(tool)
    ? await hooks.decideIntegrityEdit(cwd, hooks.payloadFilePath(raw))
    : hooks.decideIntegrityBash(hooks.payloadCommand(raw));
  if (!decision.block) return HARNESS_NOT_HANDLED;
  process.stderr.write(`${decision.message}\n`);
  return { handled: true, exitCode: 2 };
}

async function harnessStop(
  cwd: string,
  payload: AgentHookPayload,
  hooks: HooksModule,
): Promise<HarnessAgentGateResult> {
  const decision = await hooks.decideStop(
    cwd,
    await harnessPorts(),
    hooks.payloadStopHookActive(payload as unknown as Record<string, unknown>),
  );
  if (decision.kind === "block") {
    // Claude Code Stop protocol: {"decision":"block","reason":...} on stdout,
    // exit 0 — the reason becomes the model's next instruction.
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: decision.reason })}\n`);
    return { handled: true, exitCode: 0 };
  }
  if (decision.kind === "yield") {
    // Retry cap exhausted or engine error: cede honestly, never claim success.
    process.stderr.write(`${decision.message}\n`);
    return { handled: true, exitCode: 0 };
  }
  return HARNESS_NOT_HANDLED; // verify green → the advisory stop nudge still runs
}

/**
 * Enforcement wrapper (see the invariant block above). Returns
 * `{ handled: false }` in every situation where the harness must not intervene,
 * letting the caller fall through to the unchanged advisory gate. Fails OPEN:
 * any unexpected error yields not-handled, never a block.
 */
export async function runHarnessAgentGate(
  rawStdin: string,
  cwd: string,
  fallbackEvent?: string,
): Promise<HarnessAgentGateResult> {
  if (!isWorkspaceTrusted(cwd)) return HARNESS_NOT_HANDLED;

  const payload = parseHookPayload(rawStdin, fallbackEvent);
  if (!payload) return HARNESS_NOT_HANDLED;
  const event = payload.hook_event_name;
  const tool = payload.tool_name;
  const harnessTool = tool !== undefined && (HARNESS_EDIT_TOOLS.has(tool) || HARNESS_BASH_TOOLS.has(tool));
  // Events the harness never acts on skip the engine import entirely.
  if (event === "PreToolUse" ? !harnessTool : !HARNESS_EVENTS.has(event ?? "")) return HARNESS_NOT_HANDLED;

  try {
    const hooks = await import("../application/harness/hooks.ts");
    if (!hasActiveHarnessContract(cwd) && !(await hooks.enforcesWithoutContract(cwd))) {
      // Guided, no contract: only the integrity seal — the rest stays advisory.
      return event === "PreToolUse" ? await harnessIntegritySeal(cwd, payload, hooks) : HARNESS_NOT_HANDLED;
    }
    if (event === "PreToolUse") return await harnessPreToolUse(cwd, payload, hooks);
    if (event === "Stop") return await harnessStop(cwd, payload, hooks);
    if (event === "UserPromptSubmit") {
      // A new turn opens a new stop chain (see decideStop); the advisory
      // injection still owns the event.
      await hooks.resetStopRetries(cwd);
      return HARNESS_NOT_HANDLED;
    }
    if (event === "SessionStart") {
      return { handled: false, exitCode: 0, sessionContext: await hooks.sessionStartContext(cwd) };
    }
  } catch {
    return HARNESS_NOT_HANDLED; // fail open — enforcement must never crash the host hook
  }
  return HARNESS_NOT_HANDLED;
}

function emitAdvisory(payload: AgentHookPayload, markerPath: string): void {
  let markerExists = false;
  try {
    markerExists = existsSync(markerPath);
  } catch {
    /* fail open: treat as absent */
  }
  const decision = decideAgentGate(payload, markerExists);
  // Advisory-only: emit the nudge on stderr (so the agent sees it in tool output / logs)
  // when there's a reason. No stdout JSON block envelope — that was the hard-block protocol
  // and Devin would interpret it as "stop".
  if (decision.reason) process.stderr.write(`${decision.reason}\n`);
}
