// Graph queries over the store: blast radius (BFS backward), shortest path,
// and a term-scored subgraph query for query_graph.

import type { GraphEdge, GraphNode, Relation } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import { normalizeLabel, splitIdentifier } from "../../domain/shared/id.ts";

// Relations that propagate impact through the graph (blast radius, `affected` command).
const AFFECTED_RELATIONS: ReadonlySet<Relation> = new Set<Relation>([
  "calls",
  "references",
  "imports",
  "imports_from",
  "inherits",
  "extends",
  "implements",
  "uses",
]);

/**
 * Extended relation set for `impact analyze`: AFFECTED_RELATIONS ∪ infra relations.
 * Includes `deploys`, `reads`, `configures`, `exposes` so that code→service/config
 * traversal crosses the code↔infra boundary.
 */
export const IMPACT_RELATIONS: ReadonlySet<string> = new Set<string>([
  ...AFFECTED_RELATIONS,
  "deploys",
  "reads",
  "configures",
  "exposes",
]);

export interface AffectedHit {
  node: GraphNode;
  depth: number;
  viaRelation: Relation;
}

// Blast radius: who depends on this node? Walk INCOMING edges (BFS backward).
export function affected(
  store: GraphRepository,
  seedId: string,
  depth = 3,
): AffectedHit[] {
  // A module/file seed has only structural `contains` edges of its own — its real
  // dependents attach to the MEMBERS (functions, classes, nested methods). Seed the
  // walk with the transitive contains-closure so "what breaks if I touch this file"
  // reports the union of its members' blast radii instead of "(nothing depends on it)".
  const roots = memberClosure(store, seedId);
  const seen = new Set<string>(roots);
  const hits: AffectedHit[] = [];
  let frontier: string[] = [...roots];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      expandAffected(store, id, d, seen, hits, next);
    }
    frontier = next;
  }
  return hits;
}

// Structural edges that define membership: module→symbol is `contains`; class→member
// is `method` (see the Java/C# extractors).
const MEMBER_RELATIONS: ReadonlySet<Relation> = new Set<Relation>(["contains", "method"]);

// The seed plus, when it is a module/file node, everything it transitively contains.
// Symbol seeds (function/class/…) are returned as-is: expanding a class to its methods
// would change the meaning of "who depends on this class".
function memberClosure(store: GraphRepository, seedId: string): Set<string> {
  const roots = new Set<string>([seedId]);
  if (store.getNode(seedId)?.kind !== "module") return roots;
  const queue = [seedId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const e of store.outEdges(id)) {
      if (!MEMBER_RELATIONS.has(e.relation) || roots.has(e.target)) continue;
      roots.add(e.target);
      queue.push(e.target);
    }
  }
  return roots;
}

// Walk one node's incoming edges, recording newly-reached dependents.
function expandAffected(
  store: GraphRepository,
  id: string,
  depth: number,
  seen: Set<string>,
  hits: AffectedHit[],
  next: string[],
): void {
  for (const e of store.inEdges(id)) {
    const hit = affectedHitFor(store, e, depth, seen);
    if (hit) {
      hits.push(hit);
      next.push(hit.node.id);
    }
  }
}

// One incoming edge -> a hit, or null if it should be skipped. Marks seen.
function affectedHitFor(
  store: GraphRepository,
  e: GraphEdge,
  depth: number,
  seen: Set<string>,
): AffectedHit | null {
  if (!AFFECTED_RELATIONS.has(e.relation)) return null;
  // Don't propagate impact through guessed edges — a blast radius must be
  // trustworthy. AMBIGUOUS edges point at an arbitrary candidate.
  if (e.confidence === "AMBIGUOUS") return null;
  if (seen.has(e.source)) return null;
  seen.add(e.source);
  const node = store.getNode(e.source);
  if (!node) return null;
  return { node, depth, viaRelation: e.relation };
}

// Resolve a free-text query to a seed node id: exact id -> exact label -> substring.
export function resolveSeed(store: GraphRepository, query: string): GraphNode | null {
  const direct = store.getNode(query);
  if (direct) return direct;
  const byLabel = store.findByLabel(query);
  return byLabel[0] ?? null;
}

export interface PathStep {
  from: GraphNode;
  to: GraphNode;
  relation: Relation;
  confidence: string;
}

// Shortest path on the undirected view (BFS).
export function shortestPath(
  store: GraphRepository,
  sourceId: string,
  targetId: string,
  maxHops = 8,
): PathStep[] | null {
  if (sourceId === targetId) return [];
  const prev = new Map<string, { id: string; edge: GraphEdge }>();
  const seen = new Set<string>([sourceId]);
  let frontier = [sourceId];
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (expandPath(store, id, targetId, seen, prev, next)) {
        return reconstruct(store, prev, sourceId, targetId);
      }
    }
    frontier = next;
  }
  return null;
}

