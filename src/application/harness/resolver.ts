// application/harness/resolver.ts — layered rule resolution:
//   1. Rule files merge by id — a later layer (builtin < project < user)
//      replaces the whole rule.
//   2. config.json `rules.<id>` entries apply partial overrides (enabled /
//      severity only — gates are declared in rule files). Field-level
//      precedence: user config.json < project config.json < config.local.json.
//   3. Enforceability invariant: user-local layers (user rule files, user/local
//      config) may NOT weaken what the shared layers enforce — the BASELINE:
//      the builtin/project rule file plus the project config. Against a
//      baseline that is blocking and enabled, they may not disable it,
//      downgrade it to advisory, or change its gate/phase/scope. Attempts are
//      ignored with a warning.

import { isDeepStrictEqual } from "node:util";
import {
  type HarnessConfig,
  type Phase,
  type Rule,
  type RuleLayer,
  type RuleOverride,
  gatesOf,
} from "../../domain/harness/model.ts";
import { anyFileMatches } from "../../domain/harness/glob.ts";
import { loadAllRules } from "./loader.ts";
import { loadConfig } from "./config-io.ts";

export interface Resolution {
  rules: Rule[];
  config: HarnessConfig;
  errors: string[];
  warnings: string[];
}

/** How `next` weakens a blocking+enabled `base`, or undefined when it does not. */
function weakening(base: Rule, next: Rule): string | undefined {
  if (base.severity !== "blocking" || !base.enabled) return undefined;
  if (!next.enabled) return "disables it";
  if (next.severity !== "blocking") return "downgrades it to advisory";
  if (!isDeepStrictEqual(gatesOf(base), gatesOf(next))) return "changes its gate";
  if (base.phase !== next.phase) return "changes its phase";
  if (!isDeepStrictEqual(base.scope, next.scope)) return "changes its scope";
  return undefined;
}

function withOverride(rule: Rule, override: RuleOverride | undefined): Rule {
  if (!override) return rule;
  return {
    ...rule,
    ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
    ...(override.severity !== undefined ? { severity: override.severity } : {}),
  };
}

export async function loadResolvedRules(repoRoot: string): Promise<Resolution> {
  const warnings: string[] = [];
  const [{ rules: rawRules, errors: ruleErrors }, loadedConfig] = await Promise.all([
    loadAllRules(repoRoot),
    loadConfig(repoRoot),
  ]);
  const errors = [...ruleErrors, ...loadedConfig.errors];
  const { config, projectRuleOverrides, localRuleOverrides } = loadedConfig;

  // 1. Index rule files per layer (duplicate ids within a layer are errors).
  const byLayer: Record<RuleLayer, Map<string, Rule>> = {
    builtin: new Map(),
    project: new Map(),
    user: new Map(),
  };
  for (const rule of rawRules) {
    const layer = byLayer[rule.layer];
    const existing = layer.get(rule.id);
    if (existing) {
      errors.push(
        `duplicate rule id "${rule.id}" in ${rule.layer} layer (${existing.sourcePath}, ${rule.sourcePath})`,
      );
      continue;
    }
    layer.set(rule.id, rule);
  }

  const ids = new Set([...byLayer.builtin.keys(), ...byLayer.project.keys(), ...byLayer.user.keys()]);
  const resolved: Rule[] = [];
  for (const id of ids) {
    const projectOverride = projectRuleOverrides[id];
    // The shared layers: project replaces builtin freely, and the project
    // config may override anything. This is what local layers must not weaken.
    const shared = byLayer.project.get(id) ?? byLayer.builtin.get(id);
    const baseline = shared ? withOverride(shared, projectOverride) : undefined;

    // 2. A user rule file replaces the shared rule unless that weakens the baseline.
    let effective = baseline;
    const userRule = byLayer.user.get(id);
    if (userRule) {
      const candidate = withOverride(userRule, projectOverride);
      const how = baseline ? weakening(baseline, candidate) : undefined;
      if (how !== undefined && baseline) {
        warnings.push(
          `${userRule.sourcePath}: user rule would weaken ${baseline.layer} blocking rule "${id}" (${how}) — ignored`,
        );
      } else {
        effective = candidate;
      }
    }
    if (!effective) continue;

    // 3. Local config fields (user config.json not re-set by the project,
    //    config.local.json) — checked against the baseline, i.e. the rule
    //    AFTER the project config. The user's own additions (no baseline) are free.
    const localOverride = localRuleOverrides[id];
    if (localOverride) {
      const candidate = withOverride(effective, localOverride);
      const how = baseline ? weakening(baseline, candidate) : undefined;
      if (how !== undefined) {
        warnings.push(`local config: override would weaken blocking rule "${id}" (${how}) — severity/enabled ignored`);
      } else {
        effective = candidate;
      }
    }
    resolved.push(effective);
  }

  resolved.sort((a, b) => a.id.localeCompare(b.id));
  return { rules: resolved, config, errors, warnings };
}

