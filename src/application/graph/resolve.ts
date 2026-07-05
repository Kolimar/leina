// Symbol resolution. Turns raw calls into edges and re-targets heritage edges
// to real nodes. A two-pass approach with an explicit confidence ladder so the
// AI knows what was proven vs guessed:
//
//   same-file unique match   -> EXTRACTED  (local, high confidence)
//   cross-file unique match  -> INFERRED   (heuristic by unique name)
//   multiple candidates      -> AMBIGUOUS  (guessed first; flagged, not dropped)
//
// Ambiguous calls are kept tagged AMBIGUOUS (not dropped) so the signal isn't
// lost; the semantic sidecar (Roslyn/JDT) upgrades these to EXTRACTED for C#/Java.

import { normalizeLabel } from "../../domain/shared/id.ts";
import type {
  Confidence,
  GraphEdge,
  GraphNode,
  ImportBinding,
  RawCall,
  Relation,
} from "../../domain/graph/model.ts";

const HERITAGE: ReadonlySet<Relation> = new Set<Relation>([
  "extends",
  "implements",
  "inherits",
]);

const DEFINABLE = new Set(["function", "method", "class", "interface"]);

interface LabelIndex {
  // normalized label -> node ids that can be call/reference targets
  byLabel: Map<string, string[]>;
  byId: Map<string, GraphNode>;
}

function buildIndex(nodes: GraphNode[]): LabelIndex {
  const byLabel = new Map<string, string[]>();
  const byId = new Map<string, GraphNode>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (!n.kind || !DEFINABLE.has(n.kind)) continue;
    const key = normalizeLabel(n.label);
    const list = byLabel.get(key);
    if (list) list.push(n.id);
    else byLabel.set(key, [n.id]);
  }
  return { byLabel, byId };
}

// Above this many candidates, the name is too common (e.g. get/toString/Add in
// Java/C#) to guess meaningfully. Inventing an edge to an arbitrary candidate
// is worse than none — it corrupts blast radius — so we drop it. Compiler-grade
// resolution (the semantic sidecar) is what disambiguates these.
const MAX_AMBIGUOUS_CANDIDATES = 4;

// Does an import module path point at this candidate's file?
// `./auth` or `auth.tokens` -> file ".../auth.ts" / ".../tokens.py".
function moduleMatchesFile(module: string, file: string | undefined): boolean {
  if (!file) return false;
  const modSeg = module.split(/[./\\]/).findLast(Boolean)?.toLowerCase();
  const base = file.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "").toLowerCase();
  return !!modSeg && modSeg === base;
}

interface PickResult { target: string; confidence: Confidence }

// Scope filter: when provided, restrict candidates to nodes in the scope file set.
// This is the per-repo scoped pass (D4) — prevents cross-repo false positives.
// Only apply the filter if it yields at least one candidate; if no candidate is in
// scope (e.g. stdlib call), fall back to the unscoped list.
function applyScopeFilter(
  candidates: string[],
  byId: Map<string, GraphNode>,
  scopeFiles?: Set<string>,
): string[] {
  if (!scopeFiles || scopeFiles.size === 0) return candidates;
  const inScope = candidates.filter((c) => {
    const sf = byId.get(c)?.sourceFile;
    return sf !== undefined && scopeFiles.has(sf);
  });
  return inScope.length > 0 ? inScope : candidates;
}

// Resolve when there is at least one same-file candidate: unique -> EXTRACTED,
// multiple -> AMBIGUOUS (first) unless too common to guess (then drop -> null).
function pickSameFile(sameFile: string[]): PickResult | null {
  if (sameFile.length === 1) return { target: sameFile[0]!, confidence: "EXTRACTED" };
  return sameFile.length <= MAX_AMBIGUOUS_CANDIDATES
    ? { target: sameFile[0]!, confidence: "AMBIGUOUS" }
    : null;
}

// Import-guided: the callee is an imported name, so the import statement
// proves this is a legitimate cross-module call.
function pickImported(
  filtered: string[],
  importedModule: string,
  byId: Map<string, GraphNode>,
): PickResult | null {
  if (filtered.length === 1) {
    return { target: filtered[0]!, confidence: "EXTRACTED" };
  }
  // multiple candidates: the module path tells us which file
  const matched = filtered.filter((c) =>
    moduleMatchesFile(importedModule, byId.get(c)?.sourceFile),
  );
  if (matched.length === 1) {
    return { target: matched[0]!, confidence: "EXTRACTED" };
  }
  return null;
}

// Final fallback by unique name: unique -> INFERRED, multiple -> AMBIGUOUS (first)
// unless too common to guess (then drop -> null).
function pickByName(filtered: string[]): PickResult | null {
  if (filtered.length === 1) {
    return { target: filtered[0]!, confidence: "INFERRED" };
  }
  return filtered.length <= MAX_AMBIGUOUS_CANDIDATES
    ? { target: filtered[0]!, confidence: "AMBIGUOUS" }
    : null;
}

