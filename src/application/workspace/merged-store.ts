// application/workspace/merged-store.ts
// Helper to import a per-repo GraphRepository into the merged workspace store,
// prefixing all node and edge IDs with makeNamespacedId(repoKey, ...) and
// stamping the `repo` field. The merged store is a plain GraphStore v3 (repo column
// populated). The per-repo stores are read-only in this function.

import type { GraphEdge, GraphNode } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";

/**
 * Normalize a repo key the same way makeNamespacedId does, without re-normalizing
 * already-processed node IDs. Result is the prefix used before "::".
 */
function normalizeKeyForPrefix(repoKey: string): string {
  return (
    repoKey
      .normalize("NFKC")
      .toLowerCase()
      .replaceAll(/[/\\:]+/g, "-")
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/(^-+)|(-+$)/g, "") || "project"
  );
}

/** Prefix an already-normalized node/edge ID with the repo namespace. */
function prefixId(repoKey: string, existingId: string): string {
  return `${normalizeKeyForPrefix(repoKey)}::${existingId}`;
}

/**
 * Reads all nodes and edges from `repoStore`, re-keys their IDs as
 * `<repoKey>::<originalId>` via `makeNamespacedId`, stamps `repo=repoKey`,
 * and writes them into `mergedStore`.
 *
 * Existing nodes/edges in `mergedStore` for this repoKey will be overwritten
 * (upsert-on-id semantics of GraphStore.addNodes/addEdges).
 *
 * @param repoStore   - read-only GraphRepository for a single repo (per-repo graph.db)
 * @param repoKey     - stable project key for this repo (used as the namespace prefix)
 * @param mergedStore - writable merged GraphRepository (workspace graph.db v3)
 */
export function importRepoIntoMerged(
  repoStore: GraphRepository,
  repoKey: string,
  mergedStore: GraphRepository,
): void {
  const allNodes = repoStore.allNodes();
  const allEdges = repoStore.allEdges();

  // Build a mapping from original id → namespaced id for edge source/target rewriting.
  // Use prefixId (not makeNamespacedId) because node IDs are already normalized —
  // re-running makeId would turn "src_auth_ts:buildtoken" → "src_auth_ts_buildtoken".
  const idMap = new Map<string, string>();
  for (const n of allNodes) {
    idMap.set(n.id, prefixId(repoKey, n.id));
  }

  const nsNodes: GraphNode[] = allNodes.map((n) => ({
    ...n,
    id: idMap.get(n.id)!,
    repo: repoKey,
  }));

  const nsEdges: GraphEdge[] = allEdges.map((e) => ({
    ...e,
    source: idMap.get(e.source) ?? prefixId(repoKey, e.source),
    target: idMap.get(e.target) ?? prefixId(repoKey, e.target),
    repo: repoKey,
  }));

  mergedStore.addNodes(nsNodes);
  mergedStore.addEdges(nsEdges);
}
