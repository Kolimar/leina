// application/audit/audit-html-export.ts — Pure HTML writer for the audit subgraph.
//
// Renders an AuditPack (source→sink candidate paths with per-edge confidence) as a
// single self-contained, offline HTML file with vis-network inlined. Unlike the code
// graph viewer (html-export.ts), this view is audit-focused:
//
//   - nodes are coloured by ROLE: source (green), sink (red), synthetic sink (red
//     diamond — dangerous external API injected at audit time), waypoint (neutral)
//   - edges are coloured by CONFIDENCE (EXTRACTED/INFERRED/AMBIGUOUS/SYNTACTIC),
//     INFERRED/SYNTACTIC dashed
//   - a side panel lists every candidate path source→sink; clicking one highlights
//     that path (its nodes + edges) and focuses the view
//   - the mandatory audit DISCLAIMER (NFR-08) is rendered as a prominent banner AND
//     embedded in the payload
//
// Pure function: no I/O. The handler reads vis-network.min.js and writes the file.
// XSS-safe: every user-derived string is HTML-escaped, and the embedded JSON has
// every "</" replaced with "<\/" so it can never close the outer <script> block.

import type { FileArtifact } from "../../domain/install/artifact.ts";
import type { Confidence, GraphEdge, GraphNode } from "../../domain/graph/model.ts";
import { escapeHtml } from "../graph/html-export.ts";
import type { AuditPack } from "./pack.ts";

export interface AuditRenderOpts {
  projectName: string;
}

// Node role → colour. Sources/sinks are the salient endpoints; waypoints are dim.
const ROLE_COLORS: Readonly<Record<string, string>> = {
  source:    "#3fb950", // green: tainted input enters here
  sink:      "#ff7b72", // red: dangerous operation
  synthetic: "#f85149", // bright red: synthetic (ephemeral) dangerous external API
  waypoint:  "#58a6ff", // blue: intermediate node on a path
};

// Edge colour by confidence. INFERRED/SYNTACTIC are dashed (less trustworthy).
const CONF_COLORS: Readonly<Record<Confidence, string>> = {
  EXTRACTED: "#3fb950",
  INFERRED:  "#d29922",
  AMBIGUOUS: "#ff7b72",
  SYNTACTIC: "#6e7681",
};

type Role = "source" | "sink" | "synthetic" | "waypoint";

/** A synthetic sink is an ephemeral node injected at audit time (never persisted). */
function isSynthetic(node: GraphNode): boolean {
  return node.id.startsWith("__sink__") || node.sourceFile === "__synthetic__";
}

/**
 * Classify each node id in the pack by its role across all candidate paths.
 * A node can be both a source and a waypoint; source/sink win over waypoint.
 */
function classifyRoles(pack: AuditPack): Map<string, Role> {
  const sources = new Set(pack.paths.map((p) => p.source));
  const sinks = new Set(pack.paths.map((p) => p.sink));
  const synthById = new Map(pack.nodes.map((n) => [n.id, isSynthetic(n)] as const));

  const roles = new Map<string, Role>();
  for (const n of pack.nodes) {
    if (sinks.has(n.id)) roles.set(n.id, synthById.get(n.id) ? "synthetic" : "sink");
    else if (sources.has(n.id)) roles.set(n.id, "source");
    else roles.set(n.id, "waypoint");
  }
  return roles;
}

/** Stable edge id used for path highlighting (matches the step key format). */
function edgeKey(from: string, to: string, relation: string): string {
  return `${from}::${to}::${relation}`;
}

/** vis-network node objects, coloured by role, with a detail blob for the drawer. */
function buildAuditVisNodes(pack: AuditPack, roles: Map<string, Role>): unknown[] {
  return pack.nodes.map((n) => {
    const role = roles.get(n.id) ?? "waypoint";
    const color = ROLE_COLORS[role] ?? ROLE_COLORS.waypoint!;
    const isEndpoint = role !== "waypoint";
    return {
      id: n.id,
      label: escapeHtml(n.label || n.id),
      group: role,
      shape: role === "synthetic" ? "diamond" : "dot",
      value: isEndpoint ? 3 : 1,
      color: { background: color, border: "#161b22", highlight: { background: color, border: "#e6edf3" } },
      d: {
        label: escapeHtml(n.label || n.id),
        role,
        kind: escapeHtml(n.kind ?? "?"),
        repo: escapeHtml(n.repo ?? ""),
        file: escapeHtml(n.sourceFile ?? ""),
      },
    };
  });
}

