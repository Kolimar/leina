// application/harness/loader.ts — loads harness rules from the three layers:
//   builtin  — bundled with the package under assets/harness/rules/
//   project  — <repo>/.harness/rules/
//   user     — $LEINA_HOME/harness/rules/ (default ~/.leina/harness/rules/)
//
// Rule files are markdown with JSON frontmatter (domain/harness/frontmatter.ts)
// validated by domain/harness/validate.ts. No merging here — resolver.ts owns
// precedence and the anti-weakening invariant.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Rule, type RuleLayer } from "../../domain/harness/model.ts";
import { parseFrontmatter } from "../../domain/harness/frontmatter.ts";
import { makeRule, validateRuleFrontmatter } from "../../domain/harness/validate.ts";
import { harnessDir, userHarnessDir } from "./config-io.ts";
import { listFilesRecursive, readTextIfExists } from "./io.ts";

export interface LoadedRules {
  rules: Rule[];
  errors: string[];
}

/**
 * Directory of rule files shipped inside the package. Anchored to this module:
 * src/application/harness/ (dev) or dist/application/harness/ (built) → three
 * levels up is the package root, where assets/ lives.
 */
export function builtinRulesDir(): string {
  return fileURLToPath(new URL("../../../assets/harness/rules/", import.meta.url));
}

export function projectRulesDir(repoRoot: string): string {
  return path.join(harnessDir(repoRoot), "rules");
}

export function userRulesDir(): string {
  return path.join(userHarnessDir(), "rules");
}

export async function parseRuleFile(
  file: string,
  layer: RuleLayer,
): Promise<{ rule: Rule } | { error: string }> {
  const text = await readTextIfExists(file);
  if (text === undefined) return { error: `${file}: not found` };

  const doc = parseFrontmatter(text);
  if (!doc.ok) return { error: `${file}: ${doc.error}` };

  const front = validateRuleFrontmatter(doc.value.data);
  if (!front.ok) return { error: `${file}: ${front.errors.join("; ")}` };

  return { rule: makeRule(front.value, doc.value.body, file, layer) };
}

async function loadRulesFromDir(dir: string, layer: RuleLayer): Promise<LoadedRules> {
  const rules: Rule[] = [];
  const errors: string[] = [];
  for (const file of await listFilesRecursive(dir, ".md")) {
    const parsed = await parseRuleFile(file, layer);
    if ("error" in parsed) errors.push(parsed.error);
    else rules.push(parsed.rule);
  }
  return { rules, errors };
}

/**
 * Load rules from every layer, in replace-precedence order (builtin, project,
 * user). No merging here — the resolver owns precedence and enforcement
 * invariants. `committedOnly` skips the personal user layer (what `harness
 * sync` compiles into committed files).
 */
export async function loadAllRules(
  repoRoot: string,
  opts: { committedOnly?: boolean } = {},
): Promise<LoadedRules> {
  const layers: { dir: string; layer: RuleLayer }[] = [
    { dir: builtinRulesDir(), layer: "builtin" },
    { dir: projectRulesDir(repoRoot), layer: "project" },
    ...(opts.committedOnly ? [] : [{ dir: userRulesDir(), layer: "user" as const }]),
  ];
  const rules: Rule[] = [];
  const errors: string[] = [];
  for (const { dir, layer } of layers) {
    const loaded = await loadRulesFromDir(dir, layer);
    rules.push(...loaded.rules);
    errors.push(...loaded.errors);
  }
  return { rules, errors };
}
