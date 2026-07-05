// community.ts — Pure-TS Louvain modularity community detection.
//
// Key properties:
//   · Zero native dependencies (only node:* and domain types).
//   · Deterministic: node iteration is always in sorted-id order; ties broken
//     to the lowest community id so repeated runs produce identical output.
//   · Undirected weighted adjacency: edge.weight is summed in BOTH directions;
//     `contains` edges are included for cohesion (per spec R-VIS-3).
//   · Final community ids are relabelled 0..K-1 by first appearance in
//     sorted-id order (normalizeLabels).
//   · Cognitive Complexity ≤ 15 per function (eslint-plugin-sonarjs enforced).

import type { GraphEdge, GraphNode } from "../../domain/graph/model.ts";

// Maximum one-level passes before we give up (prevents infinite loops on
// pathological graphs while still converging for typical code graphs).
const MAX_PASSES = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Weighted adjacency list: nodeId → Map<neighbourId, weight> */
type Adjacency = Map<string, Map<string, number>>;

/** Node-level state during optimisation */
interface State {
  community: Map<string, number>;  // nodeId → communityId
  nodeIds: string[];               // sorted, stable iteration order
  adj: Adjacency;
  totalWeight: number;             // 2m (sum of all degrees)
  communityWeight: Map<number, number>; // communityId → Σ degrees of members
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Detect communities using the Louvain modularity method.
 * Returns a Map from node id to community index (0-based, contiguous).
 */
export function detectCommunities(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, number> {
  if (nodes.length === 0) return new Map();

  const nodeIds = nodes.map((n) => n.id).sort((a, b) => a.localeCompare(b));
  const adj = buildWeightedAdjacency(nodeIds, edges);
  const state = initState(nodeIds, adj);

  // Run Louvain phases until no improvement is possible.
  // Each phase: one-level optimisation on the current partition.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const moved = oneLevel(state);
    if (!moved) break;
  }

  return normalizeLabels(state.community, nodeIds);
}

// ---------------------------------------------------------------------------
// Helper: build undirected weighted adjacency
// ---------------------------------------------------------------------------

export function buildWeightedAdjacency(
  nodeIds: string[],
  edges: GraphEdge[],
): Adjacency {
  const nodeSet = new Set(nodeIds);
  const adj: Adjacency = new Map();
  for (const id of nodeIds) adj.set(id, new Map());

  for (const e of edges) {
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
    if (e.source === e.target) continue; // skip self-loops

    const w = e.weight > 0 ? e.weight : 1;
    addEdgeWeight(adj, e.source, e.target, w);
    addEdgeWeight(adj, e.target, e.source, w);
  }
  return adj;
}

function addEdgeWeight(adj: Adjacency, a: string, b: string, w: number): void {
  const aMap = adj.get(a)!;
  aMap.set(b, (aMap.get(b) ?? 0) + w);
}

// ---------------------------------------------------------------------------
// Helper: initialise Louvain state (each node in its own community)
// ---------------------------------------------------------------------------

function initState(nodeIds: string[], adj: Adjacency): State {
  const community = new Map<string, number>();
  const communityWeight = new Map<number, number>();

  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i]!;
    community.set(id, i);
    communityWeight.set(i, nodeDegree(adj, id));
  }

  const totalWeight = computeTotalWeight(adj, nodeIds);
  return { community, nodeIds, adj, totalWeight, communityWeight };
}

function nodeDegree(adj: Adjacency, id: string): number {
  let deg = 0;
  const nbrs = adj.get(id);
  if (nbrs) for (const w of nbrs.values()) deg += w;
  return deg;
}

function computeTotalWeight(adj: Adjacency, nodeIds: string[]): number {
  let total = 0;
  for (const id of nodeIds) total += nodeDegree(adj, id);
  // Each undirected edge is counted twice (once per direction).
  return total;
}

// ---------------------------------------------------------------------------
// Helper: one-level optimisation (greedy node reassignment)
// Returns true when at least one node moved community.
// ---------------------------------------------------------------------------

export function oneLevel(state: State): boolean {
  let anyMoved = false;
  const { nodeIds, community, adj, communityWeight } = state;
  const m2 = state.totalWeight; // 2m

  for (const id of nodeIds) {
    const currentCom = community.get(id)!;
    const ki = nodeDegree(adj, id);

    const { bestCom } = findBestCommunity(id, currentCom, ki, m2, state);
    if (bestCom !== currentCom) {
      moveToCommunity(id, currentCom, bestCom, ki, community, communityWeight);
      anyMoved = true;
    }
  }
  return anyMoved;
}

