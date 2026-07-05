// application/workspace/manifest.ts
// Workspace-level staleness check (sister function to the per-repo isStale).
// A workspace is stale if ANY of its member repos is stale.
// The single-repo `isStale` is NOT modified (NFR-02).

import { isStale } from "../graph/manifest.ts";
import type { WorkspaceMember } from "../project/detect-key.ts";

/**
 * Returns true when at least one member repo is stale (needs rebuild).
 * Calls the existing per-repo `isStale(memberDir)` for each member.
 * Empty members list → returns false (nothing to check).
 */
export function isStaleWorkspace(members: WorkspaceMember[]): boolean {
  for (const member of members) {
    if (isStale(member.dir).stale) return true;
  }
  return false;
}
