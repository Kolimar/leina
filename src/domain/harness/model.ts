// domain/harness/model.ts — canonical harness types: lifecycle phases, rules,
// gates, task contracts and layered configuration. Pure data contracts — the
// single source of type truth for the harness engine (ported from the
// harness-framework zod schemas; runtime validation lives in validate.ts).
//
// Dependency rule: this file MUST import only from other domain/ modules.
// No application/, infrastructure/, or cli/ imports allowed.

// ---------------------------------------------------------------------------
// Lifecycle phases — every task flows intake → plan → execute → verify → deliver.
// Rules attach to exactly one phase.
// ---------------------------------------------------------------------------

export const PHASES = ["intake", "plan", "execute", "verify", "deliver"] as const;

export type Phase = (typeof PHASES)[number];

/** Phases whose gates run by default on `leina harness verify`. */
export const DEFAULT_VERIFY_PHASES: Phase[] = ["verify", "deliver"];

/** Phases where an instruction-only rule may still be `blocking` (no gate required). */
export const GATE_OPTIONAL_PHASES: Phase[] = ["intake", "plan"];

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Gates — the machine-checkable side of a rule. Discriminated union of the
// six gate types the engine can run.
// ---------------------------------------------------------------------------

export const SEVERITIES = ["blocking", "advisory"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Fields shared by every gate type. */
export interface GateBase {
  /** Milliseconds before the gate is killed and counted as failed (fail-closed). */
  timeoutMs?: number;
  /** Skip the gate when no changed file matches any of these globs. */
  onlyIfChanged?: string[];
  /** Fed back verbatim to the model when the gate fails. */
  failureMessage?: string;
  /** Run this gate alone instead of in the parallel pool. */
  serial?: boolean;
}

/** Executed via `sh -c` (POSIX) in the repo root by the process-runner port. */
export interface CommandGate extends GateBase {
  type: "command";
  run: string;
  expectExitCode: number;
  expectStdoutMatch?: string;
  env?: Record<string, string>;
}

export interface FileGate extends GateBase {
  type: "file";
  /** Glob allowed. */
  path: string;
  exists: boolean;
  contentMatch?: string;
  contentNotMatch?: string;
  minBytes?: number;
}

export interface DiffGate extends GateBase {
  type: "diff";
  /** Base ref; defaults to the ref recorded at contract start, else merge-base with the default branch. */
  base?: string;
  /** Every changed file must match at least one. */
  allowedPaths?: string[];
  /** No changed file may match any. */
  forbiddenPaths?: string[];
  maxChangedFiles?: number;
  /** At least one changed file must match each entry (e.g. force touching tests). */
  requireChangesIn?: string[];
}

/** Cross-platform replacement for `git diff | grep` pipelines — no shell needed. */
export interface DiffContentGate extends GateBase {
  type: "diff-content";
  base?: string;
  /** Git pathspecs to limit the diff (e.g. ["src", "*test*"]). */
  paths?: string[];
  /** Regex: the gate FAILS if any ADDED line matches. */
  forbidAdded: string;
  ignoreCase: boolean;
}

export interface ChecklistGate extends GateBase {
  type: "checklist";
  /** Markdown file containing `- [ ]` items. */
  path: string;
  requireAllChecked: boolean;
}

export interface JsGate extends GateBase {
  type: "js";
  /** Path to a module exporting `default (ctx) => GateResult` — escape hatch. */
  module: string;
}

export type Gate = CommandGate | FileGate | DiffGate | DiffContentGate | ChecklistGate | JsGate;

export const GATE_TYPES = ["command", "file", "diff", "diff-content", "checklist", "js"] as const;
export type GateType = Gate["type"];

// ---------------------------------------------------------------------------
// Rules — a markdown file with JSON frontmatter; the body is the instruction
// text projected into model context.
// ---------------------------------------------------------------------------

export interface RuleScope {
  paths?: string[];
  taskTypes?: string[];
  languages?: string[];
}

export interface RuleFrontmatter {
  /** Unique, kebab-case, namespaced: `harness/tests-pass` (shipped) vs `project/...`. */
  id: string;
  version: number;
  phase: Phase;
  severity: Severity;
  scope: RuleScope;
  enabled: boolean;
  tags: string[];
  /** One-sentence summary used by projection surfaces. */
  summary?: string;
  gate?: Gate | Gate[];
  /** Per-adapter overrides, opaque to the core (adapters interpret their own key). */
  platforms?: Record<string, unknown>;
}

/** `id` must be "namespace/kebab-slug". */
export const RULE_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/** Which layer a rule was loaded from; also the replace-precedence order. */
export const RULE_LAYERS = ["builtin", "project", "user"] as const;
export type RuleLayer = (typeof RULE_LAYERS)[number];

export interface Rule extends RuleFrontmatter {
  /** Markdown body: instruction text + remediation guidance. */
  body: string;
  sourcePath: string;
  layer: RuleLayer;
}

/** Normalize a rule's gate field into a flat list. */
export function gatesOf(rule: Rule): Gate[] {
  if (!rule.gate) return [];
  return Array.isArray(rule.gate) ? rule.gate : [rule.gate];
}

// ---------------------------------------------------------------------------
// Task contract — the rigid pre-task template the model fills before executing.
// Feeds the diff-scope and criteria-checklist gates: scope resolution is
// deterministic (declared in a file), never model self-report.
// ---------------------------------------------------------------------------

export interface Criterion {
  text: string;
  /** Optional rule id whose gate covers this criterion. */
  gate?: string;
  /** Explicit check-off with a one-line justification, recorded by the model. */
  done: boolean;
  justification?: string;
}

export interface TaskContract {
  goal: string;
  taskType?: string;
  /** Globs of files the task is allowed to change. */
  scope: string[];
  outOfScope: string[];
  criteria: Criterion[];
  maxRetries: number;
  /** Git ref recorded at contract start; the diff gate's default base. */
  baseRef?: string;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Layered configuration. Precedence (lowest → highest):
//   built-in defaults < $LEINA_HOME/harness/config.json (user-local)
//   < .harness/config.json (project) < .harness/config.local.json (local).
//
// Invariant: user-local layers may tune timeouts and disable *their own*
// additions, but may NOT downgrade a project blocking rule to advisory —
// enforceability is not defeatable by local config. The resolver enforces this.
// ---------------------------------------------------------------------------

export interface RuleOverride {
  enabled?: boolean;
  severity?: Severity;
  gate?: Gate | Gate[];
}

export const STRICTNESS_LEVELS = ["strict", "guided"] as const;
export type Strictness = (typeof STRICTNESS_LEVELS)[number];

export interface HarnessConfig {
  version: number;
  /** Adapter/platform ids to generate for; empty = auto-detect only. */
  platforms: string[];
  defaultBranch: string;
  /** Partial overrides of rules by id (project layer may override anything). */
  rules: Record<string, RuleOverride>;
  verify: {
    parallelism: number;
    defaultTimeoutMs: number;
  };
  taskTypes: string[];
  /** strict: hooks block edits without an active contract; guided: warn only. */
  strictness: Strictness;
  /** Command prefix platform hooks dispatch to. */
  hookCommand: string;
}

export const DEFAULT_TASK_TYPES = ["feature", "bugfix", "refactor", "docs", "chore"];

/** Built-in configuration defaults (the lowest layer). */
export function defaultHarnessConfig(): HarnessConfig {
  return {
    version: 1,
    platforms: [],
    defaultBranch: "main",
    rules: {},
    verify: { parallelism: 4, defaultTimeoutMs: 120_000 },
    taskTypes: [...DEFAULT_TASK_TYPES],
    strictness: "guided",
    hookCommand: "leina harness hook",
  };
}

// ---------------------------------------------------------------------------
// Recipes — golden-path procedures for common task types. Only their terminal
// gates are enforceable; the value is variance reduction.
// ---------------------------------------------------------------------------

export interface RecipeFrontmatter {
  name: string;
  description: string;
  taskType?: string;
}

/** Recipe `name` must be a bare kebab-case slug. */
export const RECIPE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface Recipe extends RecipeFrontmatter {
  body: string;
  sourcePath: string;
}
