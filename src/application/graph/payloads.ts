// Compact JSON shapes for the graph reads: MCP graph_query / graph_affected / graph_path /
// impact_analyze and `query --json`.
//
// A raw GraphNode carries fileType, community and the full parameter signature — most of a
// 50 KB graph_query answer — and no line an agent can open. Every node here is
// `{id, label, kind, at}`: `label` is owner-qualified for members (`Store.search()`), `at`
// is `file:line`, `id` is a selector the next call accepts. Edges are
// `{source, target, relation, at}` in their real direction, with `at` where the edge
// happens (the call site); `confidence` appears only when it is not EXTRACTED and
// `context` only when set. `repo` stays on nodes in workspace mode, where the
// repo-relative file alone is ambiguous.

import type { Confidence, EdgeContext, GraphEdge, GraphNode, Relation } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import { displayLabel, edgeAt, nodeAt } from "./present.ts";
import type { AffectedHit, PathStep } from "./query.ts";
import type { QueryResult } from "./query-graph.ts";

export interface CompactNode {
  id: string;
  label: string;
  kind: string;
  /** Definition site, `file:line` (`file` when the line is unknown). */
  at: string;
  repo?: string;
}

export interface CompactEdge {
  source: string;
  target: string;
  relation: Relation;
  /** Where the edge happens (call site, import line), `file:line`. */
  at: string;
  confidence?: Confidence;
  context?: EdgeContext;
}

export interface CompactQuery {
  /** Ids of the seeds; they are also the first entries of `nodes`. */
  seeds: string[];
  nodes: CompactNode[];
  edges: CompactEdge[];
  testsExcluded: boolean;
}

/** A dependent from `affected`: `at` is where it depends on `target` (the call site). */
export interface CompactDependent {
  id: string;
  label: string;
  kind: string;
  at: string;
  depth: number;
  relation: Relation;
  /** Id of the node it depends on (the seed at depth 1). */
  target: string;
  /** The interface member / base method it reaches `target` through. */
  via?: CompactNode;
  repo?: string;
}

/** A path as its nodes in order; `edges[i]` joins `nodes[i]` and `nodes[i + 1]`. */
export interface CompactPath {
  nodes: CompactNode[];
  edges: CompactEdge[];
}

export function compactNode(store: GraphRepository, n: GraphNode): CompactNode {
  const out: CompactNode = { id: n.id, label: displayLabel(store, n), kind: n.kind ?? "unknown", at: nodeAt(n) };
  if (n.repo) out.repo = n.repo;
  return out;
}

export function compactEdge(e: GraphEdge, fallback?: GraphNode): CompactEdge {
  const out: CompactEdge = { source: e.source, target: e.target, relation: e.relation, at: edgeAt(e, fallback) };
  if (e.confidence !== "EXTRACTED") out.confidence = e.confidence;
  if (e.context) out.context = e.context;
  return out;
}

export function compactQuery(store: GraphRepository, res: QueryResult): CompactQuery {
  const byId = new Map(res.nodes.map((n) => [n.id, n]));
  return {
    seeds: res.seeds.map((s) => s.id),
    nodes: res.nodes.map((n) => compactNode(store, n)),
    edges: res.edges.map((e) => compactEdge(e, byId.get(e.source))),
    testsExcluded: res.testsExcluded,
  };
}

export function compactDependents(store: GraphRepository, hits: readonly AffectedHit[]): CompactDependent[] {
  return hits.map((h) => {
    const out: CompactDependent = {
      id: h.node.id,
      label: displayLabel(store, h.node),
      kind: h.node.kind ?? "unknown",
      at: h.site,
      depth: h.depth,
      relation: h.viaRelation,
      target: h.target,
    };
    if (h.via) out.via = compactNode(store, h.via);
    if (h.node.repo) out.repo = h.node.repo;
    return out;
  });
}

export function compactPath(store: GraphRepository, start: GraphNode, steps: readonly PathStep[]): CompactPath {
  const nodes = [compactNode(store, start), ...steps.map((s) => compactNode(store, s.to))];
  const edges = steps.map((s): CompactEdge => {
    const out: CompactEdge = {
      source: s.forward ? s.from.id : s.to.id,
      target: s.forward ? s.to.id : s.from.id,
      relation: s.relation,
      at: s.site,
    };
    if (s.confidence !== "EXTRACTED") out.confidence = s.confidence as Confidence;
    return out;
  });
  return { nodes, edges };
}
