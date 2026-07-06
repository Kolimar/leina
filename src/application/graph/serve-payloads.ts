// application/graph/serve-payloads.ts — Pure JSON payload builders for the
// `leina graph serve` API (spec FR-06). Every function here is I/O-free: given an
// already-open GraphRepository/MemoryRepository (opened by the caller, e.g.
// openFreshStore/openMemoryRepo), it composes the exact response shape the spec's
// endpoint table describes. The HTTP transport (cli/serve/*, next wave) is a thin
// adapter over these functions — it owns routing, status codes and error envelopes.
//
// NOT covered here: GET /api/projects (comes straight from the project registry,
// application/project/registry.ts — no graph/memory involved).

import type { GraphEdge, GraphNode } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import type { MemoryRepository } from "../../domain/memory/ports.ts";
import { latestMemoriesForNode, type NodeVerifier } from "../memory/query.ts";
import { nodeDetail } from "./html-export.ts";

// ---------------------------------------------------------------------------
// GET /api/projects/:key/stats
// ---------------------------------------------------------------------------

export interface KindCount {
  kind: string;
  count: number;
}

export interface RelationCount {
  relation: string;
  count: number;
}

export interface StatsPayload {
  byKind: KindCount[];
  byRelation: RelationCount[];
}

/** Sort a Record<string, number> by count desc, then key asc (deterministic output). */
function sortedEntries(record: Record<string, number>): [string, number][] {
  return Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** FR-14: node counts by `kind` + edge counts by `relation`, over GraphStore.statsBy*(). */
export function buildStatsPayload(store: GraphRepository): StatsPayload {
  return {
    byKind: sortedEntries(store.statsByKind()).map(([kind, count]) => ({ kind, count })),
    byRelation: sortedEntries(store.statsByRelation()).map(([relation, count]) => ({ relation, count })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/projects/:key/tree
// ---------------------------------------------------------------------------

export interface FolderTree {
  /** "" for the root; otherwise a POSIX-relative folder path (e.g. "src/domain"). */
  path: string;
  children: FolderTree[];
  /** Source files that live directly in this folder (full relative path), sorted. */
  files: string[];
}

/** Manual POSIX split — sourceFile is stored as a POSIX-relative path (manifest.ts),
 * so this avoids node:path's platform-dependent separator on non-POSIX hosts. */
function parentPathOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function ensureFolder(index: Map<string, FolderTree>, path: string): FolderTree {
  const existing = index.get(path);
  if (existing) return existing;
  const parent = ensureFolder(index, parentPathOf(path));
  const folder: FolderTree = { path, children: [], files: [] };
  parent.children.push(folder);
  index.set(path, folder);
  return folder;
}

function sortTree(folder: FolderTree): void {
  folder.files.sort();
  folder.children.sort((a, b) => a.path.localeCompare(b.path));
  for (const child of folder.children) sortTree(child);
}

/** FR-10: folder tree derived from every node's `sourceFile`, used to filter the graph
 * to a chosen folder in the UI. Pure — no fs access, only the in-memory node list. */
export function buildTreePayload(nodes: GraphNode[]): { tree: FolderTree } {
  const root: FolderTree = { path: "", children: [], files: [] };
  const index = new Map<string, FolderTree>([["", root]]);
  const seenFiles = new Set<string>();

  for (const n of nodes) {
    const file = n.sourceFile?.replaceAll("\\", "/");
    if (!file || seenFiles.has(file)) continue;
    seenFiles.add(file);
    const dir = parentPathOf(file);
    ensureFolder(index, dir).files.push(file);
  }

  sortTree(root);
  return { tree: root };
}

// ---------------------------------------------------------------------------
// GET /api/projects/:key/search?q=
// ---------------------------------------------------------------------------

export interface SearchResultItem {
  id: string;
  label: string;
  kind: string;
  file: string;
}

export interface SearchPayload {
  results: SearchResultItem[];
}

/** FR-06 search endpoint. Delegates matching to GraphRepository.findByLabel (already
 * capped, see domain/graph/ports.ts) — no extra I/O or additional ranking here. */
export function buildSearchPayload(store: GraphRepository, query: string): SearchPayload {
  const q = query.trim();
  if (!q) return { results: [] };
  return {
    results: store.findByLabel(q).map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind ?? "unknown",
      file: n.sourceFile,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/projects/:key/graph
// ---------------------------------------------------------------------------

export interface GraphPayloadNode {
  id: string;
  label: string;
  kind: string;
  file: string;
  /** Non-`contains` bidirectional degree — the UI scales node size with it. */
  degree: number;
}

export interface GraphPayloadEdge {
  from: string;
  to: string;
  relation: string;
}

export interface GraphPayload {
  nodes: GraphPayloadNode[];
  edges: GraphPayloadEdge[];
  /** True when maxNodes kicked in: the payload keeps the highest-degree nodes only. */
  truncated: boolean;
}

/**
 * Full-graph payload for the explorer's initial render. The incremental endpoints
 * (search/detail) turned out to make a terrible first-load experience — an empty canvas
 * — so the UI now loads the whole graph up front and uses chips/tree as visibility
 * filters over it. For pathological graphs, `maxNodes` keeps the highest-degree nodes
 * (hubs first — the view a human wants anyway) and only edges between kept nodes.
 */
export function buildGraphPayload(store: GraphRepository, maxNodes = 6000): GraphPayload {
  const allNodes = store.allNodes();
  const allEdges = store.allEdges();

  const degree = new Map<string, number>();
  for (const e of allEdges) {
    if (e.relation === "contains") continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  let kept = allNodes;
  const truncated = allNodes.length > maxNodes;
  if (truncated) {
    kept = [...allNodes]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      .slice(0, maxNodes);
  }
  const keptIds = new Set(kept.map((n) => n.id));

  return {
    nodes: kept.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind ?? "unknown",
      file: n.sourceFile,
      degree: degree.get(n.id) ?? 0,
    })),
    edges: allEdges
      .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
      .map((e) => ({ from: e.source, to: e.target, relation: e.relation })),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// GET /api/projects/:key/nodes/:id
// ---------------------------------------------------------------------------

export interface NodeEdgeRef {
  id: string;
  label: string;
  kind: string;
  file: string;
  relation: string;
}

/** One incident edge of the detail node, whatever its relation. `direction` is from the
 * detail node's point of view: "out" = the node points at `id` (e.g. it calls it),
 * "in" = `id` points at the node (e.g. it is called by it). */
export interface NodeNeighbor extends NodeEdgeRef {
  direction: "in" | "out";
}

export interface NodeDetailPayload {
  node: ReturnType<typeof nodeDetail> & { id: string };
  declaredBy: NodeEdgeRef[];
  invokedBy: NodeEdgeRef[];
  /** Every incident edge (all relations, both directions) — the UI's navigable
   * "conexiones" panel. declaredBy/invokedBy above remain as the original narrow
   * views for API compatibility. */
  neighbors: NodeNeighbor[];
}

// Structural edges: who declares/contains this node (its parent module/class).
const DECLARATION_RELATIONS: ReadonlySet<string> = new Set(["contains", "method"]);
// Behavioural edges: who calls this node (FR-11 "llamadores").
const INVOCATION_RELATIONS: ReadonlySet<string> = new Set(["calls"]);

/** Non-`contains` bidirectional degree for a single node — same definition as the A5
 * decision in html-export.ts's buildDegreeMap, computed here without needing the full
 * edge list (one node's in/out edges suffice). */
function nonContainsDegree(store: GraphRepository, id: string): number {
  const out = store.outEdges(id).filter((e) => e.relation !== "contains").length;
  const inn = store.inEdges(id).filter((e) => e.relation !== "contains").length;
  return out + inn;
}

function edgeRef(store: GraphRepository, otherId: string, relation: string): NodeEdgeRef | null {
  const other = store.getNode(otherId);
  if (!other) return null;
  return { id: other.id, label: other.label, kind: other.kind ?? "unknown", file: other.sourceFile, relation };
}

function refsFor(
  store: GraphRepository,
  inbound: GraphEdge[],
  relations: ReadonlySet<string>,
): NodeEdgeRef[] {
  const refs: NodeEdgeRef[] = [];
  for (const e of inbound) {
    if (!relations.has(e.relation)) continue;
    const ref = edgeRef(store, e.source, e.relation);
    if (ref) refs.push(ref);
  }
  return refs;
}

/**
 * FR-06/FR-11: node detail + who declares it (`declaredBy`) + who calls it (`invokedBy`).
 * Returns null when the node doesn't exist — the HTTP layer maps that to 404
 * `NODE_NOT_FOUND` (FR-07).
 *
 * `node` reuses `nodeDetail()` from html-export.ts verbatim (per design/3.1): its string
 * fields are HTML-escaped, matching the same detail object the offline `graph visualize`
 * drawer already renders via `innerHTML`. The UI (wave 4) must render this payload the
 * same way (innerHTML, not textContent) to avoid double-escaping — noted for the next wave.
 */
export function buildNodeDetailPayload(store: GraphRepository, nodeId: string): NodeDetailPayload | null {
  const node = store.getNode(nodeId);
  if (!node) return null;
  const inbound = store.inEdges(nodeId);
  const outbound = store.outEdges(nodeId);
  const degree = nonContainsDegree(store, nodeId);

  const neighbors: NodeNeighbor[] = [];
  for (const e of inbound) {
    const ref = edgeRef(store, e.source, e.relation);
    if (ref) neighbors.push({ ...ref, direction: "in" });
  }
  for (const e of outbound) {
    const ref = edgeRef(store, e.target, e.relation);
    if (ref) neighbors.push({ ...ref, direction: "out" });
  }

  return {
    node: { id: node.id, ...nodeDetail(node, degree) },
    declaredBy: refsFor(store, inbound, DECLARATION_RELATIONS),
    invokedBy: refsFor(store, inbound, INVOCATION_RELATIONS),
    neighbors,
  };
}

// ---------------------------------------------------------------------------
// GET /api/projects/:key/nodes/:id/memories?limit=
// ---------------------------------------------------------------------------

export interface NodeMemoryItem {
  observationId: string;
  text: string;
  driftState: string;
  updatedAt: number;
}

export interface NodeMemoriesPayload {
  memories: NodeMemoryItem[];
}

/** FR-06/FR-12: last N anchored memories for a node, with the drift badge (`usable |
 * warning | do_not_use`, the Verdict from latestMemoriesForNode — see application/memory
 * /query.ts). `text` combines title+content: the memory item, not just its headline. */
export function buildNodeMemoriesPayload(
  store: MemoryRepository,
  nodeId: string,
  verify: NodeVerifier,
  limit = 10,
): NodeMemoriesPayload {
  const items = latestMemoriesForNode(store, nodeId, verify, limit);
  return {
    memories: items.map((m) => ({
      observationId: m.observationId,
      text: m.title ? `${m.title}\n\n${m.content}` : m.content,
      driftState: m.verdict,
      updatedAt: m.updatedAt,
    })),
  };
}
