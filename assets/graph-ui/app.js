// assets/graph-ui/app.js — DOM + fetch + vis-network wiring for the `leina graph serve`
// explorer UI. Vanilla ES module, no build step (design §6): the browser runs this file
// exactly as shipped.
//
// Data-shaping is delegated to lib.js (pure, unit-tested); everything DOM-related lives
// here. Security: every piece of server-derived text is inserted via `textContent` (or
// as a vis-network canvas label, which is drawn on <canvas> and can't execute markup
// either way) — never `innerHTML`. See lib.js's module doc for the HTML-escaping note.
//
// Rendering model: the FULL graph is loaded up front from /api/projects/:key/graph and
// laid out once (physics freezes after stabilization). Chips, the folder tree and search
// are all visibility/navigation over that one layout — nothing re-fetches the canvas.
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
  // `contains` is pure structure (module→symbol) and drowns the picture at full-graph
  // scale — ships OFF; its chip starts unchecked and one click brings it back.
  hiddenRelations: new Set(["contains"]),
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
  searchResults: document.getElementById("search-results"),
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
  neighborsGroups: document.getElementById("neighbors-groups"),
  memoriesList: document.getElementById("memories-list"),
};

function setStatus(text) {
  els.status.textContent = text || "";
}

function setHint(text) {
  els.emptyHint.hidden = !text;
  els.emptyHint.textContent = text || "";
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
// vis-network canvas — one full-graph layout, frozen after stabilization.
// ---------------------------------------------------------------------------

function initNetwork() {
  const options = {
    nodes: {
      shape: "dot",
      borderWidth: 1.5,
      // Node size AND label size scale with `value` (degree): hubs read from afar,
      // leaf labels only materialize once you zoom in (drawThreshold hides them below
      // 8px drawn size — the built-in cure for the 2k-label hairball).
      scaling: {
        min: 6,
        max: 30,
        label: { enabled: true, min: 9, max: 22, drawThreshold: 8 },
      },
      font: { color: "#e6edf3", size: 12, strokeWidth: 3, strokeColor: "#0d1117" },
    },
    edges: {
      arrows: { to: { enabled: true, scaleFactor: 0.35 } },
      color: { color: "#2b3d46", highlight: "#58a6ff", hover: "#79c0ff", opacity: 0.55 },
      width: 1,
      smooth: false, // straight edges: the difference between usable and slideshow at this scale
    },
    interaction: {
      hover: true,
      tooltipDelay: 120,
      hideEdgesOnDrag: true,
      multiselect: false,
    },
    layout: { improvedLayout: false }, // O(n²)-ish; the physics pass below does the work
    physics: {
      solver: "forceAtlas2Based",
      forceAtlas2Based: {
        gravitationalConstant: -42,
        centralGravity: 0.006,
        springLength: 110,
        springConstant: 0.08,
        damping: 0.6,
        avoidOverlap: 0.4,
      },
      maxVelocity: 60,
      stabilization: { enabled: true, iterations: 300, updateInterval: 25 },
    },
  };
  network = new vis.Network(els.net, { nodes: nodesDs, edges: edgesDs }, options);

  network.on("stabilizationProgress", (params) => {
    const pct = Math.round((params.iterations / params.total) * 100);
    setHint(`Distribuyendo el grafo… ${pct}%`);
  });
  network.on("stabilizationIterationsDone", () => {
    // Freeze the layout: pan/zoom/drag stay fluid because nothing simulates anymore.
    network.setOptions({ physics: false });
    setHint("");
    network.fit({ animation: { duration: 400 } });
  });
  network.on("click", (params) => {
    if (params.nodes && params.nodes.length) {
      void selectNode(params.nodes[0]);
    }
  });
}

function nodeHidden(kind, file) {
  return state.hiddenKinds.has(kind) || lib.isOutsideFolder(file, state.folderFilter);
}

function visNodeStyle(descriptor) {
  const color = lib.colorForKind(descriptor._kind);
  return {
    ...descriptor,
    title: descriptor._file,
    color: {
      background: `${color}55`,
      border: color,
      highlight: { background: `${color}88`, border: "#e6edf3" },
      hover: { background: `${color}77`, border: color },
    },
    hidden: nodeHidden(descriptor._kind, descriptor._file),
  };
}

async function loadGraph() {
  setHint("Cargando el grafo…");
  const body = await apiFetch(projectApiPath("graph"));
  const { nodes, edges } = lib.buildGraphDatasets(body);
  nodesDs.clear();
  edgesDs.clear();
  nodesDs.add(nodes.map(visNodeStyle));
  edgesDs.add(edges.map((e) => ({ ...e, hidden: state.hiddenRelations.has(e._relation) })));
  const truncNote = body.truncated ? " (truncado a los nodos de mayor grado)" : "";
  setStatus(`${nodes.length} nodos · ${edges.length} aristas${truncNote}`);
  // Re-arm physics for the fresh dataset (it was frozen after the previous layout).
  network.setOptions({ physics: true });
  network.stabilize();
}

/** Chip/folder toggles re-evaluate `hidden` on every plotted node/edge (no re-fetch). */
function applyVisibility() {
  const nodeUpdates = nodesDs.get().map((n) => ({ id: n.id, hidden: nodeHidden(n._kind, n._file) }));
  if (nodeUpdates.length) nodesDs.update(nodeUpdates);
  const edgeUpdates = edgesDs.get().map((e) => ({ id: e.id, hidden: state.hiddenRelations.has(e._relation) }));
  if (edgeUpdates.length) edgesDs.update(edgeUpdates);
}

function focusNode(nodeId) {
  if (!nodesDs.get(nodeId)) return;
  network.focus(nodeId, { scale: 1.1, animation: true });
  network.selectNodes([nodeId]);
}

function resetCanvas() {
  nodesDs.clear();
  edgesDs.clear();
  state.hiddenKinds.clear();
  state.hiddenRelations = new Set(["contains"]);
  state.folderFilter = "";
  closeDrawer();
}

// ---------------------------------------------------------------------------
// FR-13: label toggle — one global option flip, not 2k per-node updates.
// ---------------------------------------------------------------------------

function toggleLabels() {
  labelsOn = !labelsOn;
  els.labelsToggle.textContent = labelsOn ? "ocultar etiquetas" : "mostrar etiquetas";
  network.setOptions({
    nodes: {
      font: labelsOn
        ? { color: "#e6edf3", strokeColor: "#0d1117" }
        : { color: "rgba(0,0,0,0)", strokeColor: "rgba(0,0,0,0)" },
    },
  });
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
// FR-10: folder tree — collapsible; folder name filters the plotted graph, the chevron
// expands/collapses, clicking a file focuses its module node.
// ---------------------------------------------------------------------------

function renderFolder(folder, depth) {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-node";

  const children = document.createElement("div");
  children.className = "tree-children";
  const hasChildren = folder.children.length > 0 || folder.files.length > 0;

  if (depth > 0) {
    const row = document.createElement("div");
    row.className = "tree-row tree-folder";
    row.dataset.path = folder.path;

    const chevron = document.createElement("span");
    chevron.className = "chev";
    chevron.textContent = hasChildren ? "▸" : "·";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = folder.path.split("/").pop() || folder.path;
    name.title = folder.path;
    row.append(chevron, name);

    // Depth 1 starts open so the repo's top shape is visible; deeper levels collapsed.
    const startOpen = depth <= 1;
    children.hidden = !startOpen;
    if (hasChildren && startOpen) chevron.textContent = "▾";

    chevron.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!hasChildren) return;
      children.hidden = !children.hidden;
      chevron.textContent = children.hidden ? "▸" : "▾";
    });
    name.addEventListener("click", () => {
      state.folderFilter = state.folderFilter === folder.path ? "" : folder.path;
      renderActiveFolder();
      applyVisibility();
    });
    wrapper.appendChild(row);
  }

  for (const child of folder.children) children.appendChild(renderFolder(child, depth + 1));
  for (const file of folder.files) {
    const row = document.createElement("div");
    row.className = "tree-row tree-file";
    row.textContent = file.split("/").pop() || file;
    row.title = file;
    row.addEventListener("click", () => void focusFile(file));
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
  els.tree.replaceChildren(renderFolder(body.tree, 0));
}

