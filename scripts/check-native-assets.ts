// Native/bundled asset gate, run before tests and prepack. Two independent checks:
//   1. WASM parser assets — web-tree-sitter must resolve and every grammar vendored under
//      assets/wasm/ must exist on disk (a publish/test must never ship a build that cannot
//      parse; these are plain files, so absence means a broken install or a missed
//      `npm run vendor:wasm`).
//   2. Reference scan — fail fast if committed text contains any maintainer-configured
//      forbidden string (list loads from $LEINA_FORBIDDEN_REFS / ~/.leina/forbidden-refs.json;
//      the list itself deliberately lives outside the repo). Skipped when not configured.

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenReferences, loadForbiddenNeedles } from "../src/infrastructure/install/native-assets.ts";
import { parserAssetsAdvice, verifyParserAssets } from "../src/infrastructure/extractors/parser-assets.ts";

const parserReport = verifyParserAssets();
if (!parserReport.ok) {
  console.error("Leina parser-asset check failed:");
  console.error(`  ${parserAssetsAdvice(parserReport).split("\n").join("\n  ")}`);
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ignoredDirs = new Set([".git", ".leina", ".atl", "node_modules"]);
const textExtensions = new Set([
  ".cs",
  ".json",
  ".java",
  ".js",
  ".md",
  ".tmpl",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);

const violations: string[] = [];

// Walk directories via Dirent entries (withFileTypes) so the file/dir decision comes from the
// parent listing — never a separate statSync(path) followed by readFileSync(path) on the same
// name (that check→use split is a TOCTOU race, CodeQL js/file-system-race).
function scan(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) scan(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!textExtensions.has(extname(full).toLowerCase())) continue;

    const content = readFileSync(full, "utf8");
    for (const hit of findForbiddenReferences(content, needles)) {
      violations.push(`${relative(repoRoot, full)}:${hit.line}:${hit.column} ${hit.needle}`);
    }
  }
}

const needles = loadForbiddenNeedles();

if (needles.length > 0) {
  scan(repoRoot);
}

if (violations.length > 0) {
  console.error("Leina native-asset check failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(
  `Leina native-asset check passed (${parserReport.detail}; ` +
    `${needles.length > 0 ? "reference scan clean" : "reference scan skipped — no maintainer list configured"}).`,
);
