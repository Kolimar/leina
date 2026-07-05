// Build orchestrator: walk a directory, extract each file, resolve symbols,
// dedup, and load into the store.
//
// Recibe un `registry: GraphExtractor[]` inyectado desde el composition root
// (src/cli/wiring.ts). El orden del registry determina qué extractor procesa
// cada archivo; un extractor "reclama" sus archivos cuando result.errors está vacío
// (señal D4). Los archivos no reclamados caen al siguiente extractor / al fallback
// tree-sitter.
//
// OVERRIDE D1 (aprobado por orchestrador):
// resolveSymbols() permanece GLOBAL aquí sobre el combined set de rawCalls/imports
// de TODOS los extractores. TreesitterExtractor devuelve rawCalls?/imports? sin
// resolver; tsmorph y sidecars los dejan undefined. Esto preserva edges
// cross-extractor/cross-file byte-idénticos al pipeline previo (REQ-ER-4).
// Esta desviación es INTENCIONAL respecto a REQ-EP-3.

import type { GraphEdge, GraphNode, ImportBinding, RawCall } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import type { GraphExtractor } from "../../domain/graph/extractor.ts";
import { semanticLangOf } from "./detect.ts";
import { resolve as resolveSymbols } from "./resolve.ts";
import { dedup } from "./dedup.ts";
import { listSourceFiles } from "./sources.ts";
import { writeManifest } from "./manifest.ts";
import { detectCommunities } from "./community.ts";

// Re-exported for back-compat: source enumeration now lives in sources.ts so the
// freshness layer can import it without pulling in the extractor stack.
export { listSourceFiles } from "./sources.ts";

export interface BuildReport {
  filesScanned: number;
  filesExtracted: number;
  semanticViaTreesitter: number; // C#/Java handled syntactically (sidecar would upgrade)
  nodes: number;
  edges: number;
  /** Wall-clock per stage — always collected (a handful of Date.now() calls); the CLI
   *  prints it under `build --profile`. Extractor entries come from each adapter's own
   *  durationMs, so they include any internal caching wins. */
  timings: BuildTimings;
}

export interface BuildTimings {
  listMs: number;
  extractors: { id: string; files: number; ms: number }[];
  resolveMs: number;
  dedupMs: number;
  persistMs: number;
  communitiesMs: number;
  manifestMs: number;
  totalMs: number;
}

/** Mutable accumulator threaded through the extractor loop. */
interface ExtractionAcc {
  allNodes: GraphNode[];
  allEdges: GraphEdge[];
  // Combined set para resolveSymbols() global (OVERRIDE D1)
  allRaw: RawCall[];
  allImports: ImportBinding[];
  extracted: number;
  semanticViaTreesitter: number;
  handled: Set<string>;
}

/** Run a single extractor over its candidate files; null on unexpected throw. */
async function runExtractor(
  ext: GraphExtractor,
  root: string,
  cand: string[],
): Promise<Awaited<ReturnType<GraphExtractor["extract"]>> | null> {
  try {
    return await ext.extract(root, cand);
  } catch (err) {
    // El extractor lanzó de forma inesperada — continuar (no bloquear el build)
    console.error(`  ! ${ext.id} extractor threw: ${(err as Error).message}`);
    return null;
  }
}

/** Mark candidate files as claimed and tally semantic tree-sitter coverage. */
function recordClaimed(ext: GraphExtractor, cand: string[], acc: ExtractionAcc): void {
  for (const f of cand) {
    acc.handled.add(f);
    acc.extracted++;
  }
  // Contar archivos con lenguaje semántico (C#/Java) procesados por tree-sitter
  if (ext.id === "treesitter") {
    for (const f of cand) {
      if (semanticLangOf(f)) acc.semanticViaTreesitter++;
    }
  }
}