async function focusFile(file) {
  // The full graph is already plotted — find the module node for this file locally.
  const hit = nodesDs.get().find((n) => n._file === file && n._kind === "module")
    ?? nodesDs.get().find((n) => n._file === file);
  if (!hit) {
    setStatus(`sin nodo para ${file}`);
    return;
  }
  focusNode(hit.id);
  await selectNode(hit.id);
}

// ---------------------------------------------------------------------------
// Search — live dropdown of results; Enter selects the first, click selects any.
// ---------------------------------------------------------------------------

let searchTimer = null;

function hideSearchResults() {
  els.searchResults.hidden = true;
  els.searchResults.replaceChildren();
}

function renderSearchResults(results) {
  els.searchResults.replaceChildren();
  if (results.length === 0) {
    hideSearchResults();
    return;
  }
  for (const item of results.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "search-hit";
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = lib.colorForKind(item.kind);
    const label = document.createElement("span");
    label.className = "hit-label";
    label.textContent = item.label;
    const meta = document.createElement("span");
    meta.className = "hit-meta";
    meta.textContent = `${item.kind} · ${item.file}`;
    row.append(sw, label, meta);
    row.addEventListener("mousedown", (event) => {
      event.preventDefault(); // beat the input's blur
      hideSearchResults();
      focusNode(item.id);
      void selectNode(item.id);
    });
    els.searchResults.appendChild(row);
  }
  els.searchResults.hidden = false;
}

async function runSearch(q) {
  const body = await apiFetch(`${projectApiPath("search")}?q=${encodeURIComponent(q)}`);
  renderSearchResults(body.results);
  return body.results;
}

