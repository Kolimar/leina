// Semantic sidecar contract for C#/Java.
//
// tree-sitter gives us a SYNTACTIC tree: it sees "a call to `bar`" but cannot
// tell WHICH `bar` when names collide (overloads, same name in many modules).
// For C# and Java we delegate to a real compiler front-end that resolves names
// and types, so the edges it returns are EXTRACTED (compiler-proven), not
// INFERRED heuristics.
//
// A sidecar is any external executable that:
//   1. takes a file (or directory) path as its last CLI argument,
//   2. prints a single JSON object to stdout in the canonical shape below,
//   3. exits 0 on success.
//
// leina shells out to it. The sidecar owns symbol resolution, so it returns
// finished nodes+edges and an empty rawCalls list.
//
//   C# -> a small dotnet tool using Microsoft.CodeAnalysis (Roslyn).
//   Java -> a small tool using Eclipse JDT or javaparser + symbol solver.
//
// Configure via env vars (absent in this machine — no .NET SDK installed):
//   LEINA_CSHARP_SIDECAR="dotnet /path/RoslynGraph.dll"
//   LEINA_JAVA_SIDECAR="java -jar /path/jdt-graph.jar"

import { spawnSync } from "node:child_process";
import type { ExtractionResult, GraphEdge, GraphNode } from "../../../domain/graph/model.ts";
import type { SemanticLang } from "../../../application/graph/detect.ts";
import { builtBinaryPath, isSidecarBuilt } from "./sidecar-build.ts";

export interface SidecarPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Where an on-demand-built sidecar lands: ~/.leina/sidecars/<lang>/dist.
// Both sidecars embed their runtime (C#: self-contained single file; Java:
// jpackage app-image with a bundled JRE), so a user runs them with no .NET/JVM
// installed once built. Auto-detected so users don't set anything; an env var
// override still wins. See sidecar-build.ts for how the cache is produced.
function bundledBinary(lang: SemanticLang): string | null {
  return isSidecarBuilt(lang) ? builtBinaryPath(lang) : null;
}

function sidecarCommand(lang: SemanticLang): string | null {
  const v =
    lang === "csharp"
      ? process.env.LEINA_CSHARP_SIDECAR
      : process.env.LEINA_JAVA_SIDECAR;
  return v && v.trim().length > 0 ? v.trim() : null;
}

// Resolve how to invoke the sidecar: env override first, then a bundled
// self-contained binary. Returns argv parts (bin + any prefix args), or null.
export function resolveSidecar(lang: SemanticLang): string[] | null {
  const env = sidecarCommand(lang);
  if (env) return env.split(/\s+/);
  const bin = bundledBinary(lang);
  return bin ? [bin] : null;
}

export function isSidecarConfigured(lang: SemanticLang): boolean {
  return resolveSidecar(lang) !== null;
}

function spawnSidecar(lang: SemanticLang, target: string): SidecarPayload {
  const parts = resolveSidecar(lang)!;
  const bin = parts[0]!;
  const args = [...parts.slice(1), target];
  const proc = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

  if (proc.status !== 0) {
    throw new Error(
      `semantic sidecar (${lang}) failed on ${target}: ${proc.stderr || proc.error?.message || "non-zero exit"}`,
    );
  }
  try {
    return JSON.parse(proc.stdout) as SidecarPayload;
  } catch {
    throw new Error(`semantic sidecar (${lang}) returned invalid JSON for ${target}`);
  }
}

// Project-level: the compiler sidecar (Roslyn/JDT) needs the WHOLE project in one
// compilation to resolve cross-file calls. Invoked ONCE with the root directory;
// returns finished nodes+edges for every file of this language. Mirrors how
// extractTsProject handles TypeScript. Returns null when no sidecar is available.
export function runSemanticSidecarProject(
  lang: SemanticLang,
  root: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
  if (!resolveSidecar(lang)) return null;
  const payload = spawnSidecar(lang, root);
  return { nodes: payload.nodes, edges: payload.edges };
}

