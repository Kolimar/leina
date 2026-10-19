// application/harness/recipes.ts — golden-path recipe loading and the builtin
// RULE PRESETS. Builtin recipes ship under assets/harness/recipes/; a project
// may add or override them in `.harness/recipes/` (override key: recipe name).
// Only their terminal gates are enforceable; the value is variance reduction.
//
// Rule presets (bottom of this file) decide which slice of the builtin rule
// suite governs a repo: `leina-native` (everything, including the four
// leina-coupled rules) vs `generic` (only the host-agnostic rules — nothing
// that requires running a leina command). A preset is realized purely through
// `.harness/config.json` overrides, never by editing the rule .md files.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Recipe } from "../../domain/harness/model.ts";
import { parseFrontmatter } from "../../domain/harness/frontmatter.ts";
import { validateRecipeFrontmatter } from "../../domain/harness/validate.ts";
import { harnessDir } from "./config-io.ts";
import { builtinRulesDir, parseRuleFile } from "./loader.ts";
import { listFilesRecursive, readTextIfExists } from "./io.ts";

export function builtinRecipesDir(): string {
  return fileURLToPath(new URL("../../../assets/harness/recipes/", import.meta.url));
}

export function projectRecipesDir(repoRoot: string): string {
  return path.join(harnessDir(repoRoot), "recipes");
}

export interface LoadedRecipes {
  recipes: Recipe[];
  errors: string[];
}

async function loadFromDir(dir: string): Promise<LoadedRecipes> {
  const recipes: Recipe[] = [];
  const errors: string[] = [];
  for (const file of await listFilesRecursive(dir, ".md")) {
    const text = await readTextIfExists(file);
    if (text === undefined) continue;
    const doc = parseFrontmatter(text);
    if (!doc.ok) {
      errors.push(`${file}: ${doc.error}`);
      continue;
    }
    const front = validateRecipeFrontmatter(doc.value.data);
    if (!front.ok) {
      errors.push(`${file}: ${front.errors.join("; ")}`);
      continue;
    }
    recipes.push({ ...front.value, body: doc.value.body, sourcePath: file });
  }
  return { recipes, errors };
}

/** Builtin recipes, overridden by project recipes with the same name. */
export async function loadRecipes(repoRoot: string): Promise<LoadedRecipes> {
  const builtin = await loadFromDir(builtinRecipesDir());
  const project = await loadFromDir(projectRecipesDir(repoRoot));
  const byName = new Map<string, Recipe>();
  for (const recipe of [...builtin.recipes, ...project.recipes]) byName.set(recipe.name, recipe);
  return {
    recipes: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    errors: [...builtin.errors, ...project.errors],
  };
}

// ---------------------------------------------------------------------------
// Rule presets — which slice of the builtin rule suite governs a repo.
//
//   leina-native  the full builtin suite, including the leina-coupled rules
//                 (leina-memory-first, leina-graph-consult, leina-graph-fresh,
//                 leina-session-summary). These are blocking by default and
//                 only pass when leina itself is adopted in the repo (graph
//                 built, memory in use) — the current, historical default.
//   generic       only the host-agnostic rules (tests-pass, no-secrets,
//                 diff-in-scope, lint-clean, typecheck, …). A team adopting
//                 the harness WITHOUT adopting the rest of leina starts here:
//                 no included rule requires running a leina command.
//
// Mechanism: a preset never touches the rule .md files. It is expressed as
// `.harness/config.json` `rules.<id>.enabled` overrides — the project layer is
// allowed to disable builtin rules (the anti-weakening invariant only forbids
// USER-LOCAL layers from weakening project/builtin blocking rules, see
// resolver.ts). `leina-native` is the empty config `{}` (the same pristine
// seed `leina init` writes — see install/harness-init.ts HARNESS_MINIMAL_CONFIG);
// `generic` disables every leina-coupled builtin rule. The leina-coupled set
// is DERIVED by scanning assets/harness/rules/ at call time, so adding a new
// `leina-*` builtin rule automatically keeps both presets correct.
// ---------------------------------------------------------------------------

export const RULE_PRESETS = ["generic", "leina-native"] as const;
export type RulePreset = (typeof RULE_PRESETS)[number];

export function isRulePreset(value: string): value is RulePreset {
  return (RULE_PRESETS as readonly string[]).includes(value);
}

/**
 * True for rules coupled to leina's own tooling: the rule id's slug (the part
 * after the namespace) starts with `leina-`, e.g. `harness/leina-graph-fresh`.
 */
export function isLeinaCoupledRuleId(id: string): boolean {
  return id.slice(id.lastIndexOf("/") + 1).startsWith("leina-");
}

/** Ids of every builtin rule file, sorted. Parse failures are skipped (doctor reports them). */
async function builtinRuleIds(): Promise<string[]> {
  const ids: string[] = [];
  for (const file of await listFilesRecursive(builtinRulesDir(), ".md")) {
    const parsed = await parseRuleFile(file, "builtin");
    if ("rule" in parsed) ids.push(parsed.rule.id);
  }
  return ids.sort((a, b) => a.localeCompare(b));
}

/**
 * Builtin rule ids left GOVERNING under a preset. `generic` drops every
 * leina-coupled rule; `leina-native` keeps the whole suite. (Rules the suite
 * itself ships `enabled: false` — e.g. changelog-updated — are listed too:
 * the preset decides coupling, the rule's own frontmatter decides default state.)
 */
export async function presetRuleIds(preset: RulePreset): Promise<string[]> {
  const ids = await builtinRuleIds();
  return preset === "generic" ? ids.filter((id) => !isLeinaCoupledRuleId(id)) : ids;
}

/**
 * The `rules` overrides that realize a preset in `.harness/config.json`.
 * Empty for `leina-native` (the builtin suite governs as shipped).
 */
export async function presetRuleOverrides(
  preset: RulePreset,
): Promise<Record<string, { enabled: false }>> {
  if (preset === "leina-native") return {};
  const overrides: Record<string, { enabled: false }> = {};
  for (const id of await builtinRuleIds()) {
    if (isLeinaCoupledRuleId(id)) overrides[id] = { enabled: false };
  }
  return overrides;
}

/**
 * Full `.harness/config.json` content for a preset. `leina-native` yields the
 * pristine `{}` seed (byte-identical to what `leina init` writes); `generic`
 * yields the config that disables every leina-coupled builtin rule. Callers
 * that already have a config should merge presetRuleOverrides() instead.
 */
export async function presetConfig(preset: RulePreset): Promise<string> {
  const overrides = await presetRuleOverrides(preset);
  if (Object.keys(overrides).length === 0) return "{}\n";
  return `${JSON.stringify({ rules: overrides }, null, 2)}\n`;
}
