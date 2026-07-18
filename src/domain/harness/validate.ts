// domain/harness/validate.ts — lightweight runtime validators for harness rule
// frontmatter, gates, task contracts and layered config (no Zod/AJV — same
// style as domain/contracts/schemas.ts). Each validator mirrors the origin
// harness-framework zod schema: same constraints, same defaults, unknown keys
// ignored (zod's default strip behavior).
//
// All validators return `{ ok: true, value } | { ok: false, errors: string[] }`
// where each error carries a dot-path prefix (e.g. "gate.run: …").
//
// Dependency rule: this file MUST import only from other domain/ modules.

import {
  type ChecklistGate,
  type CommandGate,
  type Criterion,
  type DiffContentGate,
  type DiffGate,
  type FileGate,
  type Gate,
  type HarnessConfig,
  type JsGate,
  type RecipeFrontmatter,
  type Rule,
  type RuleFrontmatter,
  type RuleLayer,
  type RuleOverride,
  type RuleScope,
  type Severity,
  type TaskContract,
  defaultHarnessConfig,
  GATE_TYPES,
  isPhase,
  PHASES,
  RECIPE_NAME_RE,
  RULE_ID_RE,
  SEVERITIES,
  STRICTNESS_LEVELS,
} from "./model.ts";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Primitive field readers. Each pushes dot-path errors and returns undefined
// when absent or invalid — callers apply defaults for absent fields.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface NumberRules {
  int?: boolean;
  positive?: boolean;
  nonNegative?: boolean;
}

function readString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  opts: { nonEmpty?: boolean } = {},
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    errors.push(`${path}${key}: must be a string`);
    return undefined;
  }
  if (opts.nonEmpty && value.length === 0) {
    errors.push(`${path}${key}: must not be empty`);
    return undefined;
  }
  return value;
}

function readNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  rules: NumberRules = {},
): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) {
    errors.push(`${path}${key}: must be a number`);
    return undefined;
  }
  if (rules.int && !Number.isInteger(value)) {
    errors.push(`${path}${key}: must be an integer`);
    return undefined;
  }
  if (rules.positive && value <= 0) {
    errors.push(`${path}${key}: must be positive`);
    return undefined;
  }
  if (rules.nonNegative && value < 0) {
    errors.push(`${path}${key}: must be >= 0`);
    return undefined;
  }
  return value;
}

function readBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    errors.push(`${path}${key}: must be a boolean`);
    return undefined;
  }
  return value;
}

function readStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): string[] | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    errors.push(`${path}${key}: must be an array of strings`);
    return undefined;
  }
  return value as string[];
}

function readStringRecord(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): Record<string, string> | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== "string")) {
    errors.push(`${path}${key}: must be an object of string values`);
    return undefined;
  }
  return value as Record<string, string>;
}

function readEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  allowed: readonly T[],
): T | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    errors.push(`${path}${key}: must be one of ${allowed.join(", ")}`);
    return undefined;
  }
  return value as T;
}

/** Spread helper: include a key only when the value is defined (exactOptionalPropertyTypes-friendly). */
function opt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

interface GateBaseFields {
  timeoutMs?: number;
  onlyIfChanged?: string[];
  failureMessage?: string;
  serial?: boolean;
}

function readGateBase(obj: Record<string, unknown>, path: string, errors: string[]): GateBaseFields {
  return {
    ...opt("timeoutMs", readNumber(obj, "timeoutMs", path, errors, { int: true, positive: true })),
    ...opt("onlyIfChanged", readStringArray(obj, "onlyIfChanged", path, errors)),
    ...opt("failureMessage", readString(obj, "failureMessage", path, errors)),
    ...opt("serial", readBoolean(obj, "serial", path, errors)),
  };
}

function readRequiredString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): string {
  if (obj[key] === undefined) {
    errors.push(`${path}${key}: is required`);
    return "";
  }
  return readString(obj, key, path, errors, { nonEmpty: true }) ?? "";
}

function validateCommandGate(obj: Record<string, unknown>, path: string, errors: string[]): CommandGate {
  return {
    type: "command",
    ...readGateBase(obj, path, errors),
    run: readRequiredString(obj, "run", path, errors),
    expectExitCode: readNumber(obj, "expectExitCode", path, errors, { int: true }) ?? 0,
    ...opt("expectStdoutMatch", readString(obj, "expectStdoutMatch", path, errors)),
    ...opt("env", readStringRecord(obj, "env", path, errors)),
  };
}

