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
  // .NET build outputs: obj/ holds generated .cs (*.g.cs, AssemblyInfo) that would
  // otherwise be indexed as sources and re-stale the graph on every dotnet build.
  // The Roslyn sidecar already skips these — keep both lists in sync.
  "obj",
  "bin",
]);

// Minified bundles (vendored vis-network, copied dist artifacts) are generated,
// unreadable code: indexing one floods the graph with meaningless one-letter god
// nodes. Match by the conventional `.min.<ext>` infix regardless of extension.
const MINIFIED_RE = /\.min\.[^.]+$/i;

/** True for conventionally-named minified artifacts (`foo.min.js`, `lib.min.mjs`, …). */
export function isMinifiedArtifact(name: string): boolean {
  return MINIFIED_RE.test(name);
}

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
        if (isMinifiedArtifact(e.name)) continue;
        if (detectLang(e.name) !== null || detectIsConfig(e.name)) found.push(full);
      }
    }
  }
  walk(root);
  return found;
}
