// application/harness/adapters/bundle.ts — assembles the RuleBundle every
// adapter renders from: resolved+enabled rules (loader+resolver), golden-path
// recipes, layered config, and the canonical sha256 digest that becomes the
// lockfile's sourceHash. The digest is stable: same inputs → same hash →
// `sync --check` reports "up to date".
//
// COMMITTED LAYERS ONLY: everything sync writes is committed, so the bundle is
// built from builtin + project rules and the project config.json — never the
// personal layers ($LEINA_HOME/harness rules/config, .harness/config.local.json).
// A personal rule compiled into CLAUDE.md would leak into the repo and make a
// clean CI checkout fail `sync --check`. Personal layers still govern verify
// and the hooks locally.

import { loadResolvedRules } from "../resolver.ts";
import { loadRecipes } from "../recipes.ts";
import { sha256 } from "./managed-block.ts";
import { type RuleBundle } from "./types.ts";

export interface BundleResult {
  bundle: RuleBundle;
  errors: string[];
  warnings: string[];
}

export async function buildBundle(repoRoot: string): Promise<BundleResult> {
  const [resolution, recipeLoad] = await Promise.all([
    loadResolvedRules(repoRoot, { committedOnly: true }),
    loadRecipes(repoRoot),
  ]);
  const rules = resolution.rules.filter((r) => r.enabled);
  const digest = sha256(
    JSON.stringify(
      rules.map((r) => ({
        id: r.id,
        version: r.version,
        phase: r.phase,
        severity: r.severity,
        scope: r.scope,
        tags: r.tags,
        summary: r.summary ?? null,
        gate: r.gate ?? null,
        body: r.body,
      })),
    ) +
      sha256(
        JSON.stringify(
          recipeLoad.recipes.map((r) => ({ name: r.name, description: r.description, body: r.body })),
        ),
      ),
  );
  return {
    bundle: { rules, recipes: recipeLoad.recipes, config: resolution.config, digest },
    errors: [...resolution.errors, ...recipeLoad.errors],
    warnings: resolution.warnings,
  };
}
