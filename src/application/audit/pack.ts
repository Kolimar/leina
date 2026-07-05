// application/audit/pack.ts
// Audit pack builder: serializes audit paths (source→sink with per-edge confidence)
// into a structured JSON pack suitable for LLM consumption.
//
// CRIT-6 (FR-15/NFR-05/SC-16/17):
//   - Includes source→sink paths with repos traversed and confidence per edge
//   - Supports --max-pack-kb (default 128 KB)
//   - Prunes paths by lowest confidence first when over size limit
//   - Reports prunedPaths count
//   - Writes audit-pack.json to <dir>/.leina/audit-pack.json
//
// NFR-08: DISCLAIMER is always included in the pack.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Confidence, GraphEdge, GraphNode, Relation } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import type { Finding } from "../../domain/findings/model.ts";
import type { AuditPath } from "./reachability.ts";
import { buildCatalog } from "./catalog.ts";

export type { Finding };

// ---------------------------------------------------------------------------
// Disclaimer (NFR-08)
// ---------------------------------------------------------------------------

export const AUDIT_DISCLAIMER =
  "NOTICE: This output is evidence for triage — these are CANDIDATE PATHS, " +
  "NOT confirmed vulnerabilities or exploits. " +
  "They represent potential data-flow routes that require qualified human review " +
  "before any action is taken. " +
  "leina audit does not generate exploits, payloads, or attack code.";

// ---------------------------------------------------------------------------
// AuditPack types (new format per FR-15/spec)
// ---------------------------------------------------------------------------

export interface AuditPackPathStep {
  from: string;
  to: string;
  relation: Relation;
  confidence: Confidence;
}

export interface AuditPackPath {
  source: string;
  sink: string;
  steps: AuditPackPathStep[];
  minConfidence: Confidence;
  reposTraversed: string[];
}

export interface AuditPack {
  schemaVersion: 3;
  disclaimer: string;
  builtAt: number;
  reposInvolved: string[];
  paths: AuditPackPath[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Number of paths removed due to size limit (lowest confidence pruned first). */
  prunedPaths: number;
  /** Security findings derived from audit paths (one per included path). */
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Confidence ordering for pruning (lowest confidence = first to prune)
// ---------------------------------------------------------------------------

const CONF_ORDER: Record<Confidence, number> = {
  EXTRACTED: 0,
  INFERRED: 1,
  AMBIGUOUS: 2,
  SYNTACTIC: 3,
};

/** Sort paths with their original index: highest confidence first. */
function sortByConfidenceDescIndexed(
  paths: AuditPath[],
): { path: AuditPath; origIdx: number }[] {
  return paths
    .map((path, origIdx) => ({ path, origIdx }))
    .sort((a, b) => CONF_ORDER[a.path.minConfidence] - CONF_ORDER[b.path.minConfidence]);
}

// ---------------------------------------------------------------------------
// buildAuditPack — main entry point
// ---------------------------------------------------------------------------

/** Mutable accumulator threaded through the greedy path-inclusion loop. */
interface PackAcc {
  includedPaths: AuditPackPath[];
  includedFindings: Finding[];
  includedNodeIds: Set<string>;
  includedEdgeKeys: Set<string>;
  prunedPaths: number;
}

const edgeKey = (step: AuditPackPathStep): string =>
  `${step.from}::${step.to}::${step.relation}`;

/** Record a path's node IDs and edge keys into the accumulator sets. */
function collectPathSets(p: AuditPath, acc: PackAcc): void {
  for (const step of p.steps) {
    acc.includedNodeIds.add(step.from);
    acc.includedNodeIds.add(step.to);
    acc.includedEdgeKeys.add(edgeKey(step));
  }
}

/** Project an AuditPath into the AuditPackPath shape. */
function toPackPath(p: AuditPath): AuditPackPath {
  return {
    source: p.source,
    sink: p.sink,
    steps: p.steps,
    minConfidence: p.minConfidence,
    reposTraversed: p.reposTraversed,
  };
}

/** Materialize an AuditPack from the given paths/findings and node-id selection. */
function materializePack(
  paths: AuditPackPath[],
  findings: Finding[],
  nodeIds: Set<string>,
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
  prunedPaths: number,
): AuditPack {
  const nodes = allNodes.filter((n) => nodeIds.has(n.id));
  const edges = allEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  const reposInvolved = [...new Set(nodes.filter((n) => n.repo).map((n) => n.repo!))];

  return {
    schemaVersion: 3,
    disclaimer: AUDIT_DISCLAIMER,
    builtAt: Date.now(),
    reposInvolved,
    paths,
    nodes,
    edges,
    prunedPaths,
    findings,
  };
}

/** Roll back the node IDs/edge keys added for a path that exceeded the size limit. */
function rollbackPath(p: AuditPath, acc: PackAcc): void {
  for (const step of p.steps) {
    // Only remove node IDs not used by already-included paths
    const usedBySomeIncluded = acc.includedPaths.some((ip) =>
      ip.steps.some((s) => s.from === step.from || s.to === step.from ||
                            s.from === step.to || s.to === step.to),
    );
    if (!usedBySomeIncluded) {
      acc.includedNodeIds.delete(step.from);
      acc.includedNodeIds.delete(step.to);
    }
    acc.includedEdgeKeys.delete(edgeKey(step));
  }
}

/**
 * Build an AuditPack from audit paths and the graph.
 *
 * @param paths    - source→sink paths from auditMNReachability
 * @param store    - GraphRepository (for node/edge collection)
 * @param findings - security findings derived from the same paths (deriveFindings)
 * @param maxBytes - size limit in bytes (default 128 KB)
 */
export function buildAuditPack(
  paths: AuditPath[],
  store: GraphRepository,
  findings: Finding[],
  maxBytes = 128 * 1024,
): AuditPack {
  const allNodes = store.allNodes();
  const allEdges = store.allEdges();

  // Sort: highest confidence first (fewest pruned), keeping original index for findings lookup
  const sortedWithIndex = sortByConfidenceDescIndexed(paths);

  const acc: PackAcc = {
    includedPaths: [],
    includedFindings: [],
    includedNodeIds: new Set<string>(),
    includedEdgeKeys: new Set<string>(),
    prunedPaths: 0,
  };

  // Greedily add paths until size limit is reached
  for (const { path: p, origIdx } of sortedWithIndex) {
    collectPathSets(p, acc);

    const packPath = toPackPath(p);
    const candidateFinding = findings[origIdx];

    const candidate = materializePack(
      [...acc.includedPaths, packPath],
      [...acc.includedFindings, ...(candidateFinding ? [candidateFinding] : [])],
      acc.includedNodeIds,
      allNodes,
      allEdges,
      acc.prunedPaths,
    );

    const serialized = JSON.stringify(candidate);
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
      // This path would push us over the limit — prune it (and roll back its sets)
      acc.prunedPaths++;
      rollbackPath(p, acc);
    } else {
      acc.includedPaths.push(packPath);
      if (candidateFinding) acc.includedFindings.push(candidateFinding);
    }
  }

  // Final pack from the accumulated selection
  return materializePack(
    acc.includedPaths,
    acc.includedFindings,
    acc.includedNodeIds,
    allNodes,
    allEdges,
    acc.prunedPaths,
  );
}

// ---------------------------------------------------------------------------
// writePack — write audit-pack.json to disk
// ---------------------------------------------------------------------------

/**
 * Serialize and write an AuditPack to <dir>/.leina/audit-pack.json.
 * Returns the path written.
 */
export function writeAuditPack(dir: string, pack: AuditPack): string {
  const outDir = join(dir, ".leina");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "audit-pack.json");
  writeFileSync(outPath, JSON.stringify(pack, null, 2), "utf8");
  return outPath;
}

