// assets/graph-ui/app.js — DOM + fetch + vis-network wiring for the `leina graph serve`
// explorer UI (tasks 4.1-4.5). Vanilla ES module, no build step (design §6): the browser
// runs this file exactly as shipped.
//
// Data-shaping is delegated to lib.js (pure, unit-tested); everything DOM-related lives
// here. Security: every piece of server-derived text is inserted via `textContent` (or
// as a vis-network canvas label, which is drawn on <canvas> and can't execute markup
// either way) — never `innerHTML`. See lib.js's module doc for the HTML-escaping note.
//
// `vis` is a global provided by /vendor/vis-network.min.js, loaded as a classic
// (non-module) <script> before this module in index.html — same UMD bundle
// `graph visualize`/`audit` inline offline.

import * as lib from "./lib.js";

const state = {
  project: null,
  node: null,
  token: null,
  hiddenKinds: new Set(),
  hiddenRelations: new Set(),
  folderFilter: "",
};

let labelsOn = true;
let network = null;
const nodesDs = new vis.DataSet([]);
const edgesDs = new vis.DataSet([]);

const els = {
  projectSelect: document.getElementById("project-select"),
  kindChips: document.getElementById("kind-chips"),
  relationChips: document.getElementById("relation-chips"),
  tree: document.getElementById("tree"),
  searchForm: document.getElementById("search-form"),
  searchInput: document.getElementById("search-input"),
  net: document.getElementById("net"),
  emptyHint: document.getElementById("empty-hint"),
  labelsToggle: document.getElementById("labels-toggle"),
  fitBtn: document.getElementById("fit-btn"),
  status: document.getElementById("status"),
  drawer: document.getElementById("drawer"),
  drawerClose: document.getElementById("drawer-close"),
  drawerTitle: document.getElementById("drawer-title"),
  drawerBadges: document.getElementById("drawer-badges"),
  drawerFile: document.getElementById("drawer-file"),
  drawerSig: document.getElementById("drawer-sig"),
  drawerSigText: document.getElementById("drawer-sig-text"),
  declaredByList: document.getElementById("declared-by-list"),
  invokedByList: document.getElementById("invoked-by-list"),
  memoriesList: document.getElementById("memories-list"),
};

function setStatus(text) {
  els.status.textContent = text || "";
}

// ---------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------