function pick(
  candidates: string[],
  rawCall: RawCall,
  byId: Map<string, GraphNode>,
  importedModule: string | undefined,
  scopeFiles?: Set<string>,
): PickResult | null {
  if (candidates.length === 0) return null;
  // exclude self-recursion noise (caller == callee node)
  const filtered = applyScopeFilter(
    candidates.filter((c) => c !== rawCall.fromId),
    byId,
    scopeFiles,
  );
  if (filtered.length === 0) return null;

  const sameFile = filtered.filter(
    (c) => byId.get(c)?.sourceFile === rawCall.sourceFile,
  );
  if (sameFile.length > 0) return pickSameFile(sameFile);

  if (importedModule !== undefined) {
    const imported = pickImported(filtered, importedModule, byId);
    if (imported) return imported;
  }

  return pickByName(filtered);
}

// import index: sourceFile -> (localName -> module)
function buildImportsByFile(imports: ImportBinding[]): Map<string, Map<string, string>> {
  const importsByFile = new Map<string, Map<string, string>>();
  for (const b of imports) {
    let m = importsByFile.get(b.sourceFile);
    if (!m) {
      m = new Map();
      importsByFile.set(b.sourceFile, m);
    }
    m.set(b.localName, b.module);
  }
  return importsByFile;
}

// method id -> normalized label of its owning class (for receiver-type
// disambiguation). Built from `method` edges (classId --method--> methodId).
function buildMethodOwner(edges: GraphEdge[], idx: LabelIndex): Map<string, string> {
  const methodOwner = new Map<string, string>();
  for (const e of edges) {
    if (e.relation === "method") {
      const ownerLabel = idx.byId.get(e.source)?.label;
      if (ownerLabel) methodOwner.set(e.target, normalizeLabel(ownerLabel));
    }
  }
  return methodOwner;
}

function isTypeNode(idx: LabelIndex, id: string): boolean {
  const k = idx.byId.get(id)?.kind;
  return k === "class" || k === "interface";
}

// 1. Re-target heritage edges (placeholder by-label id -> real node id).
// Heritage targets are always TYPES, so ignore method/constructor homonyms —
// in Java/C# a constructor shares its class's name and would otherwise make
// every `extends Foo` look ambiguous.
function retargetHeritageEdges(edges: GraphEdge[], idx: LabelIndex, out: GraphEdge[]): void {
  for (const e of edges) {
    if (HERITAGE.has(e.relation) && !idx.byId.has(e.target)) {
      const all = idx.byLabel.get(normalizeLabel(targetLabelOf(e.target)));
      const cands = all?.filter((id) => isTypeNode(idx, id)) ?? [];
      if (cands.length >= 1) {
        out.push({ ...e, target: cands[0]!, confidence: cands.length === 1 ? "EXTRACTED" : "AMBIGUOUS" });
      } else {
        out.push(e); // external/unknown base — keep as-is
      }
    } else {
      out.push(e);
    }
  }
}

function buildCallEdge(rc: RawCall, target: string, confidence: Confidence, idx: LabelIndex): GraphEdge {
  const targetKind = idx.byId.get(target)?.kind;
  const relation: Relation =
    targetKind === "class" || targetKind === "interface" ? "references" : "calls";
  return {
    source: rc.fromId,
    target,
    relation,
    confidence,
    sourceFile: rc.sourceFile,
    sourceLocation: rc.sourceLocation,
    weight: 1,
  };
}

// 2. Resolve a single raw call to an edge (or null if it can't be resolved).
function resolveRawCall(
  rc: RawCall,
  idx: LabelIndex,
  importsByFile: Map<string, Map<string, string>>,
  methodOwner: Map<string, string>,
  scopeFiles?: Set<string>,
): GraphEdge | null {
  const cands = idx.byLabel.get(normalizeLabel(rc.callee));
  if (!cands) return null;

  // Receiver-type wins: if we know `x` is a TokenFactory, resolve `x.m()` to
  // TokenFactory's method directly — no guessing.
  if (rc.receiverType) {
    const want = normalizeLabel(rc.receiverType);
    const byOwner = cands.filter((c) => c !== rc.fromId && methodOwner.get(c) === want);
    if (byOwner.length >= 1) return buildCallEdge(rc, byOwner[0]!, "EXTRACTED", idx);
  }

  const importedModule = importsByFile.get(rc.sourceFile)?.get(rc.callee);
  const hit = pick(cands, rc, idx.byId, importedModule, scopeFiles);
  return hit ? buildCallEdge(rc, hit.target, hit.confidence, idx) : null;
}

export function resolve(
  nodes: GraphNode[],
  edges: GraphEdge[],
  rawCalls: RawCall[],
  imports: ImportBinding[] = [],
  scopeFiles?: Set<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const idx = buildIndex(nodes);
  const importsByFile = buildImportsByFile(imports);
  const methodOwner = buildMethodOwner(edges, idx);

  const out: GraphEdge[] = [];
  retargetHeritageEdges(edges, idx, out);

  for (const rc of rawCalls) {
    const edge = resolveRawCall(rc, idx, importsByFile, methodOwner, scopeFiles);
    if (edge) out.push(edge);
  }

  return { nodes, edges: out };
}

// The placeholder id for heritage is makeId(name); recover an approximate label
// by replacing separators. Since makeId already normalized, we match on it.
function targetLabelOf(placeholderId: string): string {
  return placeholderId.replaceAll("_", " ");
}
