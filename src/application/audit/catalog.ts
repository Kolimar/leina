// application/audit/catalog.ts
// Catalog builder: scans a GraphRepository and produces an audit-ready catalog of
// nodes and edges grouped by repo (for multi-repo) or single-repo.
//
// The catalog is the foundation for all audit passes (reachability, pack, etc.).
// It is a pure read-only view — no writes to the store.

import type { GraphEdge, GraphNode } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";

export interface RepoEntry {
  repoKey: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface AuditCatalog {
  /** All repos found. For single-repo mode, one entry with repoKey="". */
  repos: RepoEntry[];
  /** Flat list of all cross-repo edges (edge.repo !== edge.source's repo). */
  crossEdges: GraphEdge[];
  /** Total node count across all repos. */
  totalNodes: number;
  /** Total edge count across all repos. */
  totalEdges: number;
}

/**
 * Build an AuditCatalog from a GraphRepository.
 * Groups nodes and edges by the `repo` field.
 * Nodes with no `repo` field are grouped under "".
 *
 * Cross-repo edges: edges where source and target belong to different repos.
 */
export function buildCatalog(store: GraphRepository): AuditCatalog {
  const allNodes = store.allNodes();
  const allEdges = store.allEdges();

  // Group nodes by repo
  const nodesByRepo = new Map<string, GraphNode[]>();
  for (const n of allNodes) {
    const key = n.repo ?? "";
    const list = nodesByRepo.get(key);
    if (list) list.push(n);
    else nodesByRepo.set(key, [n]);
  }

  // Build an id→repo lookup for edge classification
  const idToRepo = new Map<string, string>();
  for (const n of allNodes) {
    idToRepo.set(n.id, n.repo ?? "");
  }

  // Group edges by the source node's repo (edges inherit the source repo)
  const edgesByRepo = new Map<string, GraphEdge[]>();
  const crossEdges: GraphEdge[] = [];

  for (const e of allEdges) {
    const sourceRepo = idToRepo.get(e.source) ?? (e.repo ?? "");
    const targetRepo = idToRepo.get(e.target) ?? "";
    const list = edgesByRepo.get(sourceRepo);
    if (list) list.push(e);
    else edgesByRepo.set(sourceRepo, [e]);

    // Cross-repo detection
    if (sourceRepo !== "" && targetRepo !== "" && sourceRepo !== targetRepo) {
      crossEdges.push(e);
    }
  }

  // Build repo entries (all repo keys seen in nodes)
  const allRepoKeys = [...new Set([...nodesByRepo.keys(), ...edgesByRepo.keys()])];
  const repos: RepoEntry[] = allRepoKeys.map((key) => ({
    repoKey: key,
    nodes: nodesByRepo.get(key) ?? [],
    edges: edgesByRepo.get(key) ?? [],
  }));

  return {
    repos,
    crossEdges,
    totalNodes: allNodes.length,
    totalEdges: allEdges.length,
  };
}