async function apiFetch(path) {
  const url = new URL(path, location.origin);
  if (state.token) url.searchParams.set("token", state.token);
  const res = await fetch(url.toString());
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = body && body.error ? body.error.message : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function projectApiPath(...segments) {
  const encoded = segments.map((s) => encodeURIComponent(s)).join("/");
  return `/api/projects/${encodeURIComponent(state.project)}/${encoded}`;
}

// ---------------------------------------------------------------------------
// vis-network canvas
// ---------------------------------------------------------------------------

function initNetwork() {
  const options = {
    nodes: { shape: "dot", size: 14, borderWidth: 1.5 },
    edges: {
      arrows: "to",
      color: { color: "#30474f", highlight: "#58a6ff", hover: "#79c0ff" },
      width: 1,
      smooth: { enabled: true, type: "continuous" },
    },
    interaction: { hover: true, tooltipDelay: 120 },
    physics: {
      stabilization: { iterations: 120 },
      barnesHut: { gravitationalConstant: -6000, springLength: 100, springConstant: 0.04 },
    },
  };
  network = new vis.Network(els.net, { nodes: nodesDs, edges: edgesDs }, options);
  network.on("click", (params) => {
    if (params.nodes && params.nodes.length) {
      void selectNode(params.nodes[0]);
    }
  });
}

function labelColor() {
  return labelsOn ? "#e6edf3" : "rgba(0,0,0,0)";
}

function toggleEmptyHint() {
  els.emptyHint.hidden = nodesDs.length > 0;
}

function nodeHidden(kind, file) {
  return state.hiddenKinds.has(kind) || lib.isOutsideFolder(file, state.folderFilter);
}

/** Add (or refresh) a node in the vis canvas from a pure lib.js node descriptor. */
function upsertVisNode(descriptor) {
  const color = lib.colorForKind(descriptor._kind);
  const visNode = {
    id: descriptor.id,
    label: descriptor.label,
    group: descriptor._kind,
    title: descriptor._file,
    _kind: descriptor._kind,
    _file: descriptor._file,
    color: {
      background: `${color}33`,
      border: color,
      highlight: { background: `${color}55`, border: color },
    },
    font: { color: labelColor(), size: 12, strokeWidth: 3, strokeColor: "#0d1117" },
    hidden: nodeHidden(descriptor._kind, descriptor._file),
  };
  if (nodesDs.get(descriptor.id)) nodesDs.update(visNode);
  else nodesDs.add(visNode);
  toggleEmptyHint();
}

function upsertVisEdge(descriptor) {
  const visEdge = {
    id: descriptor.id,
    from: descriptor.from,
    to: descriptor.to,
    label: descriptor.label,
    _relation: descriptor._relation,
    hidden: state.hiddenRelations.has(descriptor._relation),
  };
  if (edgesDs.get(descriptor.id)) edgesDs.update(visEdge);
  else edgesDs.add(visEdge);
}

/** FR-09: chip toggle re-evaluates hidden on every plotted node/edge (no re-fetch). */
function applyVisibility() {
  const nodeUpdates = nodesDs.get().map((n) => ({ id: n.id, hidden: nodeHidden(n._kind, n._file) }));
  if (nodeUpdates.length) nodesDs.update(nodeUpdates);
  const edgeUpdates = edgesDs.get().map((e) => ({ id: e.id, hidden: state.hiddenRelations.has(e._relation) }));
  if (edgeUpdates.length) edgesDs.update(edgeUpdates);
}

function focusNode(nodeId) {
  network.focus(nodeId, { scale: 1.2, animation: true });
  network.selectNodes([nodeId]);
}

function resetCanvas() {
  nodesDs.clear();
  edgesDs.clear();
  state.hiddenKinds.clear();
  state.hiddenRelations.clear();
  state.folderFilter = "";
  closeDrawer();
  toggleEmptyHint();
}

// ---------------------------------------------------------------------------
// FR-13: label toggle — client-side only, no re-fetch.
// ---------------------------------------------------------------------------

function toggleLabels() {
  labelsOn = !labelsOn;
  els.labelsToggle.textContent = labelsOn ? "ocultar etiquetas" : "mostrar etiquetas";
  const updates = nodesDs.get().map((n) => ({ id: n.id, font: { ...n.font, color: labelColor() } }));
  if (updates.length) nodesDs.update(updates);
}

// ---------------------------------------------------------------------------
// FR-09: chips (kind + relation), with counts from /stats.
// ---------------------------------------------------------------------------

function renderChips(container, items, field, hiddenSet, onToggle) {
  container.replaceChildren();
  for (const item of items) {
    const key = item[field];
    const row = document.createElement("label");
    row.className = "chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !hiddenSet.has(key);
    input.addEventListener("change", () => {
      if (input.checked) hiddenSet.delete(key);
      else hiddenSet.add(key);
      onToggle();
    });
    const swatch = document.createElement("span");
    swatch.className = "sw";
    if (field === "kind") swatch.style.background = lib.colorForKind(key);
    const text = document.createElement("span");
    text.textContent = key;
    const count = document.createElement("span");
    count.className = "ct";
    count.textContent = String(item.count);
    row.append(input, swatch, text, count);
    container.appendChild(row);
  }
}

async function loadStats() {
  const body = await apiFetch(projectApiPath("stats"));
  renderChips(els.kindChips, body.byKind, "kind", state.hiddenKinds, applyVisibility);
  renderChips(els.relationChips, body.byRelation, "relation", state.hiddenRelations, applyVisibility);
}

// ---------------------------------------------------------------------------
// FR-10: folder tree — filters the plotted graph; clicking a file adds its module node.
// ---------------------------------------------------------------------------

function renderFolder(folder, isRoot) {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-node";

  if (!isRoot) {
    const row = document.createElement("div");
    row.className = "tree-row tree-folder";
    row.textContent = folder.path.split("/").pop() || folder.path;
    row.title = folder.path;
    row.addEventListener("click", () => {
      state.folderFilter = state.folderFilter === folder.path ? "" : folder.path;
      renderActiveFolder();
      applyVisibility();
    });
    row.dataset.path = folder.path;
    wrapper.appendChild(row);
  }

  const children = document.createElement("div");
  children.className = "tree-children";
  for (const child of folder.children) children.appendChild(renderFolder(child, false));
  for (const file of folder.files) {
    const row = document.createElement("div");
    row.className = "tree-row tree-file";
    row.textContent = file.split("/").pop() || file;
    row.title = file;
    row.addEventListener("click", () => void addNodeByFile(file));
    children.appendChild(row);
  }
  wrapper.appendChild(children);
  return wrapper;
}

function renderActiveFolder() {
  for (const row of els.tree.querySelectorAll(".tree-folder")) {
    row.classList.toggle("active", row.dataset.path === state.folderFilter);
  }
}

async function loadTree() {
  const body = await apiFetch(projectApiPath("tree"));
  els.tree.replaceChildren(renderFolder(body.tree, true));
}

async function addNodeByFile(file) {
  setStatus(`buscando ${file}…`);
  try {
    const body = await apiFetch(`${projectApiPath("search")}?q=${encodeURIComponent(file)}`);
    const hit = body.results.find((r) => r.file === file) ?? body.results[0];
    if (!hit) {
      setStatus(`sin nodo para ${file}`);
      return;
    }
    upsertVisNode(lib.buildNodeFromSearchResult(hit));
    focusNode(hit.id);
    await selectNode(hit.id);
    setStatus("");
  } catch (err) {
    setStatus(err.message);
  }
}

// ---------------------------------------------------------------------------
// Search box — FR-10 "búsqueda centra/resalta el nodo resultado".
// ---------------------------------------------------------------------------

els.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = els.searchInput.value.trim();
  if (!q || !state.project) return;
  void runSearch(q);
});

