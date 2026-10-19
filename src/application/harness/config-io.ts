// application/harness/config-io.ts — layered harness configuration loading.
// Precedence (lowest → highest):
//   built-in defaults < $LEINA_HOME/harness/config.json (user-local)
//   < .harness/config.json (project) < .harness/config.local.json (local).
//
// Invariant: user-local layers may tune timeouts and disable *their own*
// additions, but may NOT downgrade a project blocking rule to advisory —
// enforceability is not defeatable by local config. resolver.ts enforces it
// using the `localRuleOverrides` this loader reports.
//
// Directory names are contract: `.harness/` and its file names never change,
// so repos initialized by the original harness-framework keep working.

import path from "node:path";
import os from "node:os";
import { type HarnessConfig, type RuleOverride } from "../../domain/harness/model.ts";
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
  /** Rule overrides that came from user-local layers (restricted by the resolver). */
  localRuleOverrides: Record<string, RuleOverride>;
  errors: string[];
}

interface RawLayer {
  source: string;
  data: unknown;
  local: boolean;
}

export async function loadConfig(repoRoot: string): Promise<LoadedConfig> {
  const errors: string[] = [];
  const layers: RawLayer[] = [];

  // Ordered lowest → highest precedence.
  const candidates: { file: string; local: boolean }[] = [
    { file: path.join(userHarnessDir(), "config.json"), local: true },
    { file: path.join(harnessDir(repoRoot), "config.json"), local: false },
    { file: path.join(harnessDir(repoRoot), "config.local.json"), local: true },
  ];

  for (const { file, local } of candidates) {
    const parsed = await readJsonIfExists(file);
    if (parsed.error) errors.push(`${file}: ${parsed.error}`);
    if (parsed.value !== undefined) layers.push({ source: file, data: parsed.value, local });
  }

  // Merge raw objects shallowly per top-level key; `rules` merges by rule id
  // with field-level merge across layers (a local layer adding `enabled` must
  // not wipe the project layer's `severity` for the same rule).
  const mergedRaw: Record<string, unknown> = {};
  const mergedRules: Record<string, Record<string, unknown>> = {};
  const localRuleOverridesRaw: Record<string, Record<string, unknown>> = {};

  for (const layer of layers) {
    const obj = layer.data;
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      errors.push(`${layer.source}: config must be a JSON object`);
      continue;
    }
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === "$schema") continue;
      if (key === "rules" && typeof value === "object" && value !== null) {
        mergeRuleLayer(value as Record<string, unknown>, mergedRules, layer.local ? localRuleOverridesRaw : undefined);
      } else {
        mergedRaw[key] = value;
      }
    }
  }
  mergedRaw.rules = mergedRules;

  const result = validateConfig(mergedRaw);
  if (!result.ok) {
    errors.push(`invalid config: ${result.errors.join("; ")}`);
    const fallback = validateConfig({});
    return {
      config: fallback.ok ? fallback.value : (undefined as never),
      localRuleOverrides: {},
      errors,
    };
  }

  const localRuleOverrides: Record<string, RuleOverride> = {};
  for (const [id, raw] of Object.entries(localRuleOverridesRaw)) {
    const parsed = validateRuleOverride(raw, `rules.${id}`);
    if (parsed.ok) localRuleOverrides[id] = parsed.value;
  }

  return { config: result.value, localRuleOverrides, errors };
}

function mergeRuleLayer(
  value: Record<string, unknown>,
  mergedRules: Record<string, Record<string, unknown>>,
  localSink: Record<string, Record<string, unknown>> | undefined,
): void {
  for (const [ruleId, override] of Object.entries(value)) {
    if (typeof override !== "object" || override === null) continue;
    mergedRules[ruleId] = { ...mergedRules[ruleId], ...(override as Record<string, unknown>) };
    if (localSink) {
      localSink[ruleId] = { ...localSink[ruleId], ...(override as Record<string, unknown>) };
    }
  }
}