/** vis-network edge objects, coloured/dashed by confidence. id = step key. */
function buildAuditVisEdges(edges: GraphEdge[]): unknown[] {
  return edges.map((e) => {
    const color = CONF_COLORS[e.confidence] ?? "#6e7681";
    return {
      id: edgeKey(e.source, e.target, e.relation),
      from: e.source,
      to: e.target,
      arrows: "to",
      title: escapeHtml(`${e.relation} (${e.confidence})`),
      color: { color, opacity: 0.7, highlight: "#e6edf3" },
      width: 1.5,
      dashes: e.confidence === "INFERRED" || e.confidence === "SYNTACTIC",
      smooth: { enabled: true, type: "continuous" },
    };
  });
}

/** Path summaries for the side panel: endpoints, confidence, repos, and step keys. */
function buildPathSummaries(
  pack: AuditPack,
  labelById: Map<string, string>,
): unknown[] {
  return pack.paths.map((p) => ({
    source: escapeHtml(labelById.get(p.source) ?? p.source),
    sink: escapeHtml(labelById.get(p.sink) ?? p.sink),
    minConfidence: p.minConfidence,
    steps: p.steps.length,
    repos: p.reposTraversed.map((r) => escapeHtml(r)),
    nodeIds: [...new Set(p.steps.flatMap((s) => [s.from, s.to]))],
    edgeIds: p.steps.map((s) => edgeKey(s.from, s.to, s.relation)),
  }));
}