// ---------------------------------------------------------------------------
// Applicability filtering
// ---------------------------------------------------------------------------

export interface FilterOptions {
  phases?: Phase[];
  /** Repo-relative changed files; when provided, rules scoped by paths must match. */
  changedFiles?: string[];
  taskType?: string;
}

/** scope.languages entries → file extensions (bare entries match as extensions). */
const LANGUAGE_EXTENSIONS: Record<string, readonly string[]> = {
  typescript: ["ts", "tsx", "mts", "cts"],
  javascript: ["js", "jsx", "mjs", "cjs"],
  python: ["py", "pyi"],
  go: ["go"],
  rust: ["rs"],
  java: ["java"],
  kotlin: ["kt", "kts"],
  ruby: ["rb"],
  php: ["php"],
  csharp: ["cs"],
  c: ["c", "h"],
  cpp: ["cc", "cpp", "cxx", "hpp", "hh"],
  swift: ["swift"],
};

function anyFileInLanguages(files: readonly string[], languages: readonly string[]): boolean {
  const extensions = new Set<string>();
  for (const lang of languages) {
    const mapped = LANGUAGE_EXTENSIONS[lang.toLowerCase()];
    if (mapped) for (const e of mapped) extensions.add(e);
    else extensions.add(lang.toLowerCase().replace(/^\./, ""));
  }
  return files.some((f) => {
    const dot = f.lastIndexOf(".");
    return dot >= 0 && extensions.has(f.slice(dot + 1).toLowerCase());
  });
}

export function filterRules(rules: Rule[], opts: FilterOptions = {}): Rule[] {
  return rules.filter((rule) => {
    if (!rule.enabled) return false;
    if (opts.phases && !opts.phases.includes(rule.phase)) return false;
    // Fail-closed on the unknown: a taskTypes-scoped rule is only dropped when
    // the contract DECLARED a type outside the rule's scope. An untyped
    // contract gets every rule — declaring `--type docs` is how you narrow.
    if (opts.taskType && rule.scope.taskTypes && !rule.scope.taskTypes.includes(opts.taskType)) {
      return false;
    }
    if (opts.changedFiles && rule.scope.paths && rule.scope.paths.length > 0) {
      if (!anyFileMatches(opts.changedFiles, rule.scope.paths)) return false;
    }
    if (opts.changedFiles && rule.scope.languages && rule.scope.languages.length > 0) {
      if (!anyFileInLanguages(opts.changedFiles, rule.scope.languages)) return false;
    }
    return true;
  });
}

/** Blocking verify/deliver rules must carry a gate — checked by doctor. */
export function rulesMissingGates(rules: Rule[]): Rule[] {
  return rules.filter(
    (r) =>
      r.enabled &&
      r.severity === "blocking" &&
      (r.phase === "verify" || r.phase === "deliver") &&
      gatesOf(r).length === 0,
  );
}
