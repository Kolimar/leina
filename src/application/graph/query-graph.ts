// The engine behind `query` / MCP graph_query: score every node against the question
// (relevance.ts), keep the best few as seeds, then grow a small, focused neighbourhood.
//
// Expansion prefers meaning over structure: from each node it takes at most SEM_CAP
// semantic neighbours per hop (calls, implements, references, …), best first — question
// relevance, then relation weight — and descends `contains`/`method` only from a
// module/class/interface into members that are themselves relevant (CHILD_CAP). A seed's
// file-mates are never pulled in just for sharing its file: that used to fill the whole
// 40-node budget with one module's contents. Test/mock/fixture nodes are left out of the
// expansion (and penalised as seeds) unless includeTests or the question is about tests.

import type { GraphEdge, GraphNode, Relation } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import { RelevanceModel } from "./relevance.ts";

export interface QueryOptions {
  /** Neighbourhood hops around the seeds (default 2). */
  depth?: number;
  /** Max nodes in the result, seeds included (default 25). */
  maxNodes?: number;
  /** Score and expand test/mock/fixture nodes like production code (default false). */
  includeTests?: boolean;
}

export const QUERY_DEFAULTS = { depth: 2, maxNodes: 25 } as const;

export interface QueryResult {
  seeds: GraphNode[];
  /** Seeds first, then the neighbourhood in rank order. */
  nodes: GraphNode[];
  /** Non-structural edges among `nodes` (`contains`/`method` are implied by file and label). */
  edges: GraphEdge[];
  /** True when test-like nodes were penalised/left out (no includeTests, question not about tests). */
  testsExcluded: boolean;
}

const STRUCTURAL: ReadonlySet<Relation> = new Set<Relation>(["contains", "method"]);
const CONTAINER_KINDS: ReadonlySet<string> = new Set(["module", "class", "interface"]);
const REL_WEIGHT: ReadonlyMap<string, number> = new Map([
  ["calls", 1], ["implements", 1], ["overrides", 1],
  ["references", 0.7], ["extends", 0.7], ["inherits", 0.7],
  ["uses", 0.6], ["reads", 0.6], ["writes", 0.6], ["deploys", 0.6], ["configures", 0.6], ["exposes", 0.6],
  ["imports", 0.4], ["imports_from", 0.4],
]);
const SEED_LIMIT = 3;
// A seed must score at least this fraction of the best one (no filler seeds).
const SEED_FLOOR = 0.3;
const SEM_CAP = 8;
const CHILD_CAP = 4;

interface MemGraph {
  nodes: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
  owner: Map<string, string>;
}

