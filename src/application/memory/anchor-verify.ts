// Anchor resolution + drift verification wiring, factored out of server.ts so the live
// (graph-backed, filesystem-hashing) paths are unit-testable without spawning the server.
// Both factories close over the SAME raw synchronous graph reader the server uses inside
// memory's sync transaction — never the async freshness gate.
//
// Anchor fingerprints (the `anchor_hash` column) come in two forms:
//   - `sym1:<sha256>` — the anchored SYMBOL's own source lines (domain/memory/symbol-span.ts),
//     so an edit elsewhere in the file is not drift. Used whenever the node has a start line
//     in a language with a span rule.
//   - `<sha256>` — the whole file: module/config nodes, other languages, and every anchor
//     saved before 3.0 (`leina memory reanchor` upgrades those — see makeUpgradeAnchor).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { normalizeLabel } from "../../domain/shared/id.ts";
import type { GraphNode } from "../../domain/graph/model.ts";
import {
  SYMBOL_FINGERPRINT_PREFIX,
  isFileLevelHash,
  locateSymbolSpan,
  parseLineHint,
  spanText,
} from "../../domain/memory/symbol-span.ts";
import type { GraphStore } from "../../infrastructure/sqlite/graph-store.ts";
import { readManifest } from "../graph/manifest.ts";
import type { AnchorResolver } from "../../infrastructure/sqlite/memory-repository.ts";
import type { NodeVerifier } from "./query.ts";

interface AnchorDeps {
  getStore: () => GraphStore;
  root: string;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function readBytes(abs: string): Buffer | null {
  try {
    return readFileSync(abs);
  } catch {
    return null;
  }
}

// sha256 of a file's current content, or null if it can't be read (missing/unreadable).
export function sha256File(abs: string): string | null {
  const bytes = readBytes(abs);
  return bytes === null ? null : sha256(bytes);
}

type SpanNode = Pick<GraphNode, "label" | "sourceFile" | "sourceLocation">;

/**
 * `sym1:` fingerprint of `node`'s declaration in `content`, or null when the node has no
 * start line (module/config nodes), its language has no span rule, or its name is not in
 * the text. Deterministic: same content + node → same fingerprint.
 */
export function symbolFingerprint(content: string, node: SpanNode): string | null {
  const hint = parseLineHint(node.sourceLocation);
  if (hint === undefined) return null;
  const span = locateSymbolSpan(content, node.sourceFile, node.label, hint);
  return span === null ? null : `${SYMBOL_FINGERPRINT_PREFIX}${sha256(spanText(content, span))}`;
}

// Maps a symbol label to the real graph node IDs it names so `memory save` anchors point at
// actual nodes, not raw labels. Filters to functional-exact matches to avoid anchoring on
// fuzzy substring hits, and stamps each anchor with its save-time drift baseline: the
// symbol fingerprint of the working tree when the node has a span, else the file's
// working-tree hash, else the build hash from the manifest (file unreadable). The working
// tree, not the manifest, because that is what the verifier compares against — a file
// edited since the last build must not read as drifted the moment the note is saved.
// Any error (no graph yet) → no matches.
export function makeResolveAnchor(deps: AnchorDeps): AnchorResolver {
  const { getStore, root } = deps;
  return (label) => {
    try {
      const s = getStore();
      const nq = normalizeLabel(label);
      const files = new Map<string, Buffer | null>();
      let manifest: ReturnType<typeof readManifest> | undefined;
      const baseline = (n: GraphNode): string | undefined => {
        if (!files.has(n.sourceFile)) files.set(n.sourceFile, readBytes(join(root, n.sourceFile)));
        const bytes = files.get(n.sourceFile) ?? null;
        if (bytes !== null) return symbolFingerprint(bytes.toString("utf8"), n) ?? sha256(bytes);
        // The manifest keys files by the same relPOSIX path the graph stores as sourceFile.
        manifest ??= readManifest(root);
        return manifest?.files[n.sourceFile]?.hash;
      };
      return s
        .findByLabel(label)
        .filter((n) => normalizeLabel(n.label) === nq)
        .map((n) => {
          const anchorHash = baseline(n);
          return anchorHash === undefined
            ? { nodeId: n.id, sourceFile: n.sourceFile }
            : { nodeId: n.id, sourceFile: n.sourceFile, anchorHash };
        });
    } catch {
      return [];
    }
  };
}

// Verifies a memory anchor against the live graph: does the node still exist, what is its
// source file's CURRENT working-tree hash, and what is the node's current symbol
// fingerprint? Both come from disk (not the manifest) so drift is caught between builds
// too. When the graph can't be read at all, surfaces `error` (→ unverified with the cause)
// instead of guessing existence — see NodeVerifier.
export function makeVerifyNode(deps: AnchorDeps): NodeVerifier {
  const { getStore, root } = deps;
  return (nodeId) => {
    try {
      const node = getStore().getNode(nodeId);
      if (!node) return { exists: false, currentHash: null };
      const bytes = readBytes(join(root, node.sourceFile));
      if (bytes === null) return { exists: true, currentHash: null, symbolHash: null };
      return {
        exists: true,
        currentHash: sha256(bytes),
        symbolHash: symbolFingerprint(bytes.toString("utf8"), node),
      };
    } catch (e) {
      return { exists: false, currentHash: null, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

/**
 * Committed content of `relPath` (relative to the project root) whose sha256 is `sha256`,
 * searched through the file's history — or null. Injected (infrastructure: git) so this
 * module stays free of process spawning.
 */
export type FileHistory = (relPath: string, sha256: string) => string | null;

/** A file-level anchor to upgrade: its node and the whole-file hash it was saved with. */
export interface UpgradableAnchor {
  nodeId: string;
  anchorHash?: string;
}

/**
 * Lossless upgrade of a file-level anchor to a symbol fingerprint: returns the `sym1:`
 * fingerprint the symbol had IN THE FILE VERSION THE ANCHOR WAS SAVED AGAINST, or null.
 */
export type AnchorUpgrader = (anchor: UpgradableAnchor) => string | null;

// The saved whole-file hash identifies one exact version of the file. When the working tree
// still has it, the symbol's current lines ARE its save-time lines; otherwise the version is
// looked up in history (`history`). Fingerprinting the symbol in THAT version keeps the
// anchor's baseline where it was: the upgraded anchor reads active only if the symbol itself
// is unchanged since the note was saved, and stale if it changed — never refreshed to "now".
// Null (no upgrade) when the anchor is not file-level, the node is gone or has no span, or
// the saved version cannot be found.
export function makeUpgradeAnchor(deps: AnchorDeps & { history?: FileHistory }): AnchorUpgrader {
  const { getStore, root, history } = deps;
  return (anchor) => {
    const saved = anchor.anchorHash;
    if (saved === undefined || !isFileLevelHash(saved)) return null;
    try {
      const node = getStore().getNode(anchor.nodeId);
      if (!node || parseLineHint(node.sourceLocation) === undefined) return null;
      const bytes = readBytes(join(root, node.sourceFile));
      const text =
        bytes !== null && sha256(bytes) === saved ? bytes.toString("utf8") : (history?.(node.sourceFile, saved) ?? null);
      return text === null ? null : symbolFingerprint(text, node);
    } catch {
      return null;
    }
  };
}