// Per-file invocation. DEPRECATED for compiler sidecars (a single-file
// compilation can't resolve cross-file calls); prefer runSemanticSidecarProject.
// Returns null when no sidecar is configured for this language (caller skips).
export function runSemanticSidecar(
  lang: SemanticLang,
  filePath: string,
): ExtractionResult | null {
  if (!resolveSidecar(lang)) return null;
  const payload = spawnSidecar(lang, filePath);
  // Sidecar resolves symbols itself, so there are no raw calls or imports left.
  return { nodes: payload.nodes, edges: payload.edges, rawCalls: [], imports: [] };
}

// ---------------------------------------------------------------------------
// GraphExtractor adapter — wraps runSemanticSidecarProject en el puerto de dominio.
// ---------------------------------------------------------------------------

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSidecar, missingTools } from "./sidecar-build.ts";
import type { GraphExtractor, GraphExtractionResult, VerificationCheck } from "../../../domain/graph/extractor.ts";

// Ruta al directorio de fixtures de prueba: src/infrastructure/extractors/semantic/ → arriba 4 → paquete root → test/fixtures/<lang>
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function ensureSidecarAdapter(lang: SemanticLang): boolean {
  if (isSidecarConfigured(lang)) return true;
  if (process.env.LEINA_BUILD_SIDECARS) {
    console.error(`  · building ${lang} semantic sidecar (first use)...`);
    const res = buildSidecar(lang);
    if (res.ok) return true;
    console.error(`  ! ${lang} sidecar build failed (${res.error}); using tree-sitter.`);
    return false;
  }
  console.error(
    `  · ${lang} files detected — run \`leina sidecar build ${lang}\` ` +
      `(or set LEINA_BUILD_SIDECARS=1) for compiler-grade precision; using tree-sitter.`,
  );
  return false;
}

export class SidecarExtractor implements GraphExtractor {
  readonly id: string;
  readonly version: string;
  readonly lang: SemanticLang;

  constructor(lang: SemanticLang, version: string) {
    this.lang = lang;
    this.id = `sidecar-${lang}`;
    this.version = version;
  }

  supports(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    if (this.lang === "csharp") return lower.endsWith(".cs");
    if (this.lang === "java") return lower.endsWith(".java");
    return false;
  }

  async verify(): Promise<VerificationCheck> {
    const missing = missingTools(this.lang);
    if (missing.length > 0) {
      return {
        status: "skip",
        message: `toolchain unavailable for ${this.lang} — missing tools in PATH: ${missing.join(", ")}`,
      };
    }
    // Verificación con fixture determinista
    const fixtureDir = join(PKG_ROOT, "test", "fixtures", this.lang);
    const start = Date.now();
    try {
      const res = runSemanticSidecarProject(this.lang, fixtureDir);
      const durationMs = Date.now() - start;
      if (!res) {
        return { status: "skip", message: `sidecar not configured for ${this.lang}` };
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
      const msg = (err as Error).message;
      return {
        status: "fail",
        message: msg,
      };
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

    if (!ensureSidecarAdapter(this.lang)) {
      return {
        ...base,
        nodes: [],
        edges: [],
        diagnostics: [`${this.lang} sidecar not configured; using tree-sitter`],
        durationMs: 0,
        errors: [`sidecar not configured for ${this.lang}`],
      };
    }

    const start = Date.now();
    try {
      const res = runSemanticSidecarProject(this.lang, root);
      if (!res) {
        return {
          ...base,
          nodes: [],
          edges: [],
          diagnostics: [`${this.lang} sidecar returned null`],
          durationMs: Date.now() - start,
          errors: [`sidecar returned null for ${this.lang}`],
        };
      }
      // Positive confirmation: the fallback path announces itself, so silence here reads
      // as "tree-sitter again". One line tells the user the compiler-grade path is live.
      console.error(
        `  · [${this.id}] ${langFiles.length} ${this.lang} file(s) via compiler-grade sidecar`,
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
      console.error(`  ! ${this.lang} sidecar failed, using tree-sitter: ${msg}`);
      return {
        ...base,
        nodes: [],
        edges: [],
        diagnostics: [`${this.lang} sidecar failed: ${msg}`],
        durationMs: Date.now() - start,
        errors: [msg],
      };
    }
  }
}
