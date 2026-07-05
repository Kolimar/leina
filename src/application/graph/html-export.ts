// application/graph/html-export.ts — Pure HTML writer for the interactive graph visualisation.
//
// Produces a single self-contained HTML file with vis-network inlined (offline, no CDN).
// All user-derived strings are HTML-escaped (XSS-safe); the JSON payload additionally has
// every "</" replaced with "<\/" so it never accidentally closes the outer <script> block.
//
// Responsibilities: colour nodes by community (palette) or top-level folder (fallback),
// size by bidirectional non-contains degree (A5), emphasise god nodes (top-12), render
// INFERRED edges as dashed, and include search / physics-toggle / group-filter controls.

import { basename } from "node:path";
import type { FileArtifact } from "../../domain/install/artifact.ts";
import type { GraphEdge, GraphNode, NodeLinkGraph, Signature } from "../../domain/graph/model.ts";

export interface RenderOpts {
  projectName: string;
  /**
   * Rendering mode:
   *   "single"        — default: full single-repo graph (existing behaviour, NFR-02)
   *   "constellation" — workspace overview: repos as super-nodes, cross-repo edges
   *   "drilldown"     — merged graph coloured/filtered by repo; shows all repos
   */
  mode?: "single" | "constellation" | "drilldown";
  /** For "drilldown" mode: repo key to highlight (optional). Dims others. */
  selectedRepo?: string;
}

// Colores por capa/carpeta top-level. El agrupado/coloreo es por carpeta (nombres
// legibles en la leyenda: domain, application, …); la comunidad detectada se conserva
// como dato del nodo y se muestra en el drawer, pero no determina el color.
const LAYER_COLORS: Readonly<Record<string, string>> = {
  domain:         "#f0b429",
  application:    "#58a6ff",
  infrastructure: "#3fb950",
  cli:            "#bc8cff",
  shared:         "#79c0ff",
  test:           "#6e7681",
  scripts:        "#d29922",
  docs:           "#db61a2",
  other:          "#484f58",
};

// ── Utilidades puras ─────────────────────────────────────────────────────────

