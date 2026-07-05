// scip.ts — GraphExtractor adapter wrapping the SCIP indexer pipeline
// (scip-proto.ts + scip-indexer.ts) behind the domain port, mirroring
// `SidecarExtractor` (sidecar.ts) as closely as the two contracts allow:
//
//   - Whole-project invocation (one indexer run covers every file of the
//     language, resolving cross-file calls the same way a compiler would).
//   - `verify()` runs the SAME code path against a small deterministic
//     fixture, never throws, and returns {status:"skip"} when the toolchain
//     (here: a third-party indexer binary) is unavailable.
//   - `extract()` NEVER throws: an unavailable indexer, a failed spawn, or a
//     partial/corrupt index all degrade to `errors` non-empty (D4 — the
//     extractor did not claim its candidate files), leaving tree-sitter to
//     process them. Confidence is always "EXTRACTED" (see scip-indexer.ts);
//     `rawCalls`/`imports` are never populated — bypasses `resolveSymbols()`.
//
// Difference from SidecarExtractor: a SCIP indexer is a THIRD-PARTY binary
// the user installs themselves (go install/npm/cargo/...) — leina only
// detects it in PATH (`resolveScipIndexer`), it never builds/bundles/
// downloads one (see scip-indexer.ts's file header and the CLI surface in
// cli/handlers/system.ts's `leina scip` group, deliberately separate from
// `leina sidecar`).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphExtractionResult, GraphExtractor, VerificationCheck } from "../../../domain/graph/extractor.ts";
import { resolveScipIndexer, runScipIndexer, scipExtensionsFor, type ScipLang } from "./scip-indexer.ts";

// src/infrastructure/extractors/semantic/ → up 4 → package root → test/fixtures/scip/<lang>
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export class ScipExtractor implements GraphExtractor {
  readonly id: string;
  readonly version: string;
  readonly lang: ScipLang;

  constructor(lang: ScipLang, version: string) {
    this.lang = lang;
    this.id = `scip-${lang}`;
    this.version = version;
  }

  supports(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    for (const ext of scipExtensionsFor(this.lang)) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  }

  async verify(): Promise<VerificationCheck> {
    if (!resolveScipIndexer(this.lang)) {
      return {
        status: "skip",
        message: `${this.lang} SCIP indexer unavailable — run \`leina scip install ${this.lang}\``,
      };
    }
    const fixtureDir = join(PKG_ROOT, "test", "fixtures", "scip", this.lang);
    const start = Date.now();
    try {
      const res = runScipIndexer(this.lang, fixtureDir);
      const durationMs = Date.now() - start;
      if (!res) {
        return { status: "skip", message: `${this.lang} SCIP indexer produced no index` };
      }
      const result: GraphExtractionResult = {
        schemaVersion: 1,
        extractor: { id: this.id, version: this.version },
        nodes: res.nodes,
        edges: res.edges,
        diagnostics: [],
        durationMs,
        errors: [],
      };
      return {
        status: "ok",
        result,
        actual: { nodes: res.nodes.length, edges: res.edges.length },
      };
    } catch (err) {
      return { status: "fail", message: (err as Error).message };
    }
  }

  async extract(root: string, files: string[]): Promise<GraphExtractionResult> {
    const base = {
      schemaVersion: 1 as const,
      extractor: { id: this.id, version: this.version },
    };

    const langFiles = files.filter((f) => this.supports(f));
    if (langFiles.length === 0) {
      return { ...base, nodes: [], edges: [], diagnostics: [], durationMs: 0, errors: [`no ${this.lang} files in candidate list`] };
    }

    if (!resolveScipIndexer(this.lang)) {
      console.error(
        `  · ${this.lang} files detected — run \`leina scip install ${this.lang}\` ` +
          `for compiler-grade precision; using tree-sitter.`,
      );
      return {
        ...base,
        nodes: [],
        edges: [],
        diagnostics: [`${this.lang} SCIP indexer not found; using tree-sitter`],
        durationMs: 0,
        errors: [`scip indexer not found for ${this.lang}`],
      };
    }

    const start = Date.now();
    try {
      const res = runScipIndexer(this.lang, root);
      if (!res) {
        return {
          ...base,
          nodes: [],
          edges: [],
          diagnostics: [`${this.lang} SCIP indexer returned no index`],
          durationMs: Date.now() - start,
          errors: [`scip indexer failed for ${this.lang}`],
        };
      }
      // Positive confirmation, same rationale as SidecarExtractor: silence here would
      // read as "tree-sitter again" — one line confirms the compiler-grade path is live.
      console.error(
        `  · [${this.id}] ${langFiles.length} ${this.lang} file(s) via SCIP compiler-grade index`,
      );
      return {
        ...base,
        nodes: res.nodes,
        edges: res.edges,
        diagnostics: [],
        durationMs: Date.now() - start,
        errors: [],
      };
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`  ! ${this.lang} SCIP indexer failed, using tree-sitter: ${msg}`);
      return {
        ...base,
        nodes: [],
        edges: [],
        diagnostics: [`${this.lang} SCIP indexer failed: ${msg}`],
        durationMs: Date.now() - start,
        errors: [msg],
      };
    }
  }
}
