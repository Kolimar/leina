// domain/graph/ports.ts — Port interfaces for the graph domain.
// Phase 1 (PR-1): interface definitions only — zero behavior change.
// Concrete implementations (GraphStore, extractors, sources.ts) remain in
// their current locations; Phase-3 reorganisation will move them.
//
// Dependency rule: this file MUST import only from domain modules or the
// existing core/model.ts (which will become domain/graph/model.ts in Phase 3).
// No application/, infrastructure/, or cli/ imports allowed here.

import type {
  GraphEdge,
  GraphNode,
  NodeLinkGraph,
} from "./model.ts";

// ---------------------------------------------------------------------------
// GraphStats — return shape of GraphRepository.stats()
// Mirrors the inline return type of GraphStore.stats() verbatim so the
// `implements` declaration compiles without adaptation.
// ---------------------------------------------------------------------------

export interface GraphStats {
  nodes: number;
  edges: number;
  byConfidence: Record<string, number>;
}

// ---------------------------------------------------------------------------
// GraphRepository — port for graph storage (driven adapter)
// Source of truth: GraphStore in src/core/store.ts (Phase 1 is behavior-neutral;
// the interface matches the ACTUAL public surface of GraphStore, not a design ideal).
// ---------------------------------------------------------------------------

export interface GraphRepository {
  /** Remove all nodes and edges from the store. */
  clear(): void;
  /** Bulk-insert nodes, upserting on id collision. Internally transacted. */
  addNodes(nodes: GraphNode[]): void;
  /** Bulk-insert edges, accumulating weights on (source, target, relation, context). */
  addEdges(edges: GraphEdge[]): void;
  /**
   * OPTIONAL — atomically replace all nodes/edges in a single transaction, closing the
   * empty-graph window that clear()+addNodes()+addEdges() leaves open for concurrent
   * readers. Marked optional (with a clear()+addNodes()+addEdges() fallback at the
   * call site) rather than required, so read-only overlay repositories (e.g.
   * OverlayGraphRepository, SyntheticSinkOverlay in application/audit/reachability.ts,
   * whose clear/addNodes/addEdges are already no-ops) don't need a matching no-op
   * implementation just to satisfy the port.
   */
  replaceGraph?(nodes: GraphNode[], edges: GraphEdge[]): void;
  /** Look up a node by its stable id. */
  getNode(id: string): GraphNode | undefined;
  /**
   * Find nodes by label. Preference order: exact (case-insensitive) → functional-exact
   * (normalised label equals normalised query) → substring (shortest first, ≤50).
   */
  findByLabel(query: string): GraphNode[];
  /** Return all nodes. */
  allNodes(): GraphNode[];
  /** Return all edges. */
  allEdges(): GraphEdge[];
  /** Return all edges whose source is `id`. */
  outEdges(id: string): GraphEdge[];
  /** Return all edges whose target is `id`. */
  inEdges(id: string): GraphEdge[];
  /**
   * Total degree (in + out count) for the node with the given id.
   * Returns a plain `number`, NOT `{ in, out }` — behavior-neutral match to
   * the current GraphStore implementation.
   */
  degree(id: string): number;
  /** Aggregate statistics for the stored graph. */
  stats(): GraphStats;
  /** Node counts grouped by `kind` (missing kind bucketed under "unknown"). */
  statsByKind(): Record<string, number>;
  /** Edge counts grouped by `relation`. */
  statsByRelation(): Record<string, number>;
  /** Serialize the graph in node-link format (compatible with networkx). */
  toNodeLink(directed?: boolean): NodeLinkGraph;
  /**
   * Bulk-update the community assignment for the given nodes.
   * Internally transacted; idempotent — re-running with the same assignments
   * leaves the graph in the same state.
   */
  updateCommunities(assignments: { id: string; community: number }[]): void;
  /** Close the underlying database connection. */
  close(): void;
}