/** Escapa caracteres HTML peligrosos en cualquier string derivado del usuario. */
export function escapeHtml(s: string): string {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Devuelve la capa/carpeta top-level de un sourceFile. */
function layerOf(sourceFile: string): string {
  if (!sourceFile) return "other";
  const parts = sourceFile.replaceAll("\\", "/").split("/");
  if (parts[0] === "src") return parts.length > 2 ? (parts[1] ?? "shared") : "shared";
  return parts[0] ?? "other";
}

/** Clave de grupo vis-network: el nombre de la carpeta/capa top-level (legible). */
function groupKey(node: GraphNode): string {
  return layerOf(node.sourceFile);
}

/** Color del nodo según su carpeta/capa top-level. */
function colorForNode(node: GraphNode): string {
  return LAYER_COLORS[layerOf(node.sourceFile)] ?? "#484f58";
}

// ── Constructores de datos vis-network ───────────────────────────────────────

/**
 * Grado bidireccional (in + out) excluyendo aristas "contains" (decisión A5).
 * Se usa para el tamaño de nodo y para determinar los god nodes.
 */
function buildDegreeMap(edges: GraphEdge[]): Map<string, number> {
  const deg = new Map<string, number>();
  for (const e of edges) {
    if (e.relation === "contains") continue;
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  return deg;
}

/** Label abreviado para módulos (basename), completo para el resto. */
function shortLabel(node: GraphNode): string {
  return node.kind === "module" ? basename(node.label) : node.label;
}

/** Texto legible de una signature estructurada (para el drawer de detalle). */
function signatureText(sig: Signature): string {
  const params = sig.parameters
    .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
    .join(", ");
  const mods = [sig.accessModifier, sig.isAsync ? "async" : null]
    .filter(Boolean)
    .join(" ");
  const prefix = mods ? `${mods} ` : "";
  return `${prefix}(${params}) => ${sig.returnType.text}`;
}

/**
 * Detalle estructurado y HTML-escapado de un nodo. Se embebe en cada nodo como
 * `d` y se renderiza en el drawer lateral al hacer click (reemplaza el tooltip
 * de hover, que era ilegible cuando la info es larga).
 */
function nodeDetail(n: GraphNode, deg: number): Record<string, unknown> {
  const loc = n.sourceLocation ? `:${escapeHtml(n.sourceLocation)}` : "";
  return {
    label: escapeHtml(n.label),
    kind: escapeHtml(n.kind ?? "?"),
    layer: escapeHtml(layerOf(n.sourceFile)),
    community: n.community ?? null,
    file: `${escapeHtml(n.sourceFile)}${loc}`,
    degree: deg,
    sig: n.signature ? escapeHtml(signatureText(n.signature)) : "",
  };
}

/**
 * Array de nodos en formato vis-network. NO se setea `title` (tooltip de hover):
 * el detalle va en `d` y se muestra en el drawer al hacer click. Los strings de
 * `d` están HTML-escapados (se inyectan vía innerHTML en el drawer).
 */
function buildVisNodes(
  nodes: GraphNode[],
  degreeMap: Map<string, number>,
  godNodeIds: Set<string>,
): unknown[] {
  return nodes.map((n) => {
    const deg = degreeMap.get(n.id) ?? 0;
    const showLabel = godNodeIds.has(n.id) || n.kind === "module";
    return {
      id: n.id,
      label: showLabel ? escapeHtml(shortLabel(n)) : undefined,
      group: groupKey(n),
      value: deg,
      d: nodeDetail(n, deg),
    };
  });
}

/** Array de aristas en formato vis-network. INFERRED → dashes:true. */
function buildVisEdges(edges: GraphEdge[]): unknown[] {
  return edges.map((e) => ({
    from: e.source,
    to: e.target,
    arrows: "to",
    title: escapeHtml(`${e.relation} (${e.confidence})`),
    color: {
      color: e.relation === "contains" ? "#21262d" : "#30474f",
      opacity: 0.55,
    },
    width: e.relation === "contains" ? 0.5 : 1,
    dashes: e.confidence === "INFERRED",
    smooth: { enabled: true, type: "continuous" },
  }));
}

/** Mapa de grupo → color hexadecimal (para META.colors en el HUD). */
function buildGroupColors(nodes: GraphNode[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const n of nodes) {
    const key = groupKey(n);
    if (!(key in result)) result[key] = colorForNode(n);
  }
  return result;
}

/** Conteo de nodos por grupo (para los filtros del HUD). */
function buildGroupCounts(nodes: GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of nodes) {
    const key = groupKey(n);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Top-12 nodos por grado, con strings escapados (para la sección god nodes). */
function buildGodNodes(
  degreeMap: Map<string, number>,
  rawNodes: GraphNode[],
): { id: string; label: string; layer: string; degree: number }[] {
  return [...degreeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id, d]) => {
      const n = rawNodes.find((x) => x.id === id);
      return {
        id,
        label: escapeHtml(n ? n.label : id),
        layer: n ? layerOf(n.sourceFile) : "?",
        degree: d,
      };
    });
}

// ── Plantilla HTML ───────────────────────────────────────────────────────────

/** Genera el HTML completo con vis.js inlinado y los datos embebidos como JSON. */
function htmlTemplate(
  visLib: string,
  payload: string,
  meta: string,
  projectName: string,
): string {
  const safeTitle = escapeHtml(projectName);
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle} \u2014 grafo de c\u00f3digo</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#30363d; --txt:#e6edf3; --dim:#8b949e; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--txt);
    font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  #net { position:absolute; inset:0; }
  #hud { position:absolute; top:12px; left:12px; width:268px; background:rgba(22,27,34,.94);
    border:1px solid var(--line); border-radius:10px; padding:12px 14px; backdrop-filter:blur(4px); }
  #hud h1 { font-size:14px; margin:0 0 2px; }
  #hud p.sub { margin:0 0 10px; color:var(--dim); font-size:11px; }
  #search { width:100%; padding:7px 9px; background:var(--bg); border:1px solid var(--line);
    border-radius:7px; color:var(--txt); margin-bottom:10px; }
  #filters label { display:flex; align-items:center; gap:7px; font-size:12px; padding:2px 0; cursor:pointer; }
  #filters .sw { width:11px; height:11px; border-radius:3px; flex:0 0 auto; }
  #filters .ct { margin-left:auto; color:var(--dim); }
  .btns { display:flex; gap:8px; margin-top:10px; }
  .btns button { flex:1; padding:6px; background:var(--bg); border:1px solid var(--line);
    color:var(--txt); border-radius:7px; cursor:pointer; font-size:12px; }
  .btns button:hover { border-color:#58a6ff; }
  details { margin-top:10px; }
  summary { cursor:pointer; color:var(--dim); font-size:12px; }
  .god { font-size:11px; }
  .god div { display:flex; gap:6px; padding:2px 0; }
  .god b { color:var(--txt); }
  .god .d { margin-left:auto; color:var(--dim); }
  #loading { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    color:var(--dim); font-size:14px; }
  #drawer { position:absolute; top:0; right:0; height:100%; width:340px; transform:translateX(100%);
    transition:transform .18s ease; background:var(--panel); border-left:1px solid var(--line);
    padding:16px 18px; overflow:auto; box-shadow:-8px 0 24px rgba(0,0,0,.35); }
  #drawer.open { transform:translateX(0); }
  #drawer .x { position:absolute; top:10px; right:12px; cursor:pointer; color:var(--dim);
    background:none; border:none; font-size:20px; line-height:1; }
  #drawer h2 { font-size:15px; margin:2px 36px 2px 0; word-break:break-word; }
  #drawer .badges { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0 14px; }
  #drawer .badge { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--dim); }
  #drawer .field { margin-bottom:11px; }
  #drawer .field .k { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.04em; margin-bottom:2px; }
  #drawer .field .v { font-size:13px; word-break:break-word; }
  #drawer pre { background:var(--bg); border:1px solid var(--line); border-radius:7px; padding:9px 10px;
    font-size:12px; white-space:pre-wrap; word-break:break-word; margin:4px 0 0; }
  #drawer .empty { color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<div id="net"></div>