/** Returns the best community for `id` (may be its current community). */
function findBestCommunity(
  id: string,
  currentCom: number,
  ki: number,
  m2: number,
  state: State,
): { bestCom: number; bestGain: number } {
  const { adj, community, communityWeight } = state;
  let bestCom = currentCom;
  let bestGain = 0;

  const kiIn = weightTowardCommunity(id, currentCom, adj, community);
  const sigmaCurrentWithout = (communityWeight.get(currentCom) ?? 0) - ki;

  // Gather neighbour communities (sorted for determinism).
  const candidateComs = collectNeighbourCommunities(id, currentCom, adj, community);

  for (const targetCom of candidateComs) {
    const kj = weightTowardCommunity(id, targetCom, adj, community);
    const sigmaTot = communityWeight.get(targetCom) ?? 0;
    const gain = modularityGain(kj, kiIn, ki, sigmaTot, sigmaCurrentWithout, m2);
    if (gain > bestGain || (gain === bestGain && targetCom < bestCom)) {
      bestGain = gain;
      bestCom = targetCom;
    }
  }
  return { bestCom, bestGain };
}

/** Sorted list of distinct neighbouring communities (excluding current). */
function collectNeighbourCommunities(
  id: string,
  currentCom: number,
  adj: Adjacency,
  community: Map<string, number>,
): number[] {
  const seen = new Set<number>();
  const nbrs = adj.get(id);
  if (nbrs) {
    for (const nbr of nbrs.keys()) {
      const c = community.get(nbr)!;
      if (c !== currentCom) seen.add(c);
    }
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/** Sum of edge weights from `id` toward nodes in `com`. */
function weightTowardCommunity(
  id: string,
  com: number,
  adj: Adjacency,
  community: Map<string, number>,
): number {
  let w = 0;
  const nbrs = adj.get(id);
  if (nbrs) {
    for (const [nbr, wt] of nbrs) {
      if (community.get(nbr) === com) w += wt;
    }
  }
  return w;
}

/** Louvain modularity gain for moving `id` out of current and into target.
 *  Formula: ΔQ = [kj/(2m) - (sigmaTot*ki)/(2m)²] − [kiIn/(2m) − (sigmaCurrentWithout*ki)/(2m)²]
 *  Simplified form used here avoids the 1/(2m) constant (sign is preserved). */
export function modularityGain(
  kj: number,          // weight of id toward target community
  kiIn: number,        // weight of id toward current community (excl. self)
  ki: number,          // total degree of id
  sigmaTot: number,    // total degree of target community
  sigmaCurrentWithout: number, // total degree of current community minus id
  m2: number,          // 2m
): number {
  if (m2 === 0) return 0;
  const toTarget = kj - (sigmaTot * ki) / m2;
  const fromCurrent = kiIn - (sigmaCurrentWithout * ki) / m2;
  return toTarget - fromCurrent;
}

function moveToCommunity(
  id: string,
  fromCom: number,
  toCom: number,
  ki: number,
  community: Map<string, number>,
  communityWeight: Map<number, number>,
): void {
  community.set(id, toCom);
  communityWeight.set(fromCom, (communityWeight.get(fromCom) ?? 0) - ki);
  communityWeight.set(toCom, (communityWeight.get(toCom) ?? 0) + ki);
}

// ---------------------------------------------------------------------------
// Helper: aggregate super-graph (unused in single-level; kept for future
// multi-level extension and to maintain the helper decomposition contract)
// ---------------------------------------------------------------------------

/** Build aggregated adjacency for the current partition.
 *  Each community becomes a super-node; edge weights are summed. */
export function aggregate(state: State): Adjacency {
  const { nodeIds, adj, community } = state;
  const comSet = new Set(community.values());
  const superAdj: Adjacency = new Map();
  for (const c of comSet) superAdj.set(String(c), new Map());

  for (const id of nodeIds) {
    const srcCom = String(community.get(id)!);
    const nbrs = adj.get(id);
    if (!nbrs) continue;
    for (const [nbr, w] of nbrs) {
      const tgtCom = String(community.get(nbr)!);
      if (srcCom === tgtCom) continue;
      addEdgeWeight(superAdj, srcCom, tgtCom, w);
    }
  }
  return superAdj;
}

// ---------------------------------------------------------------------------
// Helper: normalise community labels to 0..K-1 (first-appearance order)
// ---------------------------------------------------------------------------

/** Relabel community ids so they are 0-indexed and contiguous.
 *  Assignment order follows sorted node ids (deterministic). */
export function normalizeLabels(
  community: Map<string, number>,
  sortedNodeIds: string[],
): Map<string, number> {
  const remap = new Map<number, number>();
  let next = 0;
  const result = new Map<string, number>();

  for (const id of sortedNodeIds) {
    const raw = community.get(id)!;
    if (!remap.has(raw)) remap.set(raw, next++);
    result.set(id, remap.get(raw)!);
  }
  return result;
}
