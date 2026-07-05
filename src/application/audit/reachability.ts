// application/audit/reachability.ts
// Reachability audit: BFS-based reachability over a GraphRepository.
//
// Exports:
//   computeReachable      — core BFS (array-in → ReachabilityResult)
//   auditReachability     — convenience wrapper over a store
//   OverlayGraphRepository — read-only view restricted to a reachable set (CRIT-4 base)
//   SyntheticSinkOverlay  — adds ephemeral sink nodes at audit time (CRIT-4)
//   auditMNReachability   — M sources × N sinks with per-edge confidence (CRIT-5)

import type { Confidence, GraphEdge, GraphNode, NodeLinkGraph, Relation } from "../../domain/graph/model.ts";
import type { GraphRepository, GraphStats } from "../../domain/graph/ports.ts";

// ---------------------------------------------------------------------------
// Reachability result (unchanged public API)
// ---------------------------------------------------------------------------

export interface ReachabilityResult {
  /** Node IDs reachable from the entry points (including the entry points themselves). */
  reachable: Set<string>;
  /** Node IDs in the full graph but NOT reachable from any entry point. */
  unreachable: Set<string>;
  /** Total node count. */
  totalNodes: number;
  /** Percentage of reachable nodes (0–100). */
  coveragePct: number;
}

// ---------------------------------------------------------------------------
// M:N audit path types (CRIT-5)
// ---------------------------------------------------------------------------

/** A single hop in an audit path. */
export interface AuditPathStep {
  from: string;
  to: string;
  relation: Relation;
  confidence: Confidence;
}

/** One source→sink path with per-hop confidence. */
export interface AuditPath {
  source: string;
  sink: string;
  steps: AuditPathStep[];
  /** The minimum confidence of any edge in the path. */
  minConfidence: Confidence;
  /** Distinct repo keys traversed along this path. */
  reposTraversed: string[];
}

// ---------------------------------------------------------------------------
// Core BFS/DFS reachability (unchanged)
// ---------------------------------------------------------------------------

/**
 * Build a plain adjacency list keyed by source node, honoring direction.
 * For "forward" edges flow source→target; for "backward" they flow target→source.
 */
function buildAdjacency(
  allEdges: GraphEdge[],
  direction: "forward" | "backward",
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of allEdges) {
    const from = direction === "forward" ? e.source : e.target;
    const to = direction === "forward" ? e.target : e.source;
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
  }
  return adj;
}

/**
 * BFS over `adj` starting from `entryIds`, restricted to known `nodeIds`.
 * Returns the set of visited (reachable) node IDs.
 */