<div id="loading">estabilizando layout\u2026</div>
<div id="hud">
  <h1>${safeTitle} \u00b7 grafo de c\u00f3digo</h1>
  <p class="sub" id="sub"></p>
  <input id="search" placeholder="buscar nodo (enter)\u2026" />
  <div id="filters"></div>
  <div class="btns">
    <button id="physics-toggle">congelar f\u00edsica</button>
    <button id="fit">encuadrar</button>
  </div>
  <details open><summary>God nodes (mayor grado)</summary><div class="god" id="god"></div></details>
</div>
<div id="drawer"></div>
<script>${visLib}</script>
<script>
const DATA = ${payload};
const META = ${meta};
const sub = document.getElementById('sub');
sub.textContent = META.totals.nodes + ' nodos \u00b7 ' + META.totals.edges + ' edges \u00b7 color = carpeta \u00b7 tama\u00f1o = grado';

const groups = {};
for (const [name, color] of Object.entries(META.colors)) {
  groups[name] = { color: { background: color + '33', border: color, highlight:{background:color+'55',border:color} },
    font: { color: '#e6edf3', size: 12, strokeWidth: 3, strokeColor: '#0d1117' } };
}

const nodes = new vis.DataSet(DATA.nodes);
const edges = new vis.DataSet(DATA.edges);
const container = document.getElementById('net');
const options = {
  nodes: { shape: 'dot', scaling: { min: 5, max: 42, label: { enabled:true, min:11, max:22 } }, borderWidth: 1.5 },
  edges: { selectionWidth: 2, hoverWidth: 1 },
  groups,
  interaction: { hover: true, tooltipDelay: 120, navigationButtons: false, keyboard: false },
  physics: { stabilization: { iterations: 220 }, barnesHut: { gravitationalConstant: -9000, springLength: 110, springConstant: 0.03, avoidOverlap: 0.2 } },
};
const network = new vis.Network(container, { nodes, edges }, options);
network.once('stabilizationIterationsDone', () => {
  document.getElementById('loading').style.display = 'none';
  network.setOptions({ physics: false });
  document.getElementById('physics-toggle').textContent = 'reactivar f\u00edsica';
});