// ---------------------------------------------------------------------------
// Legacy pack types (kept for backward compat with existing tests)
// ---------------------------------------------------------------------------

import { computeReachable } from "./reachability.ts";
import type { ReachabilityResult } from "./reachability.ts";

export interface RepoAuditReport {
  repoKey: string;
  nodeCount: number;
  edgeCount: number;
  reachability: ReachabilityResult | null;
}

/** @deprecated Use buildAuditPack instead. This is the legacy format. */
export interface LegacyAuditPack {
  catalog: ReturnType<typeof buildCatalog>;
  repos: RepoAuditReport[];
  crossEdgeCount: number;
  overallReachability: ReachabilityResult | null;
  builtAt: number;
}

/**
 * @deprecated Build a legacy pack (catalog + per-repo stats + BFS reachability).
 * Preserved for backward compat with existing tests that check overallReachability.
 * New code should use buildAuditPack() which returns paths with per-edge confidence.
 */
export function buildPack(
  store: GraphRepository,
  opts: { entryIds?: string[]; repoEntryIds?: Record<string, string[]> } = {},
): LegacyAuditPack {
  const catalog = buildCatalog(store);
  const { entryIds = [], repoEntryIds = {} } = opts;

  // Per-repo reachability
  const repos: RepoAuditReport[] = catalog.repos.map((entry) => {
    const perRepoEntries = repoEntryIds[entry.repoKey] ?? [];
    let reachability: ReachabilityResult | null = null;
    if (perRepoEntries.length > 0) {
      reachability = computeReachable(entry.nodes, entry.edges, perRepoEntries);
    }
    return {
      repoKey: entry.repoKey,
      nodeCount: entry.nodes.length,
      edgeCount: entry.edges.length,
      reachability,
    };
  });

  // Overall reachability across merged store
  const overallReachability: ReachabilityResult | null =
    entryIds.length > 0
      ? computeReachable(store.allNodes(), store.allEdges(), entryIds)
      : null;

  return {
    catalog,
    repos,
    crossEdgeCount: catalog.crossEdges.length,
    overallReachability,
    builtAt: Date.now(),
  };
}
