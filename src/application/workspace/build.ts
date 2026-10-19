// application/workspace/build.ts
// Workspace build orchestrator: for each member repo, check freshness and
// rebuild if stale; then import into the merged store.
// After all repos are imported, run linkCrossRepo to add cross-repo edges.
//
// Design (D3): Each member keeps its own per-repo graph.db (built/reused via isStale).
// The workspace owns a single merged graph.db (schema v3) at <wsRoot>/.leina/.
// importRepoIntoMerged handles ID namespacing and `repo` field population.
// linkCrossRepo is invoked after import (CRIT-1 fix — was never called before).
//
// This module does NOT modify any single-repo code paths (NFR-01/02).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isStale } from "../graph/manifest.ts";
import { importRepoIntoMerged } from "./merged-store.ts";
import { linkCrossRepo } from "./cross-repo-linker.ts";
import type { WorkspaceMember } from "../project/detect-key.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import type { GraphExtractor } from "../../domain/graph/extractor.ts";

export interface WorkspaceBuildReport {
  /** Total member repos processed. */
  membersTotal: number;
  /** Repos that were already fresh and reused. */
  membersReused: number;
  /** Repos that were stale and rebuilt. */
  membersRebuilt: number;
  /** Cross-repo edges created by linkCrossRepo. */
  crossEdges: number;
  /** Any repos that failed to build (error stored by repoKey). */
  errors: Record<string, string>;
}

/**
 * Build or reuse each member repo's graph, then import them all into `mergedStore`.
 * After all repos are imported, linkCrossRepo is called to create cross-repo edges.
 * `mergedStore` is cleared before importing (full rebuild of workspace graph).
 *
 * @param wsRoot      - workspace root directory (used for advisory messaging only)
 * @param members     - list of member repos with dir + repoKey
 * @param mergedStore - the workspace merged GraphRepository (v3, writable)
 * @param opts.buildMember - rebuilds one stale member and resolves true if it did build (false:
 *   it found the member fresh after all, e.g. another process rebuilt it meanwhile). The
 *   composition root passes one that holds the member's cross-process build lock; the default
 *   builds into the member's graph.db directly.
 */
export async function buildWorkspace(
  wsRoot: string,
  members: WorkspaceMember[],
  mergedStore: GraphRepository,
  registry: GraphExtractor[],
  opts: { buildMember?: (dir: string) => Promise<boolean> } = {},
): Promise<WorkspaceBuildReport> {
  const buildMember = opts.buildMember ?? ((dir: string) => buildMemberDirect(dir, registry));
  const report: WorkspaceBuildReport = {
    membersTotal: members.length,
    membersReused: 0,
    membersRebuilt: 0,
    crossEdges: 0,
    errors: {},
  };

  // Clear the merged store — full re-import on every workspace build.
  mergedStore.clear();

  for (const member of members) {
    try {
      const staleResult = isStale(member.dir);

      if (staleResult.stale && (await buildMember(member.dir))) {
        report.membersRebuilt++;
      } else {
        report.membersReused++;
      }

      // Import the (now up-to-date) per-repo graph into the merged store.
      const { GraphStore } = await import("../../infrastructure/sqlite/graph-store.ts");
      const repoDbPath = join(member.dir, ".leina", "graph.db");
      const repoStore = new GraphStore(repoDbPath);
      try {
        importRepoIntoMerged(repoStore, member.repoKey, mergedStore);
      } finally {
        repoStore.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors[member.repoKey] = msg;
      process.stderr.write(
        `leina workspace: error building ${member.repoKey} (${member.dir}): ${msg}\n`,
      );
    }
  }

  // --- CRIT-1 fix: invoke cross-repo linker after all repos are imported ---
  // linkCrossRepo scans both the merged store's import edges AND member source files
  // directly, so it works regardless of whether ts-morph or tree-sitter was used.
  try {
    const crossEdges = linkCrossRepo(mergedStore, members);
    if (crossEdges.length > 0) {
      mergedStore.addEdges(crossEdges);
    }
    report.crossEdges = crossEdges.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`leina workspace: linkCrossRepo error: ${msg}\n`);
  }

  return report;
}

/** Default member builder: build straight into the member's own graph.db (no lock). */
async function buildMemberDirect(dir: string, registry: GraphExtractor[]): Promise<boolean> {
  // Lazy-import buildGraph so the common (fresh) path never loads the extractor stack.
  const { buildGraph } = await import("../graph/build.ts");
  const { GraphStore } = await import("../../infrastructure/sqlite/graph-store.ts");
  mkdirSync(join(dir, ".leina"), { recursive: true });
  const repoStore = new GraphStore(join(dir, ".leina", "graph.db"));
  try {
    await buildGraph(dir, repoStore, registry);
  } finally {
    repoStore.close();
  }
  return true;
}
