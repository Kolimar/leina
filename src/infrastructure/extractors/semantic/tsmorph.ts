// Semantic TypeScript extractor using ts-morph (the TS compiler API).
//
// Unlike the tree-sitter path (syntactic, heuristic name matching), this uses
// the real type checker: every call/reference is resolved to its EXACT
// declaration via the checker's symbols. That means edges are compiler-proven
// (EXTRACTED), with no AMBIGUOUS guessing — overloads, imports, re-exports and
// generics all resolve correctly.
//
// Runs in-process (ts-morph bundles TypeScript), so no external toolchain. ts-morph
// builds the Program (tsconfig, lib files, module resolution); the walk itself runs
// on the raw compiler API, one file at a time (ts-file-extract.ts), against ids
// computed from each file's syntax alone (ts-defs.ts).

import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Project, type ts } from "ts-morph";
import type { GraphEdge, GraphNode } from "../../../domain/graph/model.ts";
import { collectDefs, type FileDefs } from "./ts-defs.ts";
import { extractTsFile, type TsFileResult, type TsProgramEnv } from "./ts-file-extract.ts";

export function isTsMorphAvailable(): boolean {
  return true; // bundled dependency
}

const toPosix = (p: string): string => p.split(sep).join("/");

function createProject(root: string): Project {
  const tsconfig = join(root, "tsconfig.json");
  return existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ compilerOptions: { allowJs: true, skipLibCheck: true } });
}

/**
 * The checker view shared by every per-file extraction of one run. `listed` is the set of
 * files that get graph nodes (absolute POSIX paths); declarations anywhere else (lib,
 * node_modules, unlisted project files) are never edge targets.
 */
function programEnv(project: Project, root: string, listed: ReadonlySet<string>): TsProgramEnv {
  const program = project.getProgram().compilerObject;
  const checker = program.getTypeChecker();
  const defsCache = new Map<ts.SourceFile, FileDefs | undefined>();
  return {
    program,
    checker,
    defsOf(sf: ts.SourceFile): FileDefs | undefined {
      if (defsCache.has(sf)) return defsCache.get(sf);
      const defs = listed.has(sf.fileName) ? collectDefs(sf, toPosix(relative(root, sf.fileName))) : undefined;
      defsCache.set(sf, defs);
      return defs;
    },
  };
}

/**
 * Extract `files` (absolute paths, all already listed) with one Program rooted at `roots`.
 * Returns the per-file results keyed by the input path.
 */
function extractWithProgram(
  root: string,
  listedFiles: readonly string[],
  files: readonly string[],
): Map<string, TsFileResult> {
  const project = createProject(root);
  for (const f of files) project.addSourceFileAtPath(f);
  const listed = new Set(listedFiles.map((f) => toPosix(resolve(f))));
  const env = programEnv(project, root, listed);
  const out = new Map<string, TsFileResult>();
  for (const f of files) {
    const sf = env.program.getSourceFile(toPosix(resolve(f)));
    if (sf === undefined) continue;
    out.set(f, extractTsFile(env, sf));
  }
  return out;
}

export function extractTsProject(
  root: string,
  tsFiles: string[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const results = extractWithProgram(root, tsFiles, tsFiles);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const f of tsFiles) {
    const r = results.get(f);
    if (r === undefined) continue;
    nodes.push(...r.nodes);
    edges.push(...r.edges);
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// GraphExtractor adapter — wraps extractTsProject en el puerto de dominio.
// ---------------------------------------------------------------------------

import { detectLang } from "../../../application/graph/detect.ts";
import type { GraphExtractor, GraphExtractionResult } from "../../../domain/graph/extractor.ts";

export class TsmorphExtractor implements GraphExtractor {
  readonly id = "tsmorph" as const;
  readonly version: string;

  constructor(version: string) {
    this.version = version;
  }

  supports(filePath: string): boolean {
    const l = detectLang(filePath);
    return l === "typescript" || l === "tsx";
  }

  async extract(root: string, files: string[]): Promise<GraphExtractionResult> {
    const base = {
      schemaVersion: 1 as const,
      extractor: { id: this.id, version: this.version },
    };

    // Deshabilitado por variable de entorno → señal D4 (errors no vacío → no handled)
    if (process.env.LEINA_NO_TSMORPH) {
      return { ...base, nodes: [], edges: [], diagnostics: [], durationMs: 0, errors: ["disabled by LEINA_NO_TSMORPH"] };
    }

    const tsFiles = files.filter((f) => {
      const l = detectLang(f);
      return l === "typescript" || l === "tsx";
    });
    if (tsFiles.length === 0) {
      return { ...base, nodes: [], edges: [], diagnostics: [], durationMs: 0, errors: ["no typescript files in candidate list"] };
    }

    const start = Date.now();
    try {
      const res = extractTsProject(root, tsFiles);
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
      console.error(`  ! ts-morph failed, using tree-sitter for TS: ${msg}`);
      return {
        ...base,
        nodes: [],
        edges: [],
        diagnostics: [`ts-morph failed → tree-sitter: ${msg}`],
        durationMs: Date.now() - start,
        errors: [msg],
      };
    }
  }
}