async function runSearch(q) {
  setStatus(`buscando "${q}"…`);
  try {
    const body = await apiFetch(`${projectApiPath("search")}?q=${encodeURIComponent(q)}`);
    if (body.results.length === 0) {
      setStatus(`sin resultados para "${q}"`);
      return;
    }
    for (const item of body.results) upsertVisNode(lib.buildNodeFromSearchResult(item));
    const first = body.results[0];
    focusNode(first.id);
    await selectNode(first.id);
    setStatus(`${body.results.length} resultado(s) para "${q}"`);
  } catch (err) {
    setStatus(err.message);
  }
}

// ---------------------------------------------------------------------------
// FR-11/FR-12: node detail drawer + memories panel.
// ---------------------------------------------------------------------------

function closeDrawer() {
  els.drawer.classList.remove("open");
}

function makeBadge(text) {
  const span = document.createElement("span");
  span.className = "badge";
  span.textContent = text;
  return span;
}

function renderRefs(container, refs) {
  container.replaceChildren();
  if (!refs || refs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "ninguno";
    container.appendChild(empty);
    return;
  }
  for (const ref of refs) {
    const row = document.createElement("div");
    row.className = "ref-row";
    row.textContent = `${ref.label} · ${ref.kind}`;
    row.title = ref.file;
    row.addEventListener("click", () => {
      upsertVisNode(lib.buildNodeFromSearchResult(ref));
      focusNode(ref.id);
      void selectNode(ref.id);
    });
    container.appendChild(row);
  }
}

function renderDrawer(nodeId, detail) {
  const d = detail.node || {};
  els.drawer.classList.add("open");
  els.drawerTitle.textContent = lib.decodeHtmlEntities(d.label || nodeId);
  els.drawerBadges.replaceChildren(
    makeBadge(lib.decodeHtmlEntities(d.kind || "?")),
    makeBadge(`capa ${lib.decodeHtmlEntities(d.layer || "?")}`),
    makeBadge(`grado ${d.degree ?? 0}`),
  );
  els.drawerFile.textContent = lib.decodeHtmlEntities(d.file || "");
  if (d.sig) {
    els.drawerSig.hidden = false;
    els.drawerSigText.textContent = lib.decodeHtmlEntities(d.sig);
  } else {
    els.drawerSig.hidden = true;
    els.drawerSigText.textContent = "";
  }
  renderRefs(els.declaredByList, detail.declaredBy);
  renderRefs(els.invokedByList, detail.invokedBy);
}

