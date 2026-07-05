// Exact deduplication. With our file-scoped id scheme, same-entity collisions
// within a file already merge by id, so this pass just drops in-memory
// duplicates and self-loops before they hit the store. Fuzzy/LLM dedup
// (MinHash/Jaro-Winkler) is deferred — see plan Roadmap.

import type { GraphEdge, GraphNode } from "../../domain/graph/model.ts";

const edgeKey = (e: GraphEdge): string =>
  `${e.source}\0${e.target}\0${e.relation}\0${e.context ?? ""}`;

export function dedup(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const seenNodes = new Map<string, GraphNode>();
  for (const n of nodes) {
    if (!seenNodes.has(n.id)) seenNodes.set(n.id, n);
  }

  const seenEdges = new Map<string, GraphEdge>();
  for (const e of edges) {
    if (e.source === e.target) continue; // drop self-loops
    const k = edgeKey(e);
    const prev = seenEdges.get(k);
    // keep the higher-confidence edge on collision
    if (!prev || rank(e.confidence) > rank(prev.confidence)) {
      seenEdges.set(k, e);
    }
  }

  return { nodes: [...seenNodes.values()], edges: [...seenEdges.values()] };
}

function rank(c: GraphEdge["confidence"]): number {
  return c === "EXTRACTED" ? 3 : c === "INFERRED" ? 2 : 1;
}
