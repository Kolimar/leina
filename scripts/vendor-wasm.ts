// vendor-wasm — MAINTAINER tool: copy the tree-sitter grammar .wasm files leina actually
// uses (the 11 GRAMMAR_WASM_FILES from parser-assets.ts, plus tree-sitter-yaml.wasm) from
// node_modules/tree-sitter-wasms/out INTO this package's assets/wasm/, so the published
// tarball ships its own parser assets instead of depending on the full tree-sitter-wasms
// package (36 grammars, ~50MB) at install time.
//
// tree-sitter-wasms stays a devDependency so this script keeps working across version
// bumps; it must NOT be a runtime dependency once assets/wasm/ is vendored (see
// package.json + parser-assets.ts wasmAssetsDir()).
//
// Usage:
//   node --no-warnings --experimental-strip-types scripts/vendor-wasm.ts
//
// Idempotent: clears assets/wasm/ first, then re-copies + re-hashes.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAMMAR_WASM_FILES, YAML_WASM_FILE } from "../src/infrastructure/extractors/parser-assets.ts";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let sourceDir: string;
try {
  sourceDir = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
} catch {
  console.error(
    "tree-sitter-wasms is not installed — it is a devDependency, run `npm install` first.",
  );
  process.exit(1);
}

const destDir = join(repoRoot, "assets", "wasm");

// The full set actually consumed at runtime: 11 GRAMMAR_WASM_FILES (treesitter.ts) +
// tree-sitter-yaml.wasm (yaml.ts) — kept as a Set to dedupe defensively.
const wasmFiles = [...new Set([...Object.values(GRAMMAR_WASM_FILES), YAML_WASM_FILE])].sort();

const missing = wasmFiles.filter((f) => !existsSync(join(sourceDir, f)));
if (missing.length > 0) {
  console.error(`Missing grammar wasm(s) in ${sourceDir}: ${missing.join(", ")}`);
  process.exit(1);
}

rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });

const checksums: Record<string, string> = {};
for (const file of wasmFiles) {
  const from = join(sourceDir, file);
  const to = join(destDir, file);
  cpSync(from, to);
  checksums[file] = createHash("sha256").update(readFileSync(to)).digest("hex");
}

writeFileSync(join(destDir, "checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`);

console.log(`Vendored ${wasmFiles.length} grammar wasm(s) -> ${destDir}`);
console.log(`Wrote ${join(destDir, "checksums.json")}`);