async function loadMemories(nodeId) {
  els.memoriesList.replaceChildren();
  const body = await apiFetch(projectApiPath("nodes", nodeId, "memories"));
  if (!body.memories || body.memories.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "sin memorias ancladas a este nodo";
    els.memoriesList.appendChild(empty);
    return;
  }
  for (const mem of body.memories) {
    const badge = lib.driftBadge(mem.driftState);
    const item = document.createElement("div");
    item.className = "memory-item";
    const badgeEl = document.createElement("span");
    badgeEl.className = `badge ${badge.className}`;
    badgeEl.textContent = badge.label;
    const text = document.createElement("div");
    text.className = "memory-text";
    text.textContent = mem.text;
    item.append(badgeEl, text);
    els.memoriesList.appendChild(item);
  }
}

els.drawerClose.addEventListener("click", () => {
  closeDrawer();
  state.node = null;
  syncUrl();
});

/** FR-11: fetch node detail, plot it + its declaredBy/invokedBy edges, open the drawer,
 * load its memories panel, and reflect the selection in the URL (FR-08). */
async function selectNode(nodeId, opts = {}) {
  state.node = nodeId;
  if (!opts.skipUrlSync) syncUrl();
  setStatus("cargando detalle…");
  try {
    const detail = await apiFetch(projectApiPath("nodes", nodeId));
    upsertVisNode(lib.buildNodeFromDetail(nodeId, detail.node));
    for (const ref of detail.declaredBy) {
      upsertVisNode(lib.buildNodeFromSearchResult(ref));
      upsertVisEdge(lib.buildEdgeFromRef(nodeId, ref));
    }
    for (const ref of detail.invokedBy) {
      upsertVisNode(lib.buildNodeFromSearchResult(ref));
      upsertVisEdge(lib.buildEdgeFromRef(nodeId, ref));
    }
    renderDrawer(nodeId, detail);
    await loadMemories(nodeId);
    setStatus("");
  } catch (err) {
    setStatus(err.message);
  }
}

// ---------------------------------------------------------------------------
// FR-08: project selector + URL state.
// ---------------------------------------------------------------------------

function syncUrl() {
  const qs = lib.buildUrlQuery({ project: state.project, node: state.node, token: state.token });
  history.replaceState(null, "", `${location.pathname}${qs}`);
}

async function loadProjects() {
  const body = await apiFetch("/api/projects");
  els.projectSelect.replaceChildren();
  for (const p of body.projects) {
    const opt = document.createElement("option");
    opt.value = p.projectKey;
    opt.textContent = p.projectKey;
    els.projectSelect.appendChild(opt);
  }
  return body.projects;
}

async function selectProject(projectKey, opts = {}) {
  state.project = projectKey;
  state.node = null;
  els.projectSelect.value = projectKey;
  resetCanvas();
  syncUrl();
  setStatus(`cargando ${projectKey}…`);
  try {
    await Promise.all([loadStats(), loadTree()]);
    setStatus("");
    if (opts.nodeId) await selectNode(opts.nodeId, { skipUrlSync: false });
  } catch (err) {
    setStatus(err.message);
  }
}

els.projectSelect.addEventListener("change", () => {
  void selectProject(els.projectSelect.value);
});

els.labelsToggle.addEventListener("click", toggleLabels);
els.fitBtn.addEventListener("click", () => network.fit({ animation: true }));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  const urlState = lib.parseUrlState(location.search);
  state.token = urlState.token || null;
  initNetwork();
  toggleEmptyHint();

  const projects = await loadProjects();
  if (projects.length === 0) {
    setStatus("no hay proyectos registrados — corre `leina build`/`leina graph serve` en un proyecto");
    return;
  }
  const requested = urlState.project;
  const initialKey = requested && projects.some((p) => p.projectKey === requested)
    ? requested
    : projects[0].projectKey;
  await selectProject(initialKey, { nodeId: urlState.node });
}

init().catch((err) => setStatus(err.message));
