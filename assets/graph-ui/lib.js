// assets/graph-ui/lib.js — pure, DOM-free helpers for the graph explorer UI (FR-08..13).
//
// Served verbatim by `leina graph serve` (no build step, design §6): plain ES module,
// zero dependencies. Kept separate from app.js (which owns all DOM/fetch/vis-network
// wiring) so the data-shaping logic here can be unit-tested with node:test without a
// browser (test/graph-ui-lib.test.ts imports this file directly).
//
// XSS note (resolves the wave-3 apply note about `nodeDetail()`'s HTML-escaped fields):
// `GET /api/projects/:key/nodes/:id` reuses `application/graph/html-export.ts`'s
// `nodeDetail()` verbatim, whose string fields (label/kind/layer/file/sig) are
// HTML-escaped for the OFFLINE `graph visualize` export, which injects them via
// `innerHTML`. Every other endpoint (search, declaredBy/invokedBy refs, memories text,
// stats, tree) returns RAW, unescaped strings straight from the graph/memory stores.
// This UI never uses `innerHTML` with server data — everything goes through
// `textContent`/`createElement` instead (real XSS safety, not just trusting the
// escaping some other consumer relies on). Because of that, the pre-escaped `node.*`
// fields from `/nodes/:id` would otherwise show up double-escaped (e.g. "AT&amp;T"
// instead of "AT&T") — `decodeHtmlEntities()` below undoes that specific encoding
// before the text is handed to `textContent`, which is always safe regardless of what
// the string contains.

/** Reverses `escapeHtml()` from application/graph/html-export.ts (&amp; &lt; &gt;
 * &quot; &#39;). Only ever applied to the `node.*` fields of a `/nodes/:id` response —
 * every other payload in this API is already raw. The result is still inserted via
 * `textContent`, never `innerHTML`, so an imperfect decode can't create an XSS vector. */
export function decodeHtmlEntities(value) {
  if (typeof value !== "string") return value;
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_match, name) => {
    switch (name) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "#39": return "'";
      default: return _match;
    }
  });
}

// ---------------------------------------------------------------------------
// FR-12: drift badge (usable | warning | do_not_use), plus an explicit unknown state.
// ---------------------------------------------------------------------------

const DRIFT_LABELS = {
  usable: "usable",
  warning: "warning",
  do_not_use: "no usar",
};

/** Maps a memory's drift verdict to a display label + CSS class. Unknown/missing
 * verdicts get their own explicit (non-error) state, never silently coerced to "usable". */
export function driftBadge(driftState) {
  const key = typeof driftState === "string" ? driftState : "";
  const label = DRIFT_LABELS[key] ?? (key || "desconocido");
  const className =
    key === "usable" ? "badge-usable" :
    key === "warning" ? "badge-warning" :
    key === "do_not_use" ? "badge-danger" :
    "badge-unknown";
  return { label, className };
}

// ---------------------------------------------------------------------------
// FR-09: deterministic colour per node `kind` (no server-side palette to reuse — the
// stats/search/detail endpoints return kind as a bare string, not a colour).
// ---------------------------------------------------------------------------

const KIND_PALETTE = [
  "#58a6ff", "#3fb950", "#f0b429", "#bc8cff", "#ff7b72",
  "#79c0ff", "#d29922", "#db61a2", "#39d353", "#ffa657",
];

/** Same hex colour for the same kind every time (stable across reloads/searches),
 * cycling through a small fixed palette via a cheap string hash — no state, no I/O. */
export function colorForKind(kind) {
  const key = kind || "unknown";
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return KIND_PALETTE[hash % KIND_PALETTE.length];
}

// ---------------------------------------------------------------------------
// FR-10: folder filter — "is this file under the selected folder?"
// ---------------------------------------------------------------------------

/** `folderPath === ""` (no filter, or root) always matches. Otherwise `file` must be
 * exactly the folder itself or nested under it (`folder/…`, not just a name prefix like
 * `folder-2/…`). */
export function folderMatches(file, folderPath) {
  if (!folderPath) return true;
  if (typeof file !== "string") return false;
  return file === folderPath || file.startsWith(`${folderPath}/`);
}

/** Inverse convenience for the vis DataSet `hidden` flag. */
export function isOutsideFolder(file, folderPath) {
  return !folderMatches(file, folderPath);
}

// ---------------------------------------------------------------------------
// vis-network dataset builders — turn API payload items into vis node/edge objects.
// Pure: no DOM, no vis.DataSet calls (app.js owns add/update against the live dataset).
// ---------------------------------------------------------------------------

/** From a `/search` result item ({id,label,kind,file}) or an edge ref ({id,label,kind,
 * file,relation}) — both share the same {id,label,kind,file} shape, and both are RAW
 * (unescaped) per the module doc above. */
export function buildNodeFromSearchResult(item) {
  const kind = item.kind || "unknown";
  return {
    id: item.id,
    label: item.label || item.id,
    _kind: kind,
    _file: item.file || "",
  };
}

/** From the `node` field of a `/nodes/:id` response — HTML-escaped strings (see module
 * doc), decoded here so downstream `textContent`/vis-network canvas labels show the
 * real text instead of literal "&amp;"/"&lt;" sequences. */
export function buildNodeFromDetail(nodeId, nodeDetail) {
  const d = nodeDetail || {};
  const kind = decodeHtmlEntities(d.kind || "unknown");
  return {
    id: nodeId,
    label: decodeHtmlEntities(d.label || nodeId),
    _kind: kind,
    _file: decodeHtmlEntities(d.file || ""),
  };
}

/** `declaredBy`/`invokedBy` entries are inbound edges INTO the centre node: `ref` is the
 * source (the declarer/caller), `centerId` the target. */
export function buildEdgeFromRef(centerId, ref) {
  return {
    id: `${ref.id}->${centerId}:${ref.relation}`,
    from: ref.id,
    to: centerId,
    label: ref.relation,
    _relation: ref.relation,
  };
}

// ---------------------------------------------------------------------------
// FR-08: URL state (project + selected node + optional token) — a page reload/share
// reproduces the same view.
// ---------------------------------------------------------------------------

/** Reads `?project=&node=&token=` from a location.search-style string. Every field is
 * omitted (not empty-string) when absent, so callers can `??`/`||` sensible defaults. */
export function parseUrlState(search) {
  const params = new URLSearchParams(search || "");
  const state = {};
  const project = params.get("project");
  const node = params.get("node");
  const token = params.get("token");
  if (project) state.project = project;
  if (node) state.node = node;
  if (token) state.token = token;
  return state;
}

/** Inverse of `parseUrlState` for the fields that matter to shareable state (project,
 * node). Returns "" (no leading "?") when nothing needs representing. */
export function buildUrlQuery(state) {
  const params = new URLSearchParams();
  if (state && state.project) params.set("project", state.project);
  if (state && state.node) params.set("node", state.node);
  if (state && state.token) params.set("token", state.token);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
