// parser-assets.ts — verification of the WASM parser assets treesitter.ts loads lazily.
//
// The tree-sitter stack has two on-disk prerequisites:
//   1. web-tree-sitter (the engine's own .js/.wasm runtime) — resolved from node_modules,
//      still a real runtime dependency, and
//   2. assets/wasm/<grammar>.wasm (one grammar per language) — VENDORED into this package
//      (see scripts/vendor-wasm.ts) instead of resolved from tree-sitter-wasms/out. Vendoring
//      keeps the published tarball self-contained (~5-20MB of grammars actually used) instead
//      of depending on the full tree-sitter-wasms package (36 grammars, ~50MB) at install
//      time; tree-sitter-wasms is kept only as a devDependency to re-vendor on version bumps.
// A partial or corrupted install (interrupted download, aggressive pruning, exotic package
// manager layout) previously surfaced as a bare readFileSync ENOENT stack trace mid-build.
// This module makes the same resolution treesitter.ts performs, but as a REPORT — consumed
// by `leina doctor`, by the prepack check script, and by the extractor's error path.
//
// Kept import-light on purpose (fs/module/path only, no web-tree-sitter): doctor must be
// able to diagnose a broken parser install without importing the thing that is broken.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Lang } from "../../application/graph/detect.ts";

const require = createRequire(import.meta.url);

// assets/wasm/ lives at the repo root. This file resolves to the SAME depth under both
// src/infrastructure/extractors/ (dev, --experimental-strip-types) and
// dist/infrastructure/extractors/ (published build — tsconfig.build.json mirrors src/ 1:1
// into dist/), so "../../../assets/wasm/" reaches the root in both layouts.
export function wasmAssetsDir(): string {
  return fileURLToPath(new URL("../../../assets/wasm/", import.meta.url));
}

/** Grammar wasm filename for YAML infra extraction (yaml.ts) — not part of GRAMMAR_WASM_FILES
 *  because it isn't keyed by a code `Lang`, but vendored and verified alongside it. */
export const YAML_WASM_FILE = "tree-sitter-yaml.wasm";

// Single source of truth for grammar wasm filenames (treesitter.ts consumes this map, so
// the verifier and the loader can never drift).
export const GRAMMAR_WASM_FILES: Record<Lang, string> = {
  python: "tree-sitter-python.wasm",
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  rust: "tree-sitter-rust.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
};

/** All grammar wasm filenames leina vendors/verifies: the 11 code languages + yaml infra. */
function allWasmFiles(): string[] {
  return [...Object.values(GRAMMAR_WASM_FILES), YAML_WASM_FILE];
}

export interface ParserAssetsReport {
  ok: boolean;
  /** Directory of the web-tree-sitter runtime, or null when the package cannot resolve. */
  webTreeSitterDir: string | null;
  /** Directory holding the vendored grammar .wasm files (assets/wasm/), or null when it
   *  does not exist on disk. */
  wasmsDir: string | null;
  /** Grammar wasm filenames that are missing on disk (empty when wasmsDir is null). */
  missingWasms: string[];
  /** Grammar wasm files present on disk whose sha256 does not match checksums.json
   *  (a truncated/corrupted file passes the existence check but crashes at load time). */
  corruptedWasms: string[];
  /** One-line human summary suitable for a doctor check detail. */
  detail: string;
}

/** Resolve and stat every parser asset. Never throws.
 *  `assetsDir` overrides the vendored assets/wasm/ location (tests only). */
export function verifyParserAssets(assetsDir: string = wasmAssetsDir()): ParserAssetsReport {
  let webTreeSitterDir: string | null = null;
  try {
    webTreeSitterDir = dirname(require.resolve("web-tree-sitter"));
  } catch {
    /* reported below */
  }

  const wasmsDir = existsSync(assetsDir) ? assetsDir : null;

  const files = allWasmFiles();
  const missingWasms =
    wasmsDir === null ? files : files.filter((f) => !existsSync(join(wasmsDir, f)));

  // Integrity: checksums.json is written next to the wasms by scripts/vendor-wasm.ts.
  // Verify the files that exist against it; missing files are already reported above.
  let corruptedWasms: string[] = [];
  let checksumsProblem: string | null = null;
  if (wasmsDir !== null) {
    try {
      const expected = JSON.parse(readFileSync(join(wasmsDir, "checksums.json"), "utf8")) as Record<
        string,
        string
      >;
      corruptedWasms = files.filter((f) => {
        const path = join(wasmsDir, f);
        if (!existsSync(path)) return false;
        return createHash("sha256").update(readFileSync(path)).digest("hex") !== expected[f];
      });
    } catch {
      checksumsProblem = "checksums.json missing or unreadable";
    }
  }

  const problems: string[] = [];
  if (webTreeSitterDir === null) problems.push("web-tree-sitter does not resolve");
  if (wasmsDir === null) problems.push("assets/wasm/ does not exist");
  if (wasmsDir !== null && missingWasms.length > 0) {
    problems.push(`missing grammars: ${missingWasms.join(", ")}`);
  }
  if (checksumsProblem !== null) problems.push(checksumsProblem);
  if (corruptedWasms.length > 0) {
    problems.push(`corrupted grammars (sha256 mismatch): ${corruptedWasms.join(", ")}`);
  }

  const ok = problems.length === 0;
  const detail = ok
    ? `all ${files.length} grammar wasms present and checksum-verified (${wasmsDir})`
    : problems.join("; ");
  return { ok, webTreeSitterDir, wasmsDir, missingWasms, corruptedWasms, detail };
}

/** Actionable remediation appended to extractor/doctor failures. */
export function parserAssetsAdvice(report: ParserAssetsReport): string {
  return [
    `leina's bundled parser assets are incomplete: ${report.detail}.`,
    "These are plain files vendored under assets/wasm/ (web-tree-sitter itself still",
    "resolves from node_modules) — a partial or corrupted install is the usual cause.",
    "Reinstall the package (npm i -g @kolimar/leina, or your package manager's equivalent) and",
    "re-run `leina doctor` to confirm.",
  ].join("\n");
}
