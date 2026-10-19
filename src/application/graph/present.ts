// Presentation helpers shared by the graph reads' CLI text and JSON/MCP payloads: where a
// node is defined, where an edge happens, and a label that says which class a method
// belongs to (method labels are bare — `search()` — so five `search()` nodes would
// otherwise print identically).

import type { GraphEdge, GraphNode } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";

/** "L42" → "42"; anything else (absent, malformed) → undefined. */
export function lineOf(location: string | undefined): string | undefined {
  const m = location ? /^L?(\d+)/.exec(location) : null;
  return m ? m[1] : undefined;
}

/** Definition site of a node: `file:line`, or just `file` when the line is unknown. */
export function nodeAt(n: GraphNode): string {
  const line = lineOf(n.sourceLocation);
  return line ? `${n.sourceFile}:${line}` : n.sourceFile;
}

/**
 * Where an edge happens — for a `calls` edge, the call site — as `file:line`. Falls back
 * to the definition site of `fallback` (usually the edge's source node) when the edge
 * carries no location.
 */
export function edgeAt(e: GraphEdge, fallback?: GraphNode): string {
  const line = lineOf(e.sourceLocation);
  if (line) return `${e.sourceFile}:${line}`;
  return fallback ? nodeAt(fallback) : e.sourceFile;
}

/** The class/interface a member belongs to (its incoming `method` edge), if any. */
export function ownerOf(store: GraphRepository, n: GraphNode): GraphNode | undefined {
  if (n.kind === "module") return undefined;
  for (const e of store.inEdges(n.id)) {
    if (e.relation === "method") return store.getNode(e.source);
  }
  return undefined;
}

/** The node label, qualified with its owner for members: `SQLiteMemoryRepository.search()`. */
export function displayLabel(store: GraphRepository, n: GraphNode): string {
  const owner = ownerOf(store, n);
  return owner ? `${owner.label}.${n.label}` : n.label;
}
