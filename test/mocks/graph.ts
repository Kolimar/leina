// Mock GraphRepository for use-case unit tests.

import type { GraphEdge, GraphNode, NodeLinkGraph } from "../../src/domain/graph/model.ts";
import type { GraphRepository, GraphStats } from "../../src/domain/graph/ports.ts";

export class MockGraphRepository implements GraphRepository {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  closed = false;

  clear(): void {
    this.nodes = [];
    this.edges = [];
  }

  addNodes(nodes: GraphNode[]): void {
    for (const n of nodes) {
      const idx = this.nodes.findIndex((x) => x.id === n.id);
      if (idx >= 0) this.nodes[idx] = n;
      else this.nodes.push(n);
    }
  }

  addEdges(edges: GraphEdge[]): void {
    this.edges.push(...edges);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  findByLabel(query: string): GraphNode[] {
    const q = query.toLowerCase();
    return this.nodes
      .filter((n) => n.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.length - b.label.length);
  }

  allNodes(): GraphNode[] {
    return this.nodes;
  }

  allEdges(): GraphEdge[] {
    return this.edges;
  }

  outEdges(id: string): GraphEdge[] {
    return this.edges.filter((e) => e.source === id);
  }

  inEdges(id: string): GraphEdge[] {
    return this.edges.filter((e) => e.target === id);
  }

  degree(id: string): number {
    return this.edges.filter((e) => e.source === id || e.target === id).length;
  }

  stats(): GraphStats {
    const byConfidence: Record<string, number> = {};
    for (const e of this.edges) {
      byConfidence[e.confidence] = (byConfidence[e.confidence] ?? 0) + 1;
    }
    return { nodes: this.nodes.length, edges: this.edges.length, byConfidence };
  }

  statsByKind(): Record<string, number> {
    const byKind: Record<string, number> = {};
    for (const n of this.nodes) {
      const kind = n.kind ?? "unknown";
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    return byKind;
  }

  statsByRelation(): Record<string, number> {
    const byRelation: Record<string, number> = {};
    for (const e of this.edges) {
      byRelation[e.relation] = (byRelation[e.relation] ?? 0) + 1;
    }
    return byRelation;
  }

  toNodeLink(directed = true): NodeLinkGraph {
    return {
      directed,
      multigraph: false,
      graph: {},
      nodes: this.nodes,
      links: this.edges,
    };
  }

  updateCommunities(assignments: { id: string; community: number }[]): void {
    for (const { id, community } of assignments) {
      const n = this.nodes.find((x) => x.id === id);
      if (n) n.community = community;
    }
  }

  close(): void {
    this.closed = true;
  }
}
