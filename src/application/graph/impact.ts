// impact.ts — Bidirectional BFS blast-radius across code + infra nodes.
//
// `analyzeImpact` traverses the graph from a seed node in BOTH directions
// (forward outEdges + backward inEdges) using IMPACT_RELATIONS (which includes
// both code relations like `calls`/`imports` and infra relations like
// `deploys`/`reads`/`configures`/`exposes`).
//
// The result categorizes reached nodes into files/tests/services/configs.

import type { GraphNode } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import { IMPACT_RELATIONS } from "./query.ts";

export interface ImpactResult {
  impacted: {
    /** Unique sourceFile paths of all reached nodes (including the seed). */
    files: string[];
    /** Subset of files whose path matches a test/spec pattern. */
    tests: string[];
    /** IDs of reached nodes with kind === "service". */
    services: string[];
    /** IDs of reached nodes with fileType === "config" OR kind === "config". */
    configs: string[];
  };
}

const TEST_PATH_RE = /\.(test|spec)\.|\/test\/|\/tests\/|\/__tests__\//;

/**
 * Expand one BFS frontier node: collect impact-relevant neighbours not yet seen,
 * recording each discovered node into `reached`/`seen` and returning the new ids.
 */
function expandNode(
  store: GraphRepository,
  id: string,
  seen: Set<string>,
  reached: Map<string, GraphNode>,
): string[] {
  const discovered: string[] = [];
  // Both directions: outgoing edges + incoming edges
  const edges = [...store.outEdges(id), ...store.inEdges(id)];
  for (const e of edges) {
    if (!IMPACT_RELATIONS.has(e.relation)) continue;
    const other = e.source === id ? e.target : e.source;
    if (seen.has(other)) continue;
    seen.add(other);
    const node = store.getNode(other);
    if (!node) continue;
    reached.set(other, node);
    discovered.push(other);
  }
  return discovered;
}

/**
 * Bidirectional BFS over `IMPACT_RELATIONS` from `seedNode`, up to `depth` hops.
 * Returns the reached nodes (including the seed) keyed by id.
 */
function bfsReached(
  store: GraphRepository,
  seedId: string,
  seedNode: GraphNode,
  depth: number,
): Map<string, GraphNode> {
  const seen = new Set<string>([seedId]);
  // Include seed itself in the reached set for categorization
  const reached = new Map<string, GraphNode>([[seedId, seedNode]]);
  let frontier: string[] = [seedId];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      next.push(...expandNode(store, id, seen, reached));
    }
    frontier = next;
  }
  return reached;
}

/** Categorize reached nodes into the ImpactResult shape. */
function categorize(reached: Map<string, GraphNode>): ImpactResult {
  const filesSet = new Set<string>();
  const services: string[] = [];
  const configs: string[] = [];

  for (const [id, node] of reached) {
    if (node.sourceFile) filesSet.add(node.sourceFile);
    if (node.kind === "service") services.push(id);
    if (node.fileType === "config" || node.kind === "config") configs.push(id);
  }

  const files = [...filesSet];
  const tests = files.filter((f) => TEST_PATH_RE.test(f));

  return { impacted: { files, tests, services, configs } };
}

/**
 * Bidirectional BFS over `IMPACT_RELATIONS` starting from `seedId`.
 * Returns categorized impact: files, tests, services, configs.
 *
 * - `seedId` not found in store → all lists empty.
 * - `depth` controls BFS depth (default 3).
 */
export function analyzeImpact(
  store: GraphRepository,
  seedId: string,
  depth = 3,
): ImpactResult {
  const seedNode = store.getNode(seedId);
  if (!seedNode) {
    return { impacted: { files: [], tests: [], services: [], configs: [] } };
  }

  const reached = bfsReached(store, seedId, seedNode, depth);
  return categorize(reached);
}
