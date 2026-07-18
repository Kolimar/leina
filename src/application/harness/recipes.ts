// application/harness/recipes.ts — golden-path recipe loading. Builtin recipes
// ship under assets/harness/recipes/; a project may add or override them in
// `.harness/recipes/` (override key: recipe name). Only their terminal gates
// are enforceable; the value is variance reduction.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Recipe } from "../../domain/harness/model.ts";
import { parseFrontmatter } from "../../domain/harness/frontmatter.ts";
import { validateRecipeFrontmatter } from "../../domain/harness/validate.ts";
import { harnessDir } from "./config-io.ts";
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
