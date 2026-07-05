// cli/handlers/visualize.ts — Handler del comando `leina visualize`.
//
// Lee el grafo fresco y genera un HTML autocontenido con vis-network inlinado.
//
// WORKSPACE-AWARE (FU#1 — fix del clobber): si el directorio es la raíz de un
// workspace, NO se pasa por el freshness gate single-repo (que reconstruiría el
// directorio como UN solo repo y SOBREESCRIBIRÍA el graph.db fusionado). En su
// lugar se usa openWorkspaceFreshStore (build/merge real de los miembros) y se
// renderiza el modo "constellation" (repos como super-nodos) por defecto, o el
// modo "drilldown" (grafo mergeado coloreado por repo) con --drilldown.
//
// I/O aquí; cero I/O en renderGraphHtml/renderConstellationHtml (funciones puras).
//
// runVisualizeToFile es la implementación reutilizable (también la consume el
// executor MCP `graph_visualize`): THROW en errores — el server MCP no puede
// morir por un process.exit; los handlers CLI la envuelven con fail().

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { openFreshStore, openWorkspaceFreshStore } from "../wiring.ts";
import { detectWorkspaceMode } from "../../application/project/detect-key.ts";
import { entryAssetsRootFrom } from "../../infrastructure/install/global.ts";
import {
  deriveConstellation,
  renderConstellationHtml,
  renderGraphHtml,
} from "../../application/graph/html-export.ts";
import { fail } from "../io.ts";
import { optFlag } from "../args.ts";

interface VisualizeFlags {
  single: boolean;
  workspace: boolean;
}

export interface VisualizeResult {
  outPath: string;
  mode: "single" | "constellation" | "drilldown";
  /** single/drilldown: graph nodes; constellation: repo count. */
  nodes: number;
  /** single/drilldown: graph links; constellation: cross-repo edges. */
  edges: number;
}

/** Despacha el comando `visualize [<dir>] [--out <path>] [--drilldown] [--single|--workspace]`. */
export async function handleVisualize(rest: string[]): Promise<void> {
  await runVisualize(rest, {});
}

/**
 * `workspace visualize [<dir>] [--out <path>] [--drilldown]`
 * Forza modo workspace (equivale a `visualize <dir> --workspace`).
 */
export async function handleWorkspaceVisualize(rest: string[]): Promise<void> {
  await runVisualize(rest, { workspace: true });
}

/**
 * Implementación compartida de los handlers CLI. `force.workspace` lo invoca
 * `workspace visualize`.
 */
async function runVisualize(
  rest: string[],
  force: { workspace?: boolean } = {},
): Promise<void> {
  // Parsear dir (primer arg que no empieza con "--") y flags
  const dirArg = rest.find((a) => !a.startsWith("--")) ?? ".";
  let result: VisualizeResult;
  try {
    result = await runVisualizeToFile(resolve(dirArg), {
      out: optFlag(rest, "--out", undefined),
      drilldown: rest.includes("--drilldown"),
      single: rest.includes("--single"),
      workspace: rest.includes("--workspace") || force.workspace === true,
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const detail =
    result.mode === "constellation"
      ? `[constellation] (${result.nodes} repos, ${result.edges} cross-repo edges)`
      : result.mode === "drilldown"
        ? `[drilldown] (${result.nodes} nodes, ${result.edges} edges)`
        : `(${result.nodes} nodes, ${result.edges} edges)`;
  console.log(`Exported graph.html ${detail} -> ${result.outPath}`);
}

/**
 * Genera el HTML del grafo en disco y devuelve la ruta + métricas. Sin console.log
 * y sin process.exit: los errores se lanzan como Error (transport-agnóstico).
 */
export async function runVisualizeToFile(
  root: string,
  opts: { out?: string; drilldown?: boolean; single?: boolean; workspace?: boolean } = {},
): Promise<VisualizeResult> {
  const wantDrilldown = opts.drilldown === true;
  const flags: VisualizeFlags = {
    single: opts.single === true,
    workspace: opts.workspace === true,
  };

  const outPath = opts.out ?? join(root, ".leina", "graph.html");

  // Resolver assets root a partir del script de entrada (mismo patrón que install.ts L39-43)
  const assetsRoot = entryAssetsRootFrom(process.argv[1] ?? ".");
  const visPath = join(assetsRoot, "vis-network", "vis-network.min.js");

  if (!existsSync(visPath)) {
    throw new Error(
      `vis-network no encontrado en ${visPath}.\n` +
        `Ejecuta: leina activate`,
    );
  }

  const visJs = readFileSync(visPath, "utf8");
  const projectName = basename(root);

  // Detección de modo: respeta --single/--workspace; si no, auto-detecta.
  const detection = detectWorkspaceMode(root, flags);

  if (detection.mode === "workspace") {
    // WORKSPACE: build/merge real (NO clobbea el grafo fusionado) y render de 2 niveles.
    const store = await openWorkspaceFreshStore(root, flags);
    try {
      const graph = store.toNodeLink();
      const { repoStats, crossEdges } = deriveConstellation(store.allNodes(), store.allEdges());

      const artifact = wantDrilldown
        ? renderGraphHtml(graph, visJs, { projectName, mode: "drilldown" })
        : renderConstellationHtml(repoStats, crossEdges, visJs, { projectName });

      writeHtml(outPath, artifact.content);

      return wantDrilldown
        ? { outPath, mode: "drilldown", nodes: graph.nodes.length, edges: graph.links.length }
        : { outPath, mode: "constellation", nodes: repoStats.size, edges: crossEdges.length };
    } finally {
      store.close();
    }
  }

  // SINGLE-REPO: comportamiento clásico (auto-rebuild si stale + postura auto).
  const p = join(root, ".leina", "graph.db");
  if (!existsSync(p)) throw new Error(`No graph at ${p}. Run: leina build ${root}`);
  const store = await openFreshStore(root);
  try {
    const graph = store.toNodeLink();
    const artifact = renderGraphHtml(graph, visJs, { projectName });
    writeHtml(outPath, artifact.content);
    return { outPath, mode: "single", nodes: graph.nodes.length, edges: graph.links.length };
  } finally {
    store.close();
  }
}

/** Escribe el HTML, creando el directorio de salida si hace falta. */
function writeHtml(outPath: string, content: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, "utf8");
}
