// application/harness/config-io.ts — layered harness configuration loading.
// Precedence (lowest → highest):
//   built-in defaults < $LEINA_HOME/harness/config.json (user-local)
//   < .harness/config.json (project) < .harness/config.local.json (local).
//
// Invariant: user-local layers may tune timeouts and disable *their own*
// additions, but may NOT downgrade a project blocking rule to advisory —
// enforceability is not defeatable by local config. resolver.ts enforces it
// using the project/local split of rule overrides this loader reports; the
// loader itself keeps local layers from lowering `strictness`.
//
// Directory names are contract: `.harness/` and its file names never change,
// so repos initialized by the original harness-framework keep working.

import path from "node:path";
import os from "node:os";
import { type HarnessConfig, type RuleOverride, STRICTNESS_LEVELS } from "../../domain/harness/model.ts";
import { validateConfig, validateRuleOverride } from "../../domain/harness/validate.ts";
import { readJsonIfExists } from "./io.ts";

export const HARNESS_DIR = ".harness";

export function harnessDir(repoRoot: string): string {
  return path.join(repoRoot, HARNESS_DIR);
}

/** Root of leina's own home dir. Override with $LEINA_HOME (used by tests). */
export function leinaHome(): string {
  return process.env.LEINA_HOME ?? path.resolve(os.homedir(), ".leina");
}

/** User-level harness directory: `$LEINA_HOME/harness/`. */
export function userHarnessDir(): string {
  return path.join(leinaHome(), "harness");
}

export interface LoadedConfig {
  config: HarnessConfig;
  /** Rule override fields decided by the project layer (.harness/config.json). */
  projectRuleOverrides: Record<string, RuleOverride>;
  /**
   * Rule override fields decided by user-local layers — only those that WIN the
   * merge (a user config.json field the project layer re-sets is not local).
   * Restricted by the resolver. `config.rules` = project + local, field-level.
   */
  localRuleOverrides: Record<string, RuleOverride>;
  errors: string[];
}

interface RawLayer {
  source: string;
  data: unknown;
  local: boolean;
}

/** `committedOnly`: project config.json alone, no user/local layers (what `harness sync` compiles). */
export async function loadConfig(repoRoot: string, opts: { committedOnly?: boolean } = {}): Promise<LoadedConfig> {
  const errors: string[] = [];
  const layers: RawLayer[] = [];

  // Ordered lowest → highest precedence.
  const candidates: { file: string; local: boolean }[] = [
    { file: path.join(userHarnessDir(), "config.json"), local: true },
    { file: path.join(harnessDir(repoRoot), "config.json"), local: false },
    { file: path.join(harnessDir(repoRoot), "config.local.json"), local: true },
  ].filter((c) => !opts.committedOnly || !c.local);

  for (const { file, local } of candidates) {
    const parsed = await readJsonIfExists(file);
    if (parsed.error) errors.push(`${file}: ${parsed.error}`);
    if (parsed.value !== undefined) layers.push({ source: file, data: parsed.value, local });
  }

  // Merge raw objects shallowly per top-level key. `rules` is validated per
  // layer and merged by rule id with field-level precedence (a local layer
  // adding `enabled` must not wipe the project layer's `severity`), keeping
  // which fields the project decided and which a user-local layer did.
  const mergedRaw: Record<string, unknown> = {};
  const ruleLayers: { local: boolean; rules: Record<string, RuleOverride> }[] = [];
  const ruleErrors: string[] = [];
  const strictnessVotes: { value: unknown; local: boolean }[] = [];

  for (const layer of layers) {
    const obj = layer.data;
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      errors.push(`${layer.source}: config must be a JSON object`);
      continue;
    }
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === "$schema") continue;
      if (key === "rules") ruleLayers.push({ local: layer.local, rules: validateRuleLayer(value, ruleErrors) });
      else if (key === "strictness") strictnessVotes.push({ value, local: layer.local });
      else mergedRaw[key] = value;
    }
  }
  const strictness = resolveStrictness(strictnessVotes);
  if (strictness !== undefined) mergedRaw.strictness = strictness;

  const result = validateConfig(mergedRaw);
  const invalid = [
    ...(result.ok ? [] : result.errors),
    ...ruleErrors,
    ...(result.ok ? hookCommandRepoProblems(result.value.hookCommand, repoRoot) : []),
  ];
  if (!result.ok || invalid.length > 0) {
    errors.push(`invalid config: ${invalid.join("; ")}`);
    const fallback = validateConfig({});
    return {
      config: fallback.ok ? fallback.value : (undefined as never),
      projectRuleOverrides: {},
      localRuleOverrides: {},
      errors,
    };
  }

  const { merged, project, local } = mergeRuleLayers(ruleLayers);
  return {
    config: { ...result.value, rules: merged },
    projectRuleOverrides: project,
    localRuleOverrides: local,
    errors,
  };
}