// --- drawer de detalle (click en un nodo) ---
const drawer = document.getElementById('drawer');
const byId = {};
for (const n of DATA.nodes) byId[n.id] = n;
function openDrawer(node){
  if (!node) return;
  const d = node.d || {};
  const commBadge = d.community != null ? '<span class="badge">comunidad ' + d.community + '</span>' : '';
  drawer.innerHTML =
    '<button class="x" title="cerrar">\u00d7</button>' +
    '<h2>' + (d.label || node.id) + '</h2>' +
    '<div class="badges"><span class="badge">' + (d.kind || '?') + '</span>' +
      '<span class="badge">capa ' + (d.layer || '?') + '</span>' + commBadge +
      '<span class="badge">grado ' + (d.degree || 0) + '</span></div>' +
    '<div class="field"><div class="k">archivo</div><div class="v">' + (d.file || '') + '</div></div>' +
    (d.sig
      ? '<div class="field"><div class="k">firma</div><pre>' + d.sig + '</pre></div>'
      : '<div class="field empty">sin firma estructurada</div>');
  drawer.classList.add('open');
  drawer.querySelector('.x').addEventListener('click', closeDrawer);
}
function closeDrawer(){ drawer.classList.remove('open'); }
network.on('click', params => {
  if (params.nodes && params.nodes.length) openDrawer(byId[params.nodes[0]]);
  else closeDrawer();
});

// --- filtros por grupo ---
const hidden = new Set();
const filtersEl = document.getElementById('filters');
for (const [name, ct] of Object.entries(META.layers).sort((a,b)=>b[1]-a[1])) {
  const row = document.createElement('label');
  row.innerHTML = '<input type="checkbox" checked data-g="'+name+'"><span class="sw" style="background:'+(META.colors[name]||'#888')+'"></span>'+name+'<span class="ct">'+ct+'</span>';
  filtersEl.appendChild(row);
}
filtersEl.addEventListener('change', e => {
  const g = e.target.dataset.g; if (!g) return;
  if (e.target.checked) hidden.delete(g); else hidden.add(g);
  nodes.update(DATA.nodes.map(n => ({ id: n.id, hidden: hidden.has(n.group) })));
});

// --- b\u00fasqueda ---
const searchEl = document.getElementById('search');
searchEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const q = searchEl.value.trim().toLowerCase();
  if (!q) return;
  const hit = DATA.nodes.find(n => (n.label||'').toLowerCase().includes(q) || n.id.toLowerCase().includes(q) || ((n.d&&n.d.label)||'').toLowerCase().includes(q) || ((n.d&&n.d.file)||'').toLowerCase().includes(q));
  if (hit) { network.focus(hit.id, { scale: 1.4, animation: true }); network.selectNodes([hit.id]); openDrawer(hit); }
});

// --- botones ---
let frozen = true;
document.getElementById('physics-toggle').addEventListener('click', () => {
  frozen = !frozen;
  network.setOptions({ physics: !frozen });
  document.getElementById('physics-toggle').textContent = frozen ? 'reactivar f\u00edsica' : 'congelar f\u00edsica';
});
document.getElementById('fit').addEventListener('click', () => network.fit({ animation: true }));

