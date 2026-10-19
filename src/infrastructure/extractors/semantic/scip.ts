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

import { relative } from "node:path";
import type { GraphExtractionResult, GraphExtractor, VerificationCheck } from "../../../domain/graph/extractor.ts";
import { isAuxiliarySourcePath } from "../../../application/graph/detect.ts";
import { resolveScipIndexer, runScipIndexer, scipExtensionsFor, type ScipLang } from "./scip-indexer.ts";
import { missingFixtureProblem, verifyFixtureDir } from "./verify-fixtures.ts";

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
    // The shipped fixture (assets/fixtures/scip/<lang>), so verify works from an install.
    const fixtureDir = verifyFixtureDir("scip", this.lang);
    const problem = missingFixtureProblem(fixtureDir);
    if (problem) return { status: "fail", message: problem };
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
      // Only product code makes "install an indexer" actionable — a lone fixture or vendored
      // file of this language says nothing about the project.
      const primary = langFiles.filter((f) => !isAuxiliarySourcePath(relative(root, f))).length;
      return {
        ...base,
        nodes: [],
        edges: [],
        diagnostics: [],
        degraded: primary > 0
          ? [`${this.lang}: ${primary} file(s) via tree-sitter (syntactic) — run \`leina scip install ${this.lang}\`, then \`leina refresh\`, for compiler-grade precision`]
          : [],
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
          diagnostics: [],
          degraded: [`${this.lang}: SCIP indexer produced no index; ${langFiles.length} file(s) via tree-sitter`],
          durationMs: Date.now() - start,
          errors: [`scip indexer failed for ${this.lang}`],
        };
      }
      return {
        ...base,
        nodes: res.nodes,
        edges: res.edges,
        // Positive confirmation, same rationale as SidecarExtractor: silence here would
        // read as "tree-sitter again" — one line confirms the compiler-grade path is live.
        diagnostics: [`${langFiles.length} ${this.lang} file(s) via SCIP compiler-grade index`],
        durationMs: Date.now() - start,
        errors: [],
      };
    } catch (err) {
      const msg = (err as Error).message;
      const line = msg.split("\n").find((l) => l.trim() !== "")?.trim() ?? msg;
      return {
        ...base,
        nodes: [],
        edges: [],
        diagnostics: [],
        degraded: [`${this.lang}: SCIP indexer failed (${line.slice(0, 200)}); ${langFiles.length} file(s) via tree-sitter`],
        durationMs: Date.now() - start,
        errors: [msg],
      };
    }
  }
}
