// Source-file enumeration — the set of files the graph is built from.
// Extracted from build.ts so the freshness/manifest layer can list sources
// without pulling in the heavy extractor stack (tree-sitter, ts-morph, sidecars).

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { detectLang } from "./detect.ts";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "target",
]);

/**
 * Returns true for `.yml` and `.yaml` files (infra config sources).
 * `detectLang()` in detect.ts is NOT modified — it remains code-only.
 */
export function detectIsConfig(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = path.slice(dot).toLowerCase();
  return ext === ".yml" || ext === ".yaml";
}

export function listSourceFiles(root: string): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        // Include code files (detectLang) OR YAML infra config (detectIsConfig).
        // The fine-grained routing (which extractor handles what) is done later by
        // ext.supports() in build.ts — here we just discover candidates.
        if (detectLang(e.name) !== null || detectIsConfig(e.name)) found.push(full);
      }
    }
  }
  walk(root);
  return found;
}