function bfsReachableSet(
  adj: Map<string, string[]>,
  nodeIds: Set<string>,
  entryIds: string[],
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const id of entryIds) {
    if (nodeIds.has(id) && !visited.has(id)) {
      visited.add(id);
      queue.push(id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    for (const neighbor of adj.get(current) ?? []) {
      if (!visited.has(neighbor) && nodeIds.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return visited;
}

/**
 * Compute nodes reachable from `entryIds` by following outgoing edges.
 */
export function computeReachable(
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
  entryIds: string[],
  direction: "forward" | "backward" = "forward",
): ReachabilityResult {
  const nodeIds = new Set(allNodes.map((n) => n.id));

  const adj = buildAdjacency(allEdges, direction);
  const visited = bfsReachableSet(adj, nodeIds, entryIds);

  const unreachable = new Set<string>();
  for (const id of nodeIds) {
    if (!visited.has(id)) unreachable.add(id);
  }

  const totalNodes = nodeIds.size;
  const coveragePct = totalNodes === 0 ? 100 : Math.round((visited.size / totalNodes) * 100);

  return {
    reachable: visited,
    unreachable,
    totalNodes,
    coveragePct,
  };
}

/**
 * Convenience wrapper: computes reachability from a store's nodes and edges.
 */
export function auditReachability(
  store: GraphRepository,
  entryIds: string[],
  direction: "forward" | "backward" = "forward",
): ReachabilityResult {
  const allNodes = store.allNodes();
  const allEdges = store.allEdges();
  return computeReachable(allNodes, allEdges, entryIds, direction);
}

// ---------------------------------------------------------------------------
// M:N source × sink reachability with per-edge confidence (CRIT-5)
// ---------------------------------------------------------------------------

const CONF_ORDER: Record<Confidence, number> = {
  EXTRACTED: 0,
  INFERRED: 1,
  AMBIGUOUS: 2,
  SYNTACTIC: 3,
};

function minConf(a: Confidence, b: Confidence): Confidence {
  return CONF_ORDER[a] >= CONF_ORDER[b] ? a : b;
}

interface BfsEntry {
  id: string;
  path: AuditPathStep[];
  confidence: Confidence;
  repos: Set<string>;
}

type EdgeAdjacency = Map<string, { to: string; edge: GraphEdge }[]>;

/** Shared, source-independent context for an M:N BFS traversal. */
interface MNContext {
  adj: EdgeAdjacency;
  nodeRepo: Map<string, string>;
  sinkSet: Set<string>;
  allNodeIds: Set<string>;
  maxHops: number;
}

/** Build forward adjacency keyed by source node, carrying edge references. */
function buildEdgeAdjacency(allEdges: GraphEdge[]): EdgeAdjacency {
  const adj: EdgeAdjacency = new Map();
  for (const e of allEdges) {
    const list = adj.get(e.source);
    const entry = { to: e.target, edge: e };
    if (list) list.push(entry);
    else adj.set(e.source, [entry]);
  }
  return adj;
}

/** Build node-id → repo lookup, skipping nodes without a repo. */
function buildNodeRepoMap(allNodes: GraphNode[]): Map<string, string> {
  const nodeRepo = new Map<string, string>();
  for (const n of allNodes) {
    if (n.repo) nodeRepo.set(n.id, n.repo);
  }
  return nodeRepo;
}

/** Return a copy of `base` with `repo` added (if defined). */
function reposWith(base: Set<string>, repo: string | undefined): Set<string> {
  const next = new Set(base);
  if (repo) next.add(repo);
  return next;
}

/**
 * Expand a single outgoing edge during the BFS: either record a completed
 * source→sink path, or enqueue an unvisited intermediate node.
 */
function expandEdge(
  cur: BfsEntry,
  to: string,
  edge: GraphEdge,
  sourceId: string,
  ctx: MNContext,
  visited: Set<string>,
  queue: BfsEntry[],
  paths: AuditPath[],
): void {
  const stepConf = edge.confidence;
  const pathConf = minConf(cur.confidence, stepConf);

  const step: AuditPathStep = {
    from: cur.id,
    to,
    relation: edge.relation,
    confidence: stepConf,
  };
  const newPath = [...cur.path, step];

  if (ctx.sinkSet.has(to)) {
    // Found a source→sink path — record it
    const newRepos = reposWith(cur.repos, ctx.nodeRepo.get(to));
    paths.push({
      source: sourceId,
      sink: to,
      steps: newPath,
      minConfidence: pathConf,
      reposTraversed: [...newRepos].filter(Boolean),
    });
    // Don't stop — other sinks might be reachable further in the graph
    // (don't mark 'to' visited if it's a sink — allow other sources to reach it)
    return;
  }

  if (!visited.has(to) && ctx.allNodeIds.has(to)) {
    visited.add(to);
    queue.push({
      id: to,
      path: newPath,
      confidence: pathConf,
      repos: reposWith(cur.repos, ctx.nodeRepo.get(to)),
    });
  }
}

/** Run the path-tracking BFS for a single source, appending found paths. */
function collectPathsFromSource(
  sourceId: string,
  ctx: MNContext,
  paths: AuditPath[],
): void {
  const visited = new Set<string>([sourceId]);
  const queue: BfsEntry[] = [{
    id: sourceId,
    path: [],
    confidence: "EXTRACTED",
    repos: reposWith(new Set<string>(), ctx.nodeRepo.get(sourceId)),
  }];

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    if (cur.path.length >= ctx.maxHops) continue;

    for (const { to, edge } of ctx.adj.get(cur.id) ?? []) {
      expandEdge(cur, to, edge, sourceId, ctx, visited, queue, paths);
    }
  }
}

/**
 * Compute all paths from each source to each reachable sink.
 * Uses BFS per source with path tracking. Prunes at maxHops to avoid
 * runaway traversal on large graphs.
 *
 * Cross-repo aware: records repo keys from node.repo for each hop.
 *
 * @param store    - GraphRepository (may include SyntheticSinkOverlay nodes)
 * @param sourceIds - node IDs representing data sources
 * @param sinkIds   - node IDs representing dangerous sinks
 * @param maxHops   - maximum path length (default 20)
 */
export function auditMNReachability(
  store: GraphRepository,
  sourceIds: string[],
  sinkIds: string[],
  maxHops = 20,
): AuditPath[] {
  if (sourceIds.length === 0 || sinkIds.length === 0) return [];

  const allNodes = store.allNodes();
  const ctx: MNContext = {
    adj: buildEdgeAdjacency(store.allEdges()),
    nodeRepo: buildNodeRepoMap(allNodes),
    sinkSet: new Set(sinkIds),
    allNodeIds: new Set(allNodes.map((n) => n.id)),
    maxHops,
  };

  const paths: AuditPath[] = [];
  for (const sourceId of sourceIds) {
    // Only start from nodes that actually exist in the graph
    if (!ctx.allNodeIds.has(sourceId)) continue;
    collectPathsFromSource(sourceId, ctx, paths);
  }

  return paths;
}

// ---------------------------------------------------------------------------
// OverlayGraphRepository — read-only view restricted to a reachable set
// ---------------------------------------------------------------------------

/**
 * A read-only view of a GraphRepository restricted to the reachable node set.
 * Edges where source or target is not in the reachable set are excluded.
 * All write operations throw (this is a read-only overlay).
 */
export class OverlayGraphRepository implements GraphRepository {
  private readonly reachableIds: Set<string>;
  private readonly base: GraphRepository;

  constructor(base: GraphRepository, reachable: Set<string>) {
    this.base = base;
    this.reachableIds = reachable;
  }

  allNodes(): GraphNode[] {
    return this.base.allNodes().filter((n) => this.reachableIds.has(n.id));
  }

  allEdges(): GraphEdge[] {
    return this.base
      .allEdges()
      .filter(
        (e) => this.reachableIds.has(e.source) && this.reachableIds.has(e.target),
      );
  }

  getNode(id: string): GraphNode | undefined {
    if (!this.reachableIds.has(id)) return undefined;
    return this.base.getNode(id);
  }

  outEdges(fromId: string): GraphEdge[] {
    if (!this.reachableIds.has(fromId)) return [];
    return this.base.outEdges(fromId).filter((e) => this.reachableIds.has(e.target));
  }

  inEdges(toId: string): GraphEdge[] {
    if (!this.reachableIds.has(toId)) return [];
    return this.base.inEdges(toId).filter((e) => this.reachableIds.has(e.source));
  }

  findByLabel(query: string): GraphNode[] {
    return this.base.findByLabel(query).filter((n) => this.reachableIds.has(n.id));
  }

  degree(id: string): number {
    if (!this.reachableIds.has(id)) return 0;
    const out = this.outEdges(id).length;
    const inn = this.inEdges(id).length;
    return out + inn;
  }

  stats(): GraphStats {
    const nodes = this.allNodes();
    const edges = this.allEdges();
    const byConfidence: Record<string, number> = {};
    for (const e of edges) {
      const c = e.confidence;
      byConfidence[c] = (byConfidence[c] ?? 0) + 1;
    }
    return { nodes: nodes.length, edges: edges.length, byConfidence };
  }

  toNodeLink(directed = true): NodeLinkGraph {
    const nodes = this.allNodes();
    const edges = this.allEdges();
    return {
      directed,
      multigraph: false,
      graph: {},
      nodes,
      links: edges,
    };
  }

  updateCommunities(assignments: { id: string; community: number }[]): void {
    const reachableAssignments = assignments.filter((a) => this.reachableIds.has(a.id));
    if (reachableAssignments.length > 0) {
      this.base.updateCommunities(reachableAssignments);
    }
  }

  clear(): void {
    throw new Error("OverlayGraphRepository is read-only");
  }

  addNodes(_nodes: GraphNode[]): void {
    throw new Error("OverlayGraphRepository is read-only");
  }

  addEdges(_edges: GraphEdge[]): void {
    throw new Error("OverlayGraphRepository is read-only");
  }

  close(): void {
    // Overlay does not own the base store — no-op.
  }
}

// ---------------------------------------------------------------------------
// SyntheticSinkOverlay — adds ephemeral sink nodes at audit time (CRIT-4)
// ---------------------------------------------------------------------------

/**
 * A read-through GraphRepository that prepends synthetic (ephemeral) sink nodes
 * and their implied edges onto the base store. These nodes are NEVER persisted
 * to the underlying store — they exist only for the duration of an audit command.
 *
 * Design (D5): Satisfies FR-13/SC-15 — the store on disk stays unchanged.
 *
 * Usage:
 *   const overlay = new SyntheticSinkOverlay(baseStore, syntheticNodes, syntheticEdges);
 *   const paths = auditMNReachability(overlay, sourceIds, allSinkIds);
 *   overlay.close(); // no-op; does NOT close baseStore
 */
export class SyntheticSinkOverlay implements GraphRepository {
  private readonly base: GraphRepository;
  private readonly syntheticNodes: GraphNode[];
  private readonly syntheticEdges: GraphEdge[];
  private readonly syntheticNodeIds: Set<string>;

  constructor(
    base: GraphRepository,
    syntheticNodes: GraphNode[],
    syntheticEdges: GraphEdge[] = [],
  ) {
    this.base = base;
    this.syntheticNodes = syntheticNodes;
    this.syntheticEdges = syntheticEdges;
    this.syntheticNodeIds = new Set(syntheticNodes.map((n) => n.id));
  }

  allNodes(): GraphNode[] {
    return [...this.base.allNodes(), ...this.syntheticNodes];
  }

  allEdges(): GraphEdge[] {
    return [...this.base.allEdges(), ...this.syntheticEdges];
  }

  getNode(id: string): GraphNode | undefined {
    if (this.syntheticNodeIds.has(id)) {
      return this.syntheticNodes.find((n) => n.id === id);
    }
    return this.base.getNode(id);
  }

  outEdges(fromId: string): GraphEdge[] {
    const base = this.base.outEdges(fromId);
    const synthetic = this.syntheticEdges.filter((e) => e.source === fromId);
    return [...base, ...synthetic];
  }

  inEdges(toId: string): GraphEdge[] {
    const base = this.base.inEdges(toId);
    const synthetic = this.syntheticEdges.filter((e) => e.target === toId);
    return [...base, ...synthetic];
  }

  findByLabel(query: string): GraphNode[] {
    const base = this.base.findByLabel(query);
    const q = query.toLowerCase();
    const synth = this.syntheticNodes.filter((n) => n.label.toLowerCase().includes(q));
    return [...base, ...synth];
  }

  degree(id: string): number {
    return this.outEdges(id).length + this.inEdges(id).length;
  }

  stats(): GraphStats {
    const nodes = this.allNodes();
    const edges = this.allEdges();
    const byConfidence: Record<string, number> = {};
    for (const e of edges) {
      byConfidence[e.confidence] = (byConfidence[e.confidence] ?? 0) + 1;
    }
    return { nodes: nodes.length, edges: edges.length, byConfidence };
  }

  toNodeLink(directed = true): NodeLinkGraph {
    return {
      directed,
      multigraph: false,
      graph: {},
      nodes: this.allNodes(),
      links: this.allEdges(),
    };
  }

  updateCommunities(assignments: { id: string; community: number }[]): void {
    // Only delegate assignments for base (non-synthetic) nodes
    const baseAssignments = assignments.filter((a) => !this.syntheticNodeIds.has(a.id));
    if (baseAssignments.length > 0) {
      this.base.updateCommunities(baseAssignments);
    }
  }

  clear(): void {
    throw new Error("SyntheticSinkOverlay is read-only");
  }

  addNodes(_nodes: GraphNode[]): void {
    throw new Error("SyntheticSinkOverlay is read-only");
  }

  addEdges(_edges: GraphEdge[]): void {
    throw new Error("SyntheticSinkOverlay is read-only");
  }

  /** No-op: SyntheticSinkOverlay does NOT own the base store. */
  close(): void {
    // intentional no-op — caller owns the base store lifecycle
  }
}

// ---------------------------------------------------------------------------
// Synthetic sink node factory (helpers for audit commands)
// ---------------------------------------------------------------------------

/**
 * Built-in dangerous external sinks to inject at audit time.
 * These represent common dangerous APIs that may not appear in the graph
 * because they're in node_modules or not extracted.
 */
export const SYNTHETIC_SINK_DEFINITIONS = [
  { id: "__sink__eval", label: "eval()", category: "eval" },
  { id: "__sink__exec", label: "child_process.exec", category: "exec" },
  { id: "__sink__spawn", label: "child_process.spawn", category: "exec" },
  { id: "__sink__sql_concat", label: "SQL string concat", category: "sql" },
  { id: "__sink__path_write", label: "fs.writeFile", category: "path-traversal" },
  { id: "__sink__fetch_user", label: "fetch(userUrl)", category: "ssrf" },
  { id: "__sink__render_template", label: "renderTemplate()", category: "template-render" },
  { id: "__sink__weak_hash", label: "createHash(md5)", category: "weak-crypto" },
] as const;

/**
 * Create synthetic sink GraphNode objects.
 * These are ephemeral — never written to the store.
 */
export function makeSyntheticSinkNodes(): GraphNode[] {
  return SYNTHETIC_SINK_DEFINITIONS.map((def) => ({
    id: def.id,
    label: def.label,
    fileType: "concept" as const,
    kind: "concept" as const,
    sourceFile: "__synthetic__",
    repo: undefined,
  }));
}
