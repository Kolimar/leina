// application/harness/resolver.ts — layered rule resolution:
//   1. Rule files merge by id — a later layer (builtin < project < user)
//      replaces the whole rule.
//   2. config.json `rules.<id>` entries apply partial overrides (enabled /
//      severity only — gates are declared in rule files).
//   3. Enforceability invariant: user-local layers (user rule files, user/local
//      config) may NOT weaken a project/builtin blocking rule — no disabling it
//      and no downgrading severity. Attempts are ignored with a warning.

import {
  type HarnessConfig,
  type Phase,
  type Rule,
  type RuleOverride,
  type Severity,
  gatesOf,
  RULE_LAYERS,
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

function isWeakening(
  base: { severity: Severity; enabled: boolean },
  next: { severity?: Severity | undefined; enabled?: boolean | undefined },
): boolean {
  if (base.severity !== "blocking" || !base.enabled) return false;
  return next.severity === "advisory" || next.enabled === false;
}

export async function loadResolvedRules(repoRoot: string): Promise<Resolution> {
  const warnings: string[] = [];
  const [{ rules: rawRules, errors: ruleErrors }, loadedConfig] = await Promise.all([
    loadAllRules(repoRoot),
    loadConfig(repoRoot),
  ]);
  const errors = [...ruleErrors, ...loadedConfig.errors];
  const { config, localRuleOverrides } = loadedConfig;

  // 1. Replace-merge rule files by id, respecting the enforceability invariant.
  const byId = new Map<string, Rule>();
  for (const layer of RULE_LAYERS) {
    for (const rule of rawRules.filter((r) => r.layer === layer)) {
      const existing = byId.get(rule.id);
      if (existing && layer === "user" && existing.layer === "project" && isWeakening(existing, rule)) {
        warnings.push(
          `${rule.sourcePath}: user rule would weaken project blocking rule "${rule.id}" — ignored`,
        );
        continue;
      }
      if (existing?.layer === layer) {
        errors.push(
          `duplicate rule id "${rule.id}" in ${layer} layer (${existing.sourcePath}, ${rule.sourcePath})`,
        );
        continue;
      }
      byId.set(rule.id, rule);
    }
  }

  // 2. Config overrides (merged project+local values; local restrictions here).
  const resolved: Rule[] = [];
  for (const rule of byId.values()) {
    const override: RuleOverride | undefined = config.rules[rule.id];
    if (!override) {
      resolved.push(rule);
      continue;
    }
    const fromLocal = localRuleOverrides[rule.id];
    let effective = { ...override };
    if (fromLocal && rule.layer !== "user" && isWeakening(rule, fromLocal)) {
      warnings.push(
        `config.local: override would weaken blocking rule "${rule.id}" — severity/enabled ignored`,
      );
      const { severity: _s, enabled: _e, ...rest } = effective;
      effective = rest;
    }
    resolved.push({
      ...rule,
      ...(effective.enabled !== undefined ? { enabled: effective.enabled } : {}),
      ...(effective.severity !== undefined ? { severity: effective.severity } : {}),
    });
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