function validateFileGate(obj: Record<string, unknown>, path: string, errors: string[]): FileGate {
  return {
    type: "file",
    ...readGateBase(obj, path, errors),
    path: readRequiredString(obj, "path", path, errors),
    exists: readBoolean(obj, "exists", path, errors) ?? true,
    ...opt("contentMatch", readString(obj, "contentMatch", path, errors)),
    ...opt("contentNotMatch", readString(obj, "contentNotMatch", path, errors)),
    ...opt("minBytes", readNumber(obj, "minBytes", path, errors, { int: true, nonNegative: true })),
  };
}

function validateDiffGate(obj: Record<string, unknown>, path: string, errors: string[]): DiffGate {
  return {
    type: "diff",
    ...readGateBase(obj, path, errors),
    ...opt("base", readString(obj, "base", path, errors)),
    ...opt("allowedPaths", readStringArray(obj, "allowedPaths", path, errors)),
    ...opt("forbiddenPaths", readStringArray(obj, "forbiddenPaths", path, errors)),
    ...opt("maxChangedFiles", readNumber(obj, "maxChangedFiles", path, errors, { int: true, positive: true })),
    ...opt("requireChangesIn", readStringArray(obj, "requireChangesIn", path, errors)),
  };
}

function validateDiffContentGate(
  obj: Record<string, unknown>,
  path: string,
  errors: string[],
): DiffContentGate {
  return {
    type: "diff-content",
    ...readGateBase(obj, path, errors),
    ...opt("base", readString(obj, "base", path, errors)),
    ...opt("paths", readStringArray(obj, "paths", path, errors)),
    forbidAdded: readRequiredString(obj, "forbidAdded", path, errors),
    ignoreCase: readBoolean(obj, "ignoreCase", path, errors) ?? false,
  };
}

function validateChecklistGate(obj: Record<string, unknown>, path: string, errors: string[]): ChecklistGate {
  return {
    type: "checklist",
    ...readGateBase(obj, path, errors),
    path: readRequiredString(obj, "path", path, errors),
    requireAllChecked: readBoolean(obj, "requireAllChecked", path, errors) ?? true,
  };
}

function validateJsGate(obj: Record<string, unknown>, path: string, errors: string[]): JsGate {
  return {
    type: "js",
    ...readGateBase(obj, path, errors),
    module: readRequiredString(obj, "module", path, errors),
  };
}

/** Validate a single gate object (discriminated on `type`). */
export function validateGate(value: unknown, path = ""): ValidationResult<Gate> {
  if (!isRecord(value)) return { ok: false, errors: [`${path || "gate"}: must be an object`] };
  const errors: string[] = [];
  const prefix = path === "" ? "" : `${path}.`;
  const type = value.type;

  let gate: Gate | undefined;
  switch (type) {
    case "command":
      gate = validateCommandGate(value, prefix, errors);
      break;
    case "file":
      gate = validateFileGate(value, prefix, errors);
      break;
    case "diff":
      gate = validateDiffGate(value, prefix, errors);
      break;
    case "diff-content":
      gate = validateDiffContentGate(value, prefix, errors);
      break;
    case "checklist":
      gate = validateChecklistGate(value, prefix, errors);
      break;
    case "js":
      gate = validateJsGate(value, prefix, errors);
      break;
    default:
      return { ok: false, errors: [`${prefix}type: must be one of ${GATE_TYPES.join(", ")}`] };
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: gate };
}

/** Validate a `gate` field that may be a single gate or a list of gates. */
export function validateGateField(value: unknown, path: string): ValidationResult<Gate | Gate[]> {
  if (!Array.isArray(value)) {
    const single = validateGate(value, path);
    return single.ok ? { ok: true, value: single.value } : single;
  }
  const gates: Gate[] = [];
  const errors: string[] = [];
  value.forEach((entry, i) => {
    const parsed = validateGate(entry, `${path}[${i}]`);
    if (parsed.ok) gates.push(parsed.value);
    else errors.push(...parsed.errors);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: gates };
}

// ---------------------------------------------------------------------------
// Rule frontmatter
// ---------------------------------------------------------------------------

function readRuleScope(obj: Record<string, unknown>, errors: string[]): RuleScope {
  const raw = obj.scope;
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    errors.push("scope: must be an object");
    return {};
  }
  return {
    ...opt("paths", readStringArray(raw, "paths", "scope.", errors)),
    ...opt("taskTypes", readStringArray(raw, "taskTypes", "scope.", errors)),
    ...opt("languages", readStringArray(raw, "languages", "scope.", errors)),
  };
}