els.searchInput.addEventListener("input", () => {
  const q = els.searchInput.value.trim();
  clearTimeout(searchTimer);
  if (!q || !state.project) {
    hideSearchResults();
    return;
  }
  searchTimer = setTimeout(() => { void runSearch(q).catch((err) => setStatus(err.message)); }, 200);
});

els.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    els.searchInput.value = "";
    hideSearchResults();
  }
});

els.searchInput.addEventListener("blur", () => {
  // Delay so a click on a result (mousedown) lands before the list disappears.
  setTimeout(hideSearchResults, 150);
});

els.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = els.searchInput.value.trim();
  if (!q || !state.project) return;
  void runSearch(q)
    .then((results) => {
      if (results.length === 0) {
        setStatus(`sin resultados para "${q}"`);
        return;
      }
      hideSearchResults();
      focusNode(results[0].id);
      return selectNode(results[0].id);
    })
    .catch((err) => setStatus(err.message));
});

// ---------------------------------------------------------------------------
// FR-11/FR-12: node detail drawer (grouped connections) + memories panel.
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

function renderNeighborGroups(neighbors) {
  els.neighborsGroups.replaceChildren();
  const groups = lib.groupNeighbors(neighbors);
  if (groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "sin conexiones";
    els.neighborsGroups.appendChild(empty);
    return;
  }
  for (const group of groups) {
    const details = document.createElement("details");
    details.className = "nb-group";
    details.open = group.items.length <= 12;
    const summary = document.createElement("summary");
    summary.textContent = `${group.title} (${group.items.length})`;
    details.appendChild(summary);
    const list = document.createElement("div");
    list.className = "ref-list";
    for (const ref of group.items) {
      const row = document.createElement("div");
      row.className = "ref-row";
      const sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = lib.colorForKind(ref.kind);
      const label = document.createElement("span");
      label.textContent = ref.label;
      row.append(sw, label);
      row.title = ref.file;
      row.addEventListener("click", () => {
        focusNode(ref.id);
        void selectNode(ref.id);
      });
      list.appendChild(row);
    }
    details.appendChild(list);
    els.neighborsGroups.appendChild(details);
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
  renderNeighborGroups(detail.neighbors || []);
}

function renderMemoryCard(mem) {
  const { title, body, preview, date } = lib.formatMemory(mem);
  const badge = lib.driftBadge(mem.driftState);

  const item = document.createElement("div");
  item.className = "memory-item";

  const head = document.createElement("div");
  head.className = "memory-head";
  const badgeEl = document.createElement("span");
  badgeEl.className = `badge ${badge.className}`;
  badgeEl.textContent = badge.label;
  const dateEl = document.createElement("span");
  dateEl.className = "memory-date";
  dateEl.textContent = date;
  head.append(badgeEl, dateEl);

  const titleEl = document.createElement("div");
  titleEl.className = "memory-title";
  titleEl.textContent = title;

  const previewEl = document.createElement("div");
  previewEl.className = "memory-preview";
  previewEl.textContent = preview || "(sin contenido)";

  const bodyEl = document.createElement("pre");
  bodyEl.className = "memory-body";
  bodyEl.textContent = body;
  bodyEl.hidden = true;

  item.append(head, titleEl, previewEl, bodyEl);
  if (body) {
    item.classList.add("expandable");
    item.addEventListener("click", () => {
      const expanded = !bodyEl.hidden;
      bodyEl.hidden = expanded;
      previewEl.hidden = !expanded;
      item.classList.toggle("expanded", !expanded);
    });
  }
  return item;
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
    els.memoriesList.appendChild(renderMemoryCard(mem));
  }
}

els.drawerClose.addEventListener("click", () => {
  closeDrawer();
  state.node = null;
  syncUrl();
});

/** FR-11: fetch node detail, open the drawer with its grouped connections, load its
 * memories panel, and reflect the selection in the URL (FR-08). The graph is already
 * fully plotted, so selection never mutates the canvas — it only navigates it. */
async function selectNode(nodeId, opts = {}) {
  state.node = nodeId;
  if (!opts.skipUrlSync) syncUrl();
  setStatus("cargando detalle…");
  try {
    const detail = await apiFetch(projectApiPath("nodes", nodeId));
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
    await Promise.all([loadStats(), loadTree(), loadGraph()]);
    if (opts.nodeId) {
      focusNode(opts.nodeId);
      await selectNode(opts.nodeId, { skipUrlSync: false });
    }
  } catch (err) {
    setStatus(err.message);
    setHint(err.message);
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

  const projects = await loadProjects();
  if (projects.length === 0) {
    setHint("no hay proyectos registrados — corre `leina build`/`leina graph serve` en un proyecto");
    return;
  }
  const requested = urlState.project;
  const initialKey = requested && projects.some((p) => p.projectKey === requested)
    ? requested
    : projects[0].projectKey;
  await selectProject(initialKey, { nodeId: urlState.node });
}

init().catch((err) => setHint(err.message));
