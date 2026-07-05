// Anchor resolution + drift verification wiring, factored out of server.ts so the live
// (graph-backed, filesystem-hashing) paths are unit-testable without spawning the server.
// Both factories close over the SAME raw synchronous graph reader the server uses inside
// memory's sync transaction — never the async freshness gate.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { normalizeLabel } from "../../domain/shared/id.ts";
import type { GraphStore } from "../../infrastructure/sqlite/graph-store.ts";
import { readManifest } from "../graph/manifest.ts";
import type { AnchorResolver } from "../../infrastructure/sqlite/memory-repository.ts";
import type { NodeVerifier } from "./query.ts";

interface AnchorDeps {
  getStore: () => GraphStore;
  root: string;
}

// sha256 of a file's current content, or null if it can't be read (missing/unreadable).
export function sha256File(abs: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

// Maps a symbol label to the real graph node IDs it names so `memory save` anchors point at
// actual nodes, not raw labels. Filters to functional-exact matches to avoid anchoring on
// fuzzy substring hits, and stamps each anchor with the file's current build hash from the
// manifest (the save-time drift baseline). Any error (no graph yet) → no matches.
export function makeResolveAnchor(deps: AnchorDeps): AnchorResolver {
  const { getStore, root } = deps;
  return (label) => {
    try {
      const s = getStore();
      const nq = normalizeLabel(label);
      // The manifest keys files by the same relPOSIX path the graph stores as sourceFile.
      const manifest = readManifest(root);
      return s
        .findByLabel(label)
        .filter((n) => normalizeLabel(n.label) === nq)
        .map((n) => {
          const fileHash = manifest?.files[n.sourceFile]?.hash;
          return fileHash === undefined
            ? { nodeId: n.id, sourceFile: n.sourceFile }
            : { nodeId: n.id, sourceFile: n.sourceFile, fileHash };
        });
    } catch {
      return [];
    }
  };
}

// Verifies a memory anchor against the live graph: does the node still exist, and what is
// its source file's CURRENT working-tree hash? The hash comes from disk (not the manifest)
// so drift is caught between builds too. When the graph can't be read at all, surfaces
// `error` (→ unverified with the cause) instead of guessing existence — see NodeVerifier.
export function makeVerifyNode(deps: AnchorDeps): NodeVerifier {
  const { getStore, root } = deps;
  return (nodeId) => {
    try {
      const node = getStore().getNode(nodeId);
      if (!node) return { exists: false, currentHash: null };
      return { exists: true, currentHash: sha256File(join(root, node.sourceFile)) };
    } catch (e) {
      return { exists: false, currentHash: null, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