export function validateRuleFrontmatter(value: unknown): ValidationResult<RuleFrontmatter> {
  if (!isRecord(value)) return { ok: false, errors: ["frontmatter must be a JSON object"] };
  const errors: string[] = [];

  const id = readString(value, "id", "", errors, { nonEmpty: true });
  if (id === undefined) {
    if (value.id === undefined) errors.push("id: is required");
  } else if (!RULE_ID_RE.test(id)) {
    errors.push('id: must be "namespace/kebab-slug"');
  }

  const phaseRaw = value.phase;
  if (typeof phaseRaw !== "string" || !isPhase(phaseRaw)) {
    errors.push(`phase: must be one of ${PHASES.join(", ")}`);
  }

  const severity = readEnum<Severity>(value, "severity", "", errors, SEVERITIES);
  if (value.severity === undefined) errors.push("severity: is required");

  let gate: Gate | Gate[] | undefined;
  if (value.gate !== undefined) {
    const parsed = validateGateField(value.gate, "gate");
    if (parsed.ok) gate = parsed.value;
    else errors.push(...parsed.errors);
  }

  let platforms: Record<string, unknown> | undefined;
  if (value.platforms !== undefined) {
    if (isRecord(value.platforms)) platforms = value.platforms;
    else errors.push("platforms: must be an object");
  }

  const frontmatter: RuleFrontmatter = {
    id: id ?? "",
    version: readNumber(value, "version", "", errors, { int: true, positive: true }) ?? 1,
    phase: typeof phaseRaw === "string" && isPhase(phaseRaw) ? phaseRaw : "verify",
    severity: severity ?? "advisory",
    scope: readRuleScope(value, errors),
    enabled: readBoolean(value, "enabled", "", errors) ?? true,
    tags: readStringArray(value, "tags", "", errors) ?? [],
    ...opt("summary", readString(value, "summary", "", errors)),
    ...opt("gate", gate),
    ...opt("platforms", platforms),
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: frontmatter };
}

/** Assemble a full Rule from validated frontmatter + body + provenance. */
export function makeRule(
  frontmatter: RuleFrontmatter,
  body: string,
  sourcePath: string,
  layer: RuleLayer,
): Rule {
  return { ...frontmatter, body, sourcePath, layer };
}

// ---------------------------------------------------------------------------
// Task contract
// ---------------------------------------------------------------------------