// --- god nodes (click → focus + drawer) ---
const godEl = document.getElementById('god');
godEl.innerHTML = META.god.map((g,i) =>
  '<div data-i="'+i+'" style="cursor:pointer"><span class="sw" style="width:9px;height:9px;border-radius:2px;background:'+(META.colors[g.layer]||'#888')+'"></span><b>'+g.label+'</b><span class="d">'+g.degree+'</span></div>'
).join('');
godEl.addEventListener('click', e => {
  const row = e.target.closest('[data-i]'); if (!row) return;
  const g = META.god[+row.dataset.i]; if (!g || !g.id) return;
  network.focus(g.id, { scale: 1.4, animation: true });
  network.selectNodes([g.id]);
  openDrawer(byId[g.id]);
});
</script>
</body>
</html>`;
}

// ── Workspace constellation helpers ─────────────────────────────────────────

/** Palette for repo super-nodes (cycles if more repos than colours). */
const REPO_COLORS = [
  "#f0b429", "#58a6ff", "#3fb950", "#bc8cff",
  "#79c0ff", "#d29922", "#db61a2", "#ff7b72",
  "#ffa657", "#39d353",
];

export interface ConstellationEdge {
  source: string;
  target: string;
  weight?: number;
}

/** Per-repo aggregate counts for the constellation view. */
export type RepoStats = Map<string, { nodeCount: number; edgeCount: number }>;

/**
 * Derive constellation inputs from a merged workspace graph (FU#1).
 * - repoStats: per repo → {nodeCount, intra-repo edgeCount}.
 * - crossEdges: edges whose source/target repos differ, mapped to repo keys
 *   (source = importing repo, target = depended-on repo). Edges whose target id
 *   is not a node in the graph (synthetic) are skipped.
 *
 * Pure function: no I/O. Keeps the visualize handler thin.
 */
export function deriveConstellation(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { repoStats: RepoStats; crossEdges: ConstellationEdge[] } {
  const repoStats: RepoStats = new Map();
  const idToRepo = new Map<string, string>();

  for (const n of nodes) {
    const repo = n.repo ?? "unknown";
    idToRepo.set(n.id, repo);
    const entry = repoStats.get(repo) ?? { nodeCount: 0, edgeCount: 0 };
    entry.nodeCount++;
    repoStats.set(repo, entry);
  }

  const crossEdges: ConstellationEdge[] = [];
  for (const e of edges) {
    const sRepo = idToRepo.get(e.source) ?? e.repo ?? "unknown";
    const tRepo = idToRepo.get(e.target);
    if (tRepo === undefined) continue; // target is synthetic / not in graph
    if (sRepo === tRepo) {
      const entry = repoStats.get(sRepo) ?? { nodeCount: 0, edgeCount: 0 };
      entry.edgeCount++;
      repoStats.set(sRepo, entry);
    } else {
      crossEdges.push({ source: sRepo, target: tRepo, weight: e.weight ?? 1 });
    }
  }

  return { repoStats, crossEdges };
}

/**
 * Build constellation vis-network data from a list of repos and cross-repo edges.
 * Each repo becomes a super-node; cross-repo edges connect them.
 *
 * @param repoStats   Map of repoKey → {nodeCount, edgeCount}
 * @param crossEdges  Cross-repo edges (source+target are repo keys)
 */
function buildConstellationData(
  repoStats: Map<string, { nodeCount: number; edgeCount: number }>,
  crossEdges: ConstellationEdge[],
): { nodes: object[]; edges: object[] } {
  const repos = [...repoStats.entries()];
  const repoColorMap = new Map(repos.map(([k], i) => [k, REPO_COLORS[i % REPO_COLORS.length]!]));

  const nodes = repos.map(([repoKey, stats], i) => ({
    id: repoKey,
    label: escapeHtml(repoKey),
    title: `${escapeHtml(repoKey)}\n${stats.nodeCount} nodes, ${stats.edgeCount} edges`,
    color: repoColorMap.get(repoKey) ?? "#484f58",
    // Size proportional to node count (min 20, max 60)
    size: Math.min(60, Math.max(20, 20 + Math.floor((stats.nodeCount / 100) * 40))),
    shape: "dot",
    font: { size: 14, color: "#cdd9e5", bold: true },
    group: repoKey,
    x: Math.cos((i / repos.length) * 2 * Math.PI) * 300,
    y: Math.sin((i / repos.length) * 2 * Math.PI) * 300,
  }));

  // Aggregate cross-repo edges (may have multiple per pair)
  const edgeAgg = new Map<string, { source: string; target: string; weight: number }>();
  for (const e of crossEdges) {
    const key = `${e.source}|||${e.target}`;
    const existing = edgeAgg.get(key);
    if (existing) existing.weight++;
    else edgeAgg.set(key, { source: e.source, target: e.target, weight: e.weight ?? 1 });
  }

  const edges = [...edgeAgg.values()].map((e, i) => ({
    id: `ce-${i}`,
    from: e.source,
    to: e.target,
    label: e.weight > 1 ? String(e.weight) : "",
    color: { color: "#8b949e", highlight: "#58a6ff", hover: "#79c0ff" },
    width: Math.min(5, 1 + Math.floor(e.weight / 3)),
    arrows: { to: { enabled: true, scaleFactor: 0.8 } },
  }));

  return { nodes, edges };
}

/** Drilldown mode: colour nodes by repo, dim non-selected repos if selectedRepo is set. */
function buildDrilldownVisNodes(
  rawNodes: GraphNode[],
  degreeMap: Map<string, number>,
  godNodeIds: Set<string>,
  selectedRepo?: string,
): object[] {
  const repos = [...new Set(rawNodes.map((n) => n.repo ?? "unknown"))];
  const repoColorMap = new Map(repos.map((r, i) => [r, REPO_COLORS[i % REPO_COLORS.length]!]));

  return rawNodes.map((n) => {
    const repo = n.repo ?? "unknown";
    const dim = selectedRepo !== undefined && repo !== selectedRepo;
    const base = buildSingleVisNode(n, degreeMap, godNodeIds);
    return {
      ...base,
      color: dim
        ? { background: "#2d333b", border: "#444c56", highlight: { background: "#2d333b", border: "#444c56" } }
        : { background: repoColorMap.get(repo) ?? "#484f58", border: "#161b22" },
      opacity: dim ? 0.3 : 1.0,
      title: `[${escapeHtml(repo)}] ${escapeHtml(n.label ?? n.id)}`,
    };
  });
}

/** Extract a single vis-node object for drilldown mode. */
function buildSingleVisNode(
  n: GraphNode,
  degreeMap: Map<string, number>,
  godNodeIds: Set<string>,
): Record<string, unknown> {
  const deg = degreeMap.get(n.id) ?? 0;
  const isGod = godNodeIds.has(n.id);
  const layer = layerOf(n.sourceFile ?? "");
  const color = LAYER_COLORS[layer] ?? LAYER_COLORS.other!;
  return {
    id: n.id,
    label: escapeHtml(n.label ?? n.id),
    title: escapeHtml(n.label ?? n.id),
    color: isGod
      ? { background: "#f0b429", border: "#e3a008", highlight: { background: "#fce68a", border: "#e3a008" } }
      : { background: color, border: "#161b22", highlight: { background: color, border: "#58a6ff" } },
    size: isGod ? 28 + Math.min(deg * 0.6, 22) : 10 + Math.min(deg * 0.4, 12),
    borderWidth: isGod ? 3 : 1,
    font: { size: 11, color: "#cdd9e5" },
    group: layer,
    _meta: { deg, isGod, kind: n.kind, sourceFile: n.sourceFile ?? "", repo: n.repo ?? "" },
  };
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Genera un HTML autocontenido con vis-network inlinado y los datos del grafo
 * embebidos como JSON. Función pura: sin I/O, sin efectos secundarios.
 *
 * @param graph   Grafo en formato node-link (desde GraphRepository.toNodeLink()).
 * @param visJs   Contenido del fichero vis-network.min.js (leído por el handler).
 * @param opts    Opciones de renderizado.
 * @returns       FileArtifact con path="" y el HTML completo en content.
 *                El handler caller establece el path definitivo.
 */
export function renderGraphHtml(
  graph: NodeLinkGraph,
  visJs: string,
  opts: RenderOpts,
): FileArtifact {
  const { projectName, mode = "single", selectedRepo } = opts;
  const rawNodes = graph.nodes;
  const rawEdges = graph.links;

  const degreeMap = buildDegreeMap(rawEdges);
  const sorted = [...degreeMap.entries()].sort((a, b) => b[1] - a[1]);
  const godNodeIds = new Set(sorted.slice(0, 12).map(([id]) => id));

  let visNodes: unknown[];
  if (mode === "drilldown") {
    visNodes = buildDrilldownVisNodes(rawNodes, degreeMap, godNodeIds, selectedRepo);
  } else {
    visNodes = buildVisNodes(rawNodes, degreeMap, godNodeIds);
  }

  const visEdges = buildVisEdges(rawEdges);
  const groupColors = buildGroupColors(rawNodes);
  const groupCounts = buildGroupCounts(rawNodes);
  const godNodes = buildGodNodes(degreeMap, rawNodes);
  const maxDeg = sorted.length > 0 ? (sorted[0]?.[1] ?? 1) : 1;

  // Seguridad: reemplazar "</" por "<\/" en el JSON embebido para que el parser HTML
  // no cierre el bloque <script> al encontrar "</script>" dentro de los datos.
  const payload = JSON.stringify({ nodes: visNodes, edges: visEdges }).replaceAll("</", String.raw`<\/`);
  const meta = JSON.stringify({
    totals:      { nodes: rawNodes.length, edges: rawEdges.length },
    layers:      groupCounts,
    colors:      groupColors,
    god:         godNodes,
    maxDeg,
    projectName: escapeHtml(projectName),
    mode,
    selectedRepo: selectedRepo ? escapeHtml(selectedRepo) : undefined,
  }).replaceAll("</", String.raw`<\/`);

  const content = htmlTemplate(visJs, payload, meta, projectName);
  return { path: "", content };
}

/**
 * Render a workspace constellation HTML — repos as super-nodes, cross-repo edges between them.
 * Pure function: no I/O.
 *
 * @param repoStats   Map of repoKey → {nodeCount, edgeCount}
 * @param crossEdges  Cross-repo edges (source = importing repoKey, target = depended-on repoKey)
 * @param visJs       vis-network.min.js content
 * @param opts        Rendering opts (projectName used as title)
 */
export function renderConstellationHtml(
  repoStats: Map<string, { nodeCount: number; edgeCount: number }>,
  crossEdges: ConstellationEdge[],
  visJs: string,
  opts: Pick<RenderOpts, "projectName">,
): FileArtifact {
  const { projectName } = opts;
  const { nodes: visNodes, edges: visEdges } = buildConstellationData(repoStats, crossEdges);

  const payload = JSON.stringify({ nodes: visNodes, edges: visEdges }).replaceAll("</", String.raw`<\/`);
  const meta = JSON.stringify({
    totals:      { nodes: visNodes.length, edges: visEdges.length },
    layers:      Object.fromEntries([...repoStats.entries()].map(([k, v]) => [k, v.nodeCount])),
    colors:      Object.fromEntries(
      [...repoStats.keys()].map((k, i) => [k, REPO_COLORS[i % REPO_COLORS.length]!]),
    ),
    god:         [],
    maxDeg:      1,
    projectName: escapeHtml(projectName),
    mode:        "constellation",
  }).replaceAll("</", String.raw`<\/`);

  const content = htmlTemplate(visJs, payload, meta, projectName);
  return { path: "", content };
}