// ── HTML template ─────────────────────────────────────────────────────────────

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
<title>${safeTitle} \u2014 auditor\u00eda (rutas candidatas)</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#30363d; --txt:#e6edf3; --dim:#8b949e;
    --warn:#d29922; --warnbg:#3a2d05; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--txt);
    font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  #net { position:absolute; inset:0; top:auto; bottom:0; height:calc(100% - 0px); }
  #banner { position:absolute; top:0; left:0; right:0; z-index:5; background:var(--warnbg);
    border-bottom:1px solid var(--warn); color:#f0d58c; padding:7px 14px; font-size:11px; }
  #banner b { color:var(--warn); }
  #hud { position:absolute; top:44px; left:12px; width:300px; max-height:calc(100% - 60px);
    overflow:auto; background:rgba(22,27,34,.94); border:1px solid var(--line);
    border-radius:10px; padding:12px 14px; backdrop-filter:blur(4px); }
  #hud h1 { font-size:14px; margin:0 0 2px; }
  #hud p.sub { margin:0 0 10px; color:var(--dim); font-size:11px; }
  .legend { display:flex; flex-wrap:wrap; gap:6px 12px; margin:0 0 10px; font-size:11px; }
  .legend span { display:flex; align-items:center; gap:5px; color:var(--dim); }
  .legend .sw { width:11px; height:11px; border-radius:3px; flex:0 0 auto; }
  .legend .sw.dia { border-radius:2px; transform:rotate(45deg); }
  .paths { font-size:12px; }
  .paths .p { padding:6px 8px; border:1px solid var(--line); border-radius:7px; margin-bottom:6px;
    cursor:pointer; }
  .paths .p:hover { border-color:#58a6ff; }
  .paths .p.active { border-color:#58a6ff; background:#1c2330; }
  .paths .ep { display:flex; align-items:center; gap:5px; }
  .paths .ep b { color:var(--txt); word-break:break-all; }
  .paths .ar { color:var(--dim); }
  .paths .m { margin-top:3px; color:var(--dim); font-size:11px; }
  .conf { font-size:10px; padding:1px 6px; border-radius:999px; border:1px solid var(--line); }
  .btns { display:flex; gap:8px; margin:10px 0 4px; }
  .btns button { flex:1; padding:6px; background:var(--bg); border:1px solid var(--line);
    color:var(--txt); border-radius:7px; cursor:pointer; font-size:12px; }
  .btns button:hover { border-color:#58a6ff; }
  #loading { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    color:var(--dim); font-size:14px; }
  #empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    color:var(--dim); font-size:14px; text-align:center; padding:0 40px; }
  #drawer { position:absolute; top:0; right:0; height:100%; width:340px; transform:translateX(100%);
    transition:transform .18s ease; background:var(--panel); border-left:1px solid var(--line);
    padding:16px 18px; overflow:auto; box-shadow:-8px 0 24px rgba(0,0,0,.35); z-index:6; }
  #drawer.open { transform:translateX(0); }
  #drawer .x { position:absolute; top:10px; right:12px; cursor:pointer; color:var(--dim);
    background:none; border:none; font-size:20px; line-height:1; }
  #drawer h2 { font-size:15px; margin:2px 36px 2px 0; word-break:break-word; }
  #drawer .badges { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0 14px; }
  #drawer .badge { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--dim); }
  #drawer .field { margin-bottom:11px; }
  #drawer .field .k { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.04em; margin-bottom:2px; }
  #drawer .field .v { font-size:13px; word-break:break-word; }
</style>
</head>
<body>
<div id="banner">\u26a0 <b>NOTICE</b>: rutas CANDIDATAS, no vulnerabilidades confirmadas ni exploits. Requieren revisi\u00f3n humana calificada. leina no genera exploits, payloads ni c\u00f3digo de ataque.</div>
<div id="net"></div>
<div id="loading">estabilizando layout\u2026</div>
<div id="hud">
  <h1>${safeTitle} \u00b7 auditor\u00eda</h1>
  <p class="sub" id="sub"></p>
  <div class="legend">
    <span><i class="sw" style="background:#3fb950"></i>source</span>
    <span><i class="sw" style="background:#ff7b72"></i>sink</span>
    <span><i class="sw dia" style="background:#f85149"></i>sink sint\u00e9tico</span>
    <span><i class="sw" style="background:#58a6ff"></i>waypoint</span>
  </div>
  <div class="btns"><button id="fit">encuadrar</button><button id="clear">limpiar selecci\u00f3n</button></div>
  <div class="paths" id="paths"></div>
</div>
<div id="drawer"></div>
<script>${visLib}</script>
<script>
const DATA = ${payload};
const META = ${meta};
const sub = document.getElementById('sub');
sub.textContent = META.totals.paths + ' rutas \u00b7 ' + META.totals.sources + ' sources \u00b7 ' +
  META.totals.sinks + ' sinks' + (META.totals.repos ? ' \u00b7 ' + META.totals.repos + ' repos' : '') +
  (META.prunedPaths ? ' \u00b7 ' + META.prunedPaths + ' podadas' : '');

if (DATA.nodes.length === 0) {
  document.getElementById('loading').style.display = 'none';
  const e = document.createElement('div'); e.id = 'empty';
  e.textContent = 'No se encontraron rutas source\u2192sink. Prob\u00e1 con --from <id> o reconstru\u00ed el grafo (leina workspace build).';
  document.body.appendChild(e);
}

const groups = {};
for (const [name, color] of Object.entries(META.colors)) {
  groups[name] = { color: { background: color, border: '#161b22', highlight:{background:color,border:'#e6edf3'} },
    font: { color: '#e6edf3', size: 12, strokeWidth: 3, strokeColor: '#0d1117' } };
}

const nodes = new vis.DataSet(DATA.nodes);
const edges = new vis.DataSet(DATA.edges);
const container = document.getElementById('net');
const options = {
  nodes: { shape: 'dot', scaling: { min: 10, max: 34, label: { enabled:true, min:11, max:20 } }, borderWidth: 1.5 },
  edges: { selectionWidth: 2.4, hoverWidth: 1, font: { color:'#8b949e', size:10, strokeWidth:3, strokeColor:'#0d1117' } },
  groups,
  interaction: { hover: true, tooltipDelay: 120, navigationButtons: false, keyboard: false },
  physics: { stabilization: { iterations: 200 }, barnesHut: { gravitationalConstant: -8000, springLength: 120, springConstant: 0.03, avoidOverlap: 0.3 } },
  layout: { improvedLayout: true },
};
const network = new vis.Network(container, { nodes, edges }, options);
network.once('stabilizationIterationsDone', () => {
  const l = document.getElementById('loading'); if (l) l.style.display = 'none';
  network.setOptions({ physics: false });
});

// --- drawer de detalle (click en un nodo) ---
const drawer = document.getElementById('drawer');
const byId = {};
for (const n of DATA.nodes) byId[n.id] = n;
function openDrawer(node){
  if (!node) return;
  const d = node.d || {};
  drawer.innerHTML =
    '<button class="x" title="cerrar">\u00d7</button>' +
    '<h2>' + (d.label || node.id) + '</h2>' +
    '<div class="badges"><span class="badge">' + (d.role || '?') + '</span>' +
      '<span class="badge">' + (d.kind || '?') + '</span>' +
      (d.repo ? '<span class="badge">' + d.repo + '</span>' : '') + '</div>' +
    '<div class="field"><div class="k">archivo</div><div class="v">' + (d.file || '') + '</div></div>';
  drawer.classList.add('open');
  drawer.querySelector('.x').addEventListener('click', closeDrawer);
}
function closeDrawer(){ drawer.classList.remove('open'); }
network.on('click', params => {
  if (params.nodes && params.nodes.length) openDrawer(byId[params.nodes[0]]);
  else closeDrawer();
});

// --- panel de rutas (click \u2192 resalta la ruta) ---
const pathsEl = document.getElementById('paths');
pathsEl.innerHTML = META.paths.map((p,i) => {
  const c = META.confColors[p.minConfidence] || '#8b949e';
  return '<div class="p" data-i="'+i+'">' +
    '<div class="ep"><b>'+p.source+'</b><span class="ar">\u2192</span><b>'+p.sink+'</b></div>' +
    '<div class="m"><span class="conf" style="color:'+c+';border-color:'+c+'">'+p.minConfidence+'</span> '+
      p.steps+' pasos'+(p.repos.length>1?' \u00b7 '+p.repos.join(' \u2192 '):'')+'</div></div>';
}).join('');

let activeEl = null;
function highlightPath(i){
  const p = META.paths[i]; if (!p) return;
  network.setSelection({ nodes: p.nodeIds, edges: p.edgeIds });
  network.fit({ nodes: p.nodeIds, animation: true });
  if (activeEl) activeEl.classList.remove('active');
  activeEl = pathsEl.querySelector('[data-i="'+i+'"]');
  if (activeEl) activeEl.classList.add('active');
  const src = byId[p.nodeIds[0]]; if (src) openDrawer(src);
}
pathsEl.addEventListener('click', e => {
  const row = e.target.closest('[data-i]'); if (!row) return;
  highlightPath(+row.dataset.i);
});

document.getElementById('fit').addEventListener('click', () => network.fit({ animation: true }));
document.getElementById('clear').addEventListener('click', () => {
  network.unselectAll();
  if (activeEl) { activeEl.classList.remove('active'); activeEl = null; }
  closeDrawer();
});
</script>
</body>
</html>`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Render an AuditPack as a self-contained offline HTML audit viewer.
 *
 * @param pack   The audit pack (source→sink candidate paths + subgraph).
 * @param visJs  Contents of vis-network.min.js (read by the handler).
 * @param opts   Render options (project name for the title).
 * @returns      FileArtifact with path="" and the full HTML in content. The
 *               caller sets the final path.
 */
export function renderAuditHtml(
  pack: AuditPack,
  visJs: string,
  opts: AuditRenderOpts,
): FileArtifact {
  const { projectName } = opts;
  const roles = classifyRoles(pack);
  const labelById = new Map(pack.nodes.map((n) => [n.id, n.label || n.id]));

  const visNodes = buildAuditVisNodes(pack, roles);
  const visEdges = buildAuditVisEdges(pack.edges);
  const pathSummaries = buildPathSummaries(pack, labelById);

  const sourceCount = new Set(pack.paths.map((p) => p.source)).size;
  const sinkCount = new Set(pack.paths.map((p) => p.sink)).size;

  // Security: replace "</" with "<\/" so embedded JSON never closes the <script>.
  const payload = JSON.stringify({ nodes: visNodes, edges: visEdges }).replaceAll("</", String.raw`<\/`);
  const meta = JSON.stringify({
    totals: {
      paths: pack.paths.length,
      sources: sourceCount,
      sinks: sinkCount,
      repos: pack.reposInvolved.length,
    },
    prunedPaths: pack.prunedPaths,
    colors: ROLE_COLORS,
    confColors: CONF_COLORS,
    paths: pathSummaries,
    disclaimer: pack.disclaimer,
    projectName: escapeHtml(projectName),
  }).replaceAll("</", String.raw`<\/`);

  const content = htmlTemplate(visJs, payload, meta, projectName);
  return { path: "", content };
}