/** Process one extractor: accumulate its results into `acc`. */
async function processExtractor(
  ext: GraphExtractor,
  root: string,
  files: string[],
  acc: ExtractionAcc,
): Promise<void> {
  // Archivos candidatos: los que este extractor soporta y aún no han sido reclamados
  const cand = files.filter((f) => ext.supports(f) && !acc.handled.has(f));
  if (cand.length === 0) return;

  const result = await runExtractor(ext, root, cand);
  if (!result) return;

  // Log de mensajes informativos del extractor
  for (const d of result.diagnostics) {
    console.error(`  · [${ext.id}] ${d}`);
  }

  // Acumular nodos/edges
  acc.allNodes.push(...result.nodes);
  acc.allEdges.push(...result.edges);

  // Acumular rawCalls/imports para resolveSymbols() global (OVERRIDE D1)
  if (result.rawCalls) acc.allRaw.push(...result.rawCalls);
  if (result.imports) acc.allImports.push(...result.imports);

  // D4: solo marca como "handled" si errors está vacío (el extractor los reclamó con éxito)
  if (result.errors.length === 0) {
    recordClaimed(ext, cand, acc);
  }
}

export async function buildGraph(
  root: string,
  store: GraphRepository,
  registry: GraphExtractor[],
): Promise<BuildReport> {
  const t0 = Date.now();
  const files = listSourceFiles(root);
  const listMs = Date.now() - t0;
  const extractorTimings: BuildTimings["extractors"] = [];
  const acc: ExtractionAcc = {
    allNodes: [],
    allEdges: [],
    allRaw: [],
    allImports: [],
    extracted: 0,
    semanticViaTreesitter: 0,
    handled: new Set<string>(),
  };

  for (const ext of registry) {
    const before = acc.handled.size;
    const tExt = Date.now();
    await processExtractor(ext, root, files, acc);
    extractorTimings.push({ id: ext.id, files: acc.handled.size - before, ms: Date.now() - tExt });
  }

  const { allNodes, allEdges, allRaw, allImports } = acc;

  // resolveSymbols() GLOBAL sobre el combined set — preserva edges cross-extractor
  const tResolve = Date.now();
  const resolved = resolveSymbols(allNodes, allEdges, allRaw, allImports);
  const resolveMs = Date.now() - tResolve;
  const tDedup = Date.now();
  const clean = dedup(resolved.nodes, resolved.edges);
  const dedupMs = Date.now() - tDedup;

  const tPersist = Date.now();
  // Prefer the atomic single-transaction swap (closes the empty-graph window for
  // concurrent readers); fall back to the 3-call sequence for repositories that don't
  // implement the optional replaceGraph (e.g. read-only overlay repos).
  if (store.replaceGraph) {
    store.replaceGraph(clean.nodes, clean.edges);
  } else {
    store.clear();
    store.addNodes(clean.nodes);
    store.addEdges(clean.edges);
  }
  const persistMs = Date.now() - tPersist;

  // Detect communities with Louvain and persist them back to the store.
  const tComm = Date.now();
  const communityMap = detectCommunities(clean.nodes, clean.edges);
  const assignments = [...communityMap.entries()].map(([id, community]) => ({ id, community }));
  store.updateCommunities(assignments);
  const communitiesMs = Date.now() - tComm;

  // Record the source set + mtimes so the server can detect a stale graph and
  // self-refresh. Reuses the file list already computed above (no second walk).
  const tManifest = Date.now();
  writeManifest(root, files);
  const manifestMs = Date.now() - tManifest;

  return {
    filesScanned: files.length,
    filesExtracted: acc.extracted,
    semanticViaTreesitter: acc.semanticViaTreesitter,
    nodes: clean.nodes.length,
    edges: clean.edges.length,
    timings: {
      listMs,
      extractors: extractorTimings,
      resolveMs,
      dedupMs,
      persistMs,
      communitiesMs,
      manifestMs,
      totalMs: Date.now() - t0,
    },
  };
}