// Walk one node's neighbors (undirected), recording predecessors. Returns true
// once the target is reached so the caller can stop and reconstruct.
function expandPath(
  store: GraphRepository,
  id: string,
  targetId: string,
  seen: Set<string>,
  prev: Map<string, { id: string; edge: GraphEdge }>,
  next: string[],
): boolean {
  const neighbors: GraphEdge[] = [...store.outEdges(id), ...store.inEdges(id)];
  for (const e of neighbors) {
    const other = e.source === id ? e.target : e.source;
    if (seen.has(other)) continue;
    seen.add(other);
    prev.set(other, { id, edge: e });
    if (other === targetId) return true;
    next.push(other);
  }
  return false;
}

function reconstruct(
  store: GraphRepository,
  prev: Map<string, { id: string; edge: GraphEdge }>,
  sourceId: string,
  targetId: string,
): PathStep[] {
  const steps: PathStep[] = [];
  let cur = targetId;
  while (cur !== sourceId) {
    const p = prev.get(cur);
    if (!p) break;
    const from = store.getNode(p.id);
    const to = store.getNode(cur);
    if (from && to) {
      steps.unshift({
        from,
        to,
        relation: p.edge.relation,
        confidence: p.edge.confidence,
      });
    }
    cur = p.id;
  }
  return steps;
}

export interface QueryResult {
  seeds: GraphNode[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Term-scored subgraph: score nodes by query terms, take top seeds, expand a
// bounded neighborhood — the engine behind the query_graph tool.
export function queryGraph(
  store: GraphRepository,
  question: string,
  depth = 2,
  maxNodes = 40,
): QueryResult {
  const terms = tokenize(question);
  const scored = scoreNodes(store.allNodes(), terms);
  scored.sort((a, b) => b.score - a.score);
  const seeds = scored.slice(0, 3).map((s) => s.node);

  const included = expandNeighborhood(store, seeds, depth, maxNodes);

  const nodeList = collectNodes(store, included);
  const edgeList = store
    .allEdges()
    .filter((e) => included.has(e.source) && included.has(e.target));

  return { seeds, nodes: nodeList, edges: edgeList };
}

// Score every node by query-term overlap; keep only those with a positive score.
function scoreNodes(
  nodes: GraphNode[],
  terms: string[],
): { node: GraphNode; score: number }[] {
  const scored: { node: GraphNode; score: number }[] = [];
  for (const n of nodes) {
    const score = scoreNode(n, terms);
    if (score > 0) scored.push({ node: n, score });
  }
  return scored;
}

function scoreNode(n: GraphNode, terms: string[]): number {
  const label = normalizeLabel(n.label);
  const file = normalizeLabel(n.sourceFile);
  // Word-level view of the identifier: lets "store" hit `openFreshStore` even though the
  // normalized label ("openfreshstore") contains no standalone occurrence of the term.
  const words = new Set(splitIdentifier(n.label));
  let score = 0;
  for (const t of terms) {
    if (label === t) score += 100;
    else if (words.has(t)) score += 12;
    else if (label.startsWith(t)) score += 10;
    else if (label.includes(t)) score += 3;
    if (file.includes(t)) score += 1;
  }
  return score;
}

// BFS outward from the seeds on the undirected view, bounded by depth/maxNodes.
function expandNeighborhood(
  store: GraphRepository,
  seeds: GraphNode[],
  depth: number,
  maxNodes: number,
): Set<string> {
  const included = new Set<string>(seeds.map((s) => s.id));
  let frontier = [...included];
  for (let d = 0; d < depth && included.size < maxNodes; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      expandInto(store, id, included, next, maxNodes);
    }
    frontier = next;
  }
  return included;
}

function expandInto(
  store: GraphRepository,
  id: string,
  included: Set<string>,
  next: string[],
  maxNodes: number,
): void {
  for (const e of [...store.outEdges(id), ...store.inEdges(id)]) {
    const other = e.source === id ? e.target : e.source;
    if (included.has(other) || included.size >= maxNodes) continue;
    included.add(other);
    next.push(other);
  }
}

function collectNodes(store: GraphRepository, included: Set<string>): GraphNode[] {
  const nodeList: GraphNode[] = [];
  for (const id of included) {
    const n = store.getNode(id);
    if (n) nodeList.push(n);
  }
  return nodeList;
}

function tokenize(q: string): string[] {
  // Subtoken the QUERY too: "GraphStore" in a question should match graph AND store.
  const raw = q.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
  const out = new Set<string>();
  for (const t of raw) {
    out.add(normalizeLabel(t));
    for (const w of splitIdentifier(t)) if (w.length > 1) out.add(w);
  }
  out.delete("");
  return [...out];
}
