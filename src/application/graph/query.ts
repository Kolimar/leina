// Graph queries over the store: blast radius (BFS backward), shortest path,
// and (re-exported from query-graph.ts) the term-scored subgraph for query_graph.

import type { GraphEdge, GraphNode, Relation } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import { edgeAt } from "./present.ts";
import { resolveSeedQuery } from "./seed.ts";

// Relations that propagate impact through the graph (blast radius, `affected` command).
const AFFECTED_RELATIONS: ReadonlySet<Relation> = new Set<Relation>([
  "calls",
  "references",
  "imports",
  "imports_from",
  "inherits",
  "extends",
  "implements",
  "overrides",
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
  /** Id of the node this dependent depends on (the edge target it was reached through). */
  target: string;
  /** Where the dependency happens — the edge's own location (a call site), `file:line`. */
  site: string;
  /**
   * Set when the dependent does not reference this node directly but the interface member
   * / base method it implements or overrides (`via`): code typed against a port calls
   * `Port.m`, and every implementation of `Port.m` is what actually runs.
   */
  via?: GraphNode;
}

// A member's contract: Impl.m --implements--> Port.m, Sub.m --overrides--> Base.m.
const CONTRACT_RELATIONS: ReadonlySet<Relation> = new Set<Relation>(["implements", "overrides"]);

// Type-level kinds: a class→interface `implements` edge is NOT a member contract (lifting
// through it would make every reference to the interface type a dependent of the class).
const TYPE_LEVEL_KINDS: ReadonlySet<string> = new Set([
  "class", "interface", "module", "type", "type_alias", "enum", "struct", "trait", "namespace",
]);

// Blast radius: who depends on this node? Walk INCOMING edges (BFS backward), lifting
// member nodes to the contract members they implement/override so callers that go
// through an interface are counted (and labelled `via` that member).
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
  const walk: AffectedWalk = { store, seen: new Set(roots), lifted: new Set(roots), hits: [] };
  let frontier: string[] = [...roots];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      expandAffected(walk, id, d, next);
    }
    frontier = next;
  }
  return walk.hits;
}

interface AffectedWalk {
  store: GraphRepository;
  /** Nodes already reported (or roots) — each dependent is reported once. */
  seen: Set<string>;
  /** Contract members whose callers were already collected. */
  lifted: Set<string>;
  hits: AffectedHit[];
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

// Walk one node's incoming edges — and those of the contract members it implements or
// overrides — recording newly-reached dependents.
function expandAffected(walk: AffectedWalk, id: string, depth: number, next: string[]): void {
  const record = (hit: AffectedHit | null): void => {
    if (!hit) return;
    walk.hits.push(hit);
    next.push(hit.node.id);
  };
  for (const e of walk.store.inEdges(id)) record(affectedHitFor(walk.store, e, depth, walk.seen));
  for (const contract of liftToContracts(walk, id)) {
    for (const e of walk.store.inEdges(contract.id)) {
      // Sibling implementations of the same contract do not depend on this one.
      if (CONTRACT_RELATIONS.has(e.relation)) continue;
      const hit = affectedHitFor(walk.store, e, depth, walk.seen);
      if (hit) hit.via = contract;
      record(hit);
    }
  }
}

// The interface members / base methods `id` transitively implements or overrides
// (Sub.m → Base.m → Port.m), not yet lifted in this walk. Member-level edges only, and
// never through a guessed (AMBIGUOUS) edge.
function liftToContracts(walk: AffectedWalk, id: string): GraphNode[] {
  const out: GraphNode[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (TYPE_LEVEL_KINDS.has(walk.store.getNode(cur)?.kind ?? "")) continue;
    for (const e of walk.store.outEdges(cur)) {
      if (!CONTRACT_RELATIONS.has(e.relation) || e.confidence === "AMBIGUOUS") continue;
      if (walk.lifted.has(e.target)) continue;
      const contract = walk.store.getNode(e.target);
      if (!contract || TYPE_LEVEL_KINDS.has(contract.kind ?? "")) continue;
      walk.lifted.add(e.target);
      out.push(contract);
      queue.push(e.target);
    }
  }
  return out;
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
  return { node, depth, viaRelation: e.relation, target: e.target, site: edgeAt(e, node) };
}

// Resolve a selector to its best EXACT match (id, label, Owner.member, path:symbol — see
// seed.ts); null when nothing matches exactly. Callers that report ambiguity or
// suggestions use resolveSeedQuery directly.
export function resolveSeed(store: GraphRepository, query: string): GraphNode | null {
  return resolveSeedQuery(store, query).seed;
}

export interface PathStep {
  from: GraphNode;
  to: GraphNode;
  relation: Relation;
  confidence: string;
  /**
   * The path walks the undirected view: true when the underlying edge points from → to,
   * false when it points to → from (e.g. `to` calls `from`).
   */
  forward: boolean;
  /** Where the edge happens (a call site, an import), `file:line`. */
  site: string;
}

// Shortest path on the undirected view (BFS). Each step records the real direction of its
// edge, so a caller can print `A <--calls-- B` instead of a misleading forward arrow.
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
        forward: p.edge.source === from.id,
        site: edgeAt(p.edge, store.getNode(p.edge.source)),
      });
    }
    cur = p.id;
  }
  return steps;
}

// The term-scored subgraph (`query` / graph_query) lives in query-graph.ts; re-exported
// here so the graph read API keeps one import path.
export { queryGraph, QUERY_DEFAULTS, type QueryOptions, type QueryResult } from "./query-graph.ts";