/**
 * validateConfig only admits leina launch forms for `hookCommand` (see
 * hookCommandProblem); it cannot know the repo root. A shape-valid absolute
 * path INSIDE the repository would still run a file the repo ships from the
 * host's hook wiring — refused here.
 */
function hookCommandRepoProblems(command: string, repoRoot: string): string[] {
  const root = path.resolve(repoRoot);
  const inside = command
    .split(/\s+/)
    .filter((word) => path.isAbsolute(word))
    .some((word) => {
      const abs = path.resolve(word);
      return abs === root || abs.startsWith(`${root}${path.sep}`);
    });
  return inside ? [`hookCommand: must not run a program from inside the repository (got ${JSON.stringify(command)})`] : [];
}

/**
 * `strictness` across layers: the project (or the default) decides, and user-local
 * layers may only RAISE it to "strict" — a config.local.json "guided" must not turn a
 * strict repo's hard gates into warnings. An invalid value is passed through so
 * validateConfig reports it.
 */
function resolveStrictness(votes: { value: unknown; local: boolean }[]): unknown {
  const invalid = votes.find((v) => !(STRICTNESS_LEVELS as readonly unknown[]).includes(v.value));
  if (invalid) return invalid.value;
  if (votes.some((v) => v.local && v.value === "strict")) return "strict";
  return votes.filter((v) => !v.local).at(-1)?.value;
}

function validateRuleLayer(value: unknown, errors: string[]): Record<string, RuleOverride> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("rules: must be an object keyed by rule id");
    return {};
  }
  const overrides: Record<string, RuleOverride> = {};
  for (const [ruleId, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = validateRuleOverride(raw, `rules.${ruleId}`);
    if (parsed.ok) overrides[ruleId] = parsed.value;
    else errors.push(...parsed.errors);
  }
  return overrides;
}

/** Field-level merge, lowest → highest precedence, tracking the deciding layer kind. */
function mergeRuleLayers(layers: { local: boolean; rules: Record<string, RuleOverride> }[]): {
  merged: Record<string, RuleOverride>;
  project: Record<string, RuleOverride>;
  local: Record<string, RuleOverride>;
} {
  const merged: Record<string, RuleOverride> = {};
  const project: Record<string, RuleOverride> = {};
  const local: Record<string, RuleOverride> = {};
  for (const layer of layers) {
    for (const [id, override] of Object.entries(layer.rules)) {
      merged[id] = { ...merged[id], ...override };
      if (layer.local) {
        local[id] = { ...local[id], ...override };
        continue;
      }
      project[id] = { ...project[id], ...override };
      // A project field re-set over the user config.json is no longer local.
      const lower = local[id];
      if (lower) {
        if (override.enabled !== undefined) delete lower.enabled;
        if (override.severity !== undefined) delete lower.severity;
        if (lower.enabled === undefined && lower.severity === undefined) delete local[id];
      }
    }
  }
  return { merged, project, local };
}