interface Ranking {
  g: MemGraph;
  model: RelevanceModel;
  scores: Map<string, number>;
  top: number;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function queryGraph(store: GraphRepository, question: string, opts: QueryOptions = {}): QueryResult {
  const depth = opts.depth ?? QUERY_DEFAULTS.depth;
  const maxNodes = opts.maxNodes ?? QUERY_DEFAULTS.maxNodes;
  const g = loadGraph(store);
  const model = new RelevanceModel(
    [...g.nodes.values()],
    (id) => {
      const owner = g.owner.get(id);
      return owner === undefined ? undefined : g.nodes.get(owner);
    },
    question,
    { includeTests: opts.includeTests },
  );
  const scores = new Map<string, number>();
  for (const n of g.nodes.values()) {
    const s = model.score(n);
    if (s > 0) scores.set(n.id, s);
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  const top = ranked[0]?.[1] ?? 0;
  const seeds = ranked
    .filter(([, s]) => s >= SEED_FLOOR * top)
    .slice(0, Math.min(SEED_LIMIT, maxNodes))
    .map(([id]) => g.nodes.get(id)!);
  const order = expand({ g, model, scores, top }, seeds, depth, maxNodes);
  const included = new Set(order);
  return {
    seeds,
    nodes: order.map((id) => g.nodes.get(id)!),
    edges: edgesAmong(g, order, included),
    testsExcluded: !model.includeTests,
  };
}

// One pass over the store: node map, adjacency both ways, member → owner.
function loadGraph(store: GraphRepository): MemGraph {
  const g: MemGraph = { nodes: new Map(), out: new Map(), in: new Map(), owner: new Map() };
  for (const n of store.allNodes()) g.nodes.set(n.id, n);
  for (const e of store.allEdges()) {
    push(g.out, e.source, e);
    push(g.in, e.target, e);
    if (e.relation === "method") g.owner.set(e.target, e.source);
  }
  return g;
}

function push(m: Map<string, GraphEdge[]>, k: string, e: GraphEdge): void {
  const list = m.get(k);
  if (list) list.push(e);
  else m.set(k, [e]);
}

// Best-first, hop by hop: every frontier node proposes its capped candidates, weighted by
// the proposer's own strength (a seed's relevance, decaying per hop) so the best seed's
// neighbourhood is served before a weaker seed's; the hop keeps what fits the budget.
function expand(r: Ranking, seeds: GraphNode[], depth: number, maxNodes: number): string[] {
  const order = seeds.map((s) => s.id);
  const included = new Set(order);
  const strength = new Map(order.map((id) => [id, relevanceOf(r, id)]));
  let frontier = [...order];
  for (let hop = 1; hop <= depth && order.length < maxNodes && frontier.length > 0; hop++) {
    const best = new Map<string, number>();
    for (const id of frontier) {
      const parent = strength.get(id) ?? 0;
      for (const [other, priority] of candidates(r, id)) {
        const p = priority * parent;
        if (!included.has(other) && (best.get(other) ?? -1) < p) best.set(other, p);
      }
    }
    frontier = [...best]
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
      .slice(0, maxNodes - order.length)
      .map(([id]) => id);
    for (const id of frontier) {
      included.add(id);
      order.push(id);
      strength.set(id, Math.max(relevanceOf(r, id), (best.get(id) ?? 0) / 3));
    }
  }
  return order;
}

const relevanceOf = (r: Ranking, id: string): number => (r.scores.get(id) ?? 0) / (r.top || 1);

// A node's proposals: its best SEM_CAP semantic neighbours (either direction) plus, for a
// container, its best CHILD_CAP relevant members. Priority = relation weight + relevance.
function candidates(r: Ranking, id: string): Map<string, number> {
  const relevance = (other: string): number => relevanceOf(r, other);
  const semantic = new Map<string, number>();
  const consider = (other: string, e: GraphEdge): void => {
    if (STRUCTURAL.has(e.relation) || !admissible(r, other)) return;
    const weight = (REL_WEIGHT.get(e.relation) ?? 0.3) * (e.confidence === "AMBIGUOUS" ? 0.5 : 1);
    const p = weight + 2 * relevance(other);
    if ((semantic.get(other) ?? -1) < p) semantic.set(other, p);
  };
  for (const e of r.g.out.get(id) ?? []) consider(e.target, e);
  for (const e of r.g.in.get(id) ?? []) consider(e.source, e);
  const children = new Map<string, number>();
  if (CONTAINER_KINDS.has(r.g.nodes.get(id)?.kind ?? "")) {
    for (const e of r.g.out.get(id) ?? []) {
      if (STRUCTURAL.has(e.relation) && relevance(e.target) > 0 && admissible(r, e.target)) {
        children.set(e.target, 0.5 + 2 * relevance(e.target));
      }
    }
  }
  return new Map([...topN(semantic, SEM_CAP), ...topN(children, CHILD_CAP)]);
}

function admissible(r: Ranking, id: string): boolean {
  const n = r.g.nodes.get(id);
  return n !== undefined && !r.model.isPenalisedTest(n);
}

function topN(m: Map<string, number>, n: number): [string, number][] {
  return [...m].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, n);
}

function edgesAmong(g: MemGraph, order: string[], included: ReadonlySet<string>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const id of order) {
    for (const e of g.out.get(id) ?? []) {
      if (included.has(e.target) && !STRUCTURAL.has(e.relation)) edges.push(e);
    }
  }
  return edges;
}