function validateCriterion(value: unknown, path: string, errors: string[]): Criterion {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`);
    return { text: "", done: false };
  }
  const text = readString(value, "text", `${path}.`, errors, { nonEmpty: true });
  if (value.text === undefined) errors.push(`${path}.text: is required`);
  return {
    text: text ?? "",
    ...opt("gate", readString(value, "gate", `${path}.`, errors)),
    done: readBoolean(value, "done", `${path}.`, errors) ?? false,
    ...opt("justification", readString(value, "justification", `${path}.`, errors)),
  };
}

export function validateContract(value: unknown): ValidationResult<TaskContract> {
  if (!isRecord(value)) return { ok: false, errors: ["contract must be a JSON object"] };
  const errors: string[] = [];

  const goal = readString(value, "goal", "", errors, { nonEmpty: true });
  if (value.goal === undefined) errors.push("goal: is required");

  let criteria: Criterion[] = [];
  const rawCriteria = value.criteria;
  if (rawCriteria !== undefined) {
    if (Array.isArray(rawCriteria)) {
      criteria = rawCriteria.map((c, i) => validateCriterion(c, `criteria[${i}]`, errors));
    } else {
      errors.push("criteria: must be an array");
    }
  }

  const contract: TaskContract = {
    goal: goal ?? "",
    ...opt("taskType", readString(value, "taskType", "", errors)),
    scope: readStringArray(value, "scope", "", errors) ?? [],
    outOfScope: readStringArray(value, "outOfScope", "", errors) ?? [],
    criteria,
    maxRetries: readNumber(value, "maxRetries", "", errors, { int: true, positive: true }) ?? 3,
    ...opt("baseRef", readString(value, "baseRef", "", errors)),
    ...opt("createdAt", readString(value, "createdAt", "", errors)),
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: contract };
}

// ---------------------------------------------------------------------------
// Config + rule overrides
// ---------------------------------------------------------------------------

export function validateRuleOverride(value: unknown, path = ""): ValidationResult<RuleOverride> {
  if (!isRecord(value)) return { ok: false, errors: [`${path || "override"}: must be an object`] };
  const errors: string[] = [];
  const prefix = path === "" ? "" : `${path}.`;

  let gate: Gate | Gate[] | undefined;
  if (value.gate !== undefined) {
    const parsed = validateGateField(value.gate, `${prefix}gate`);
    if (parsed.ok) gate = parsed.value;
    else errors.push(...parsed.errors);
  }

  const override: RuleOverride = {
    ...opt("enabled", readBoolean(value, "enabled", prefix, errors)),
    ...opt("severity", readEnum<Severity>(value, "severity", prefix, errors, SEVERITIES)),
    ...opt("gate", gate),
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: override };
}

function readVerifySection(value: unknown, errors: string[]): HarnessConfig["verify"] {
  const defaults = defaultHarnessConfig().verify;
  if (value === undefined) return defaults;
  if (!isRecord(value)) {
    errors.push("verify: must be an object");
    return defaults;
  }
  return {
    parallelism:
      readNumber(value, "parallelism", "verify.", errors, { int: true, positive: true }) ??
      defaults.parallelism,
    defaultTimeoutMs:
      readNumber(value, "defaultTimeoutMs", "verify.", errors, { int: true, positive: true }) ??
      defaults.defaultTimeoutMs,
  };
}

function readRuleOverrides(value: unknown, errors: string[]): Record<string, RuleOverride> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push("rules: must be an object keyed by rule id");
    return {};
  }
  const overrides: Record<string, RuleOverride> = {};
  for (const [ruleId, raw] of Object.entries(value)) {
    const parsed = validateRuleOverride(raw, `rules.${ruleId}`);
    if (parsed.ok) overrides[ruleId] = parsed.value;
    else errors.push(...parsed.errors);
  }
  return overrides;
}

/** Validate a merged raw config object, applying built-in defaults per field. */
export function validateConfig(value: unknown): ValidationResult<HarnessConfig> {
  if (!isRecord(value)) return { ok: false, errors: ["config must be a JSON object"] };
  const errors: string[] = [];
  const defaults = defaultHarnessConfig();

  const config: HarnessConfig = {
    version: readNumber(value, "version", "", errors, { int: true }) ?? defaults.version,
    platforms: readStringArray(value, "platforms", "", errors) ?? defaults.platforms,
    defaultBranch: readString(value, "defaultBranch", "", errors) ?? defaults.defaultBranch,
    rules: readRuleOverrides(value.rules, errors),
    verify: readVerifySection(value.verify, errors),
    taskTypes: readStringArray(value, "taskTypes", "", errors) ?? defaults.taskTypes,
    strictness: readEnum(value, "strictness", "", errors, STRICTNESS_LEVELS) ?? defaults.strictness,
    hookCommand: readString(value, "hookCommand", "", errors) ?? defaults.hookCommand,
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: config };
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export function validateRecipeFrontmatter(value: unknown): ValidationResult<RecipeFrontmatter> {
  if (!isRecord(value)) return { ok: false, errors: ["frontmatter must be a JSON object"] };
  const errors: string[] = [];

  const name = readString(value, "name", "", errors, { nonEmpty: true });
  if (value.name === undefined) errors.push("name: is required");
  else if (name !== undefined && !RECIPE_NAME_RE.test(name)) {
    errors.push("name: must be a kebab-case slug");
  }

  const description = readString(value, "description", "", errors, { nonEmpty: true });
  if (value.description === undefined) errors.push("description: is required");

  const recipe: RecipeFrontmatter = {
    name: name ?? "",
    description: description ?? "",
    ...opt("taskType", readString(value, "taskType", "", errors)),
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: recipe };
}
