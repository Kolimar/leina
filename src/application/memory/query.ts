// Memory query helpers — pure functions over MemoryRepository.
// Stable seam for Phase 2 (graph-aware anchor resolution).

import type { MemoryRepository } from "../../domain/memory/ports.ts";
import type { ObservationStatus, ObservationType, Scope, SearchHit } from "../../domain/memory/model.ts";
import { isSymbolFingerprint } from "../../domain/memory/symbol-span.ts";

interface SearchOpts {
  scope?: Scope;
  type?: ObservationType;
  limit?: number;
}

// Delegates to store.search — stable public signature for Phase 2.
export function searchMemory(
  store: MemoryRepository,
  terms: string,
  opts?: SearchOpts,
): SearchHit[] {
  return store.search(terms, opts);
}

interface AnchorRef {
  observationId: string;
  role: string;
  anchorLabel?: string;
  anchorFile?: string;
}

// Returns memory anchors for a given node_id. Phase-2 seam for graph-aware resolution.
export function anchorsFor(store: MemoryRepository, nodeId: string): AnchorRef[] {
  return store.anchorsForNode(nodeId);
}

// ---------------------------------------------------------------------------
// latestMemoriesForNode — "recent memories" panel for a single graph node.
// Composes recentAnchoredObservations() (ordering/limit) with anchorsForObservation()
// + deriveMemoryState()/verdictOf() (drift badge) so callers get ready-to-render items
// instead of raw rows. Same shape of composition as getVerifiedContext() below, but
// keyed by node instead of by search query.
// ---------------------------------------------------------------------------

export interface NodeMemory {
  observationId: string;
  title: string;
  content: string;
  updatedAt: number;
  role: string;
  anchorLabel?: string;
  /** Lifecycle status, reported next to (never folded into) the drift `state`. */
  status: ObservationStatus;
  nature: Nature;
  state: MemoryState;
  reason: string;
  verdict: Verdict;
}

export function latestMemoriesForNode(
  store: MemoryRepository,
  nodeId: string,
  verify: NodeVerifier,
  limit = 10,
): NodeMemory[] {
  const recent = store.recentAnchoredObservations(nodeId, limit);
  const items: NodeMemory[] = [];
  for (const r of recent) {
    const obs = store.get(r.observationId);
    // Defensive: the anchor row survives even if the observation it points at is gone
    // (e.g. hard-deleted out of band) — skip rather than surface a broken entry.
    if (!obs) continue;
    const anchors = store.anchorsForObservation(r.observationId);
    const { state, reason } = deriveMemoryState(anchors, verify);
    const nature = natureOf(obs.type);
    const { verdict } = verdictOf(state, nature, obs.status);
    const item: NodeMemory = {
      observationId: r.observationId,
      title: obs.title,
      content: obs.content,
      updatedAt: r.updatedAt,
      role: r.role,
      status: obs.status,
      nature,
      state,
      reason,
      verdict,
    };
    if (r.anchorLabel !== undefined) item.anchorLabel = r.anchorLabel;
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Drift detection — a memory is a verifiable hypothesis against the graph.
// State and nature are DERIVED at read time (never persisted): they depend on the
// current graph, so storing them would itself go stale.
// ---------------------------------------------------------------------------

// Discrete 4-state lattice (no float confidence). Severity order for aggregation:
// contradicted > stale > unverified > active.
export type MemoryState = "active" | "stale" | "contradicted" | "unverified";

// Descriptive memories state a fact about the code and auto-invalidate on drift.
// Normative memories state a rule and are checked as a violation on drift, never discarded.
export type Nature = "descriptive" | "normative";

export type Verdict = "usable" | "warning" | "do_not_use";

// Looks up a node's current existence, source-file hash and symbol fingerprint in the
// graph. Injected so the memory layer verifies anchors without importing GraphStore
// (memory.db / graph.db stay decoupled — joined here in app code, no FK).
// `error` set means the graph itself could not be read (missing/corrupt) — distinct
// from a definitive exists:false (node gone) or currentHash:null (file unreadable / no
// baseline hash). It lets the caller tell "verification is down" apart from real drift.
// `symbolHash` is the node's current `sym1:` fingerprint (application/memory/anchor-verify
// .ts), null when its span cannot be located in the current file, and absent when the
// verifier does not compute fingerprints (a symbol-level anchor then reads unverified).
export type NodeVerifier = (
  nodeId: string,
) => { exists: boolean; currentHash: string | null; symbolHash?: string | null; error?: string };

interface AnchorForDrift {
  nodeId: string;
  anchorLabel?: string;
  anchorFile?: string;
  anchorHash?: string;
}

interface StateReason {
  state: MemoryState;
  reason: string;
  // Carries the graph-read failure cause up to the caller when the verifier reported one.
  graphError?: string;
}

const NORMATIVE_TYPES = new Set<ObservationType>(["decision", "preference"]);

export function natureOf(type: ObservationType): Nature {
  return NORMATIVE_TYPES.has(type) ? "normative" : "descriptive";
}

// One anchor's drift state. anchorFile === undefined means it never resolved to a
// real graph node → unverified (NOT contradicted: there was nothing to contradict).
// A `sym1:` anchor compares the symbol's own lines, so only an edit to the anchored symbol
// is drift; a bare-hash anchor (module-level, or saved before 3.0) compares the whole file.
export function deriveAnchorState(a: AnchorForDrift, verify: NodeVerifier): StateReason {
  const who = a.anchorLabel ?? a.nodeId;
  if (a.anchorFile === undefined) {
    return { state: "unverified", reason: `anchor '${who}' was never resolved to a graph node` };
  }
  const v = verify(a.nodeId);
  if (v.error !== undefined) {
    // The graph couldn't be read at all — we can't claim the node exists OR is gone, so
    // report "can't verify" with the cause, never a false `contradicted`. Distinct reason
    // from the no-hash case below so a caller can tell graph-down from missing-baseline.
    return {
      state: "unverified",
      reason: `graph unavailable, cannot verify '${who}': ${v.error}`,
      graphError: v.error,
    };
  }
  if (!v.exists) {
    return { state: "contradicted", reason: `node '${who}' no longer exists in the graph` };
  }
  if (a.anchorHash === undefined || v.currentHash === null) {
    return { state: "unverified", reason: `no hash available to compare for '${a.anchorFile}'` };
  }
  if (isSymbolFingerprint(a.anchorHash)) return symbolAnchorState(a.anchorHash, who, a.anchorFile, v.symbolHash);
  if (v.currentHash !== a.anchorHash) {
    return { state: "stale", reason: `'${a.anchorFile}' changed since this memory was saved (file-level anchor)` };
  }
  return { state: "active", reason: `verified against '${a.anchorFile}' (file-level anchor)` };
}

function symbolAnchorState(
  saved: string,
  who: string,
  file: string,
  current: string | null | undefined,
): StateReason {
  if (current === undefined) {
    return { state: "unverified", reason: `no symbol fingerprint available to compare for '${who}'` };
  }
  if (current === null) {
    return { state: "stale", reason: `'${who}' can no longer be located in '${file}'` };
  }
  if (current !== saved) {
    return { state: "stale", reason: `'${who}' changed in '${file}' since this memory was saved` };
  }
  return { state: "active", reason: `verified '${who}' in '${file}'` };
}

const SEVERITY: Record<MemoryState, number> = {
  active: 0,
  unverified: 1,
  stale: 2,
  contradicted: 3,
};

const isSymbolAnchor = (a: AnchorForDrift): boolean =>
  a.anchorHash !== undefined && isSymbolFingerprint(a.anchorHash);

// A whole-file anchor is coarser than a symbol anchor into the same file. When a memory pins
// symbols of a file (`checkHooks` in `src/cli/doctor.ts`), an edit elsewhere in that file is
// not drift for it: the whole-file anchors into that file do not count as STALE (they would
// flag every unrelated edit and drown the symbol-level signal). A node that is gone still
// counts — that is not a coarse signal.
function subsumedFileAnchors(anchors: AnchorForDrift[]): Set<AnchorForDrift> {
  const symbolFiles = new Set(anchors.filter(isSymbolAnchor).map((a) => a.anchorFile));
  return new Set(
    anchors.filter((a) => a.anchorHash !== undefined && !isSymbolAnchor(a) && symbolFiles.has(a.anchorFile)),
  );
}

// A memory's state is the worst case across its anchors (see subsumedFileAnchors for the
// whole-file anchors a symbol anchor overrides). No anchors → unverified (nothing to verify
// against).
export function deriveMemoryState(anchors: AnchorForDrift[], verify: NodeVerifier): StateReason {
  if (anchors.length === 0) {
    return { state: "unverified", reason: "memory has no graph anchors" };
  }
  const subsumed = subsumedFileAnchors(anchors);
  let worst: StateReason = { state: "active", reason: "all anchors verified" };
  let graphError: string | undefined;
  for (const a of anchors) {
    const sr = deriveAnchorState(a, verify);
    if (sr.state === "stale" && subsumed.has(a)) continue;
    if (sr.graphError !== undefined) graphError = sr.graphError;
    if (SEVERITY[sr.state] > SEVERITY[worst.state]) worst = sr;
  }
  // Surface a graph-read failure even if a higher-severity anchor (e.g. contradicted)
  // won the worst-case race, so the caller still learns verification was degraded.
  if (graphError !== undefined && worst.graphError === undefined) {
    return { ...worst, graphError };
  }
  return worst;
}

function driftVerdict(state: MemoryState, nature: Nature): { verdict: Verdict; checkViolation: boolean } {
  if (nature === "normative") {
    // A rule is not invalidated by drift, but it is not trusted blindly either: the code it
    // governs changed (or is gone), so it reads as a warning that asks for a violation check.
    if (state === "stale" || state === "contradicted") {
      return { verdict: "warning", checkViolation: true };
    }
    if (state === "unverified") return { verdict: "warning", checkViolation: false };
    return { verdict: "usable", checkViolation: false }; // active
  }
  // descriptive: drift erodes trust in the stated fact.
  if (state === "active") return { verdict: "usable", checkViolation: false };
  if (state === "contradicted") return { verdict: "do_not_use", checkViolation: false };
  return { verdict: "warning", checkViolation: false }; // stale | unverified
}

/**
 * Whether a memory can be relied on, from two INDEPENDENT axes: its drift `state` against
 * the graph and its lifecycle `status`. Neither is folded into the other — callers report
 * both — but the verdict honours both: an `obsolete` note is never usable whatever its
 * drift, and a `resolved` one (history, not current truth) is at best a warning. For
 * active notes the verdict is the drift verdict by nature (normative rules flag a violation
 * check on drift instead of being discarded).
 */
export function verdictOf(
  state: MemoryState,
  nature: Nature,
  status: ObservationStatus = "active",
): { verdict: Verdict; checkViolation: boolean } {
  const drift = driftVerdict(state, nature);
  if (status === "obsolete") return { verdict: "do_not_use", checkViolation: false };
  if (status === "resolved" && drift.verdict === "usable") return { ...drift, verdict: "warning" };
  return drift;
}

export interface VerifiedItem {
  id: string;
  title: string;
  type: ObservationType;
  /** Lifecycle status, reported next to (never folded into) the drift `state`. */
  status: ObservationStatus;
  topicKey?: string;
  snippet: string;
  score: number;
  nature: Nature;
  state: MemoryState;
  reason: string;
  verdict: Verdict;
  checkViolation: boolean;
}

export interface VerifiedContext {
  usable: VerifiedItem[];
  warning: VerifiedItem[];
  doNotUse: VerifiedItem[];
  // Set when the graph couldn't be read during verification: every drift verdict in this
  // result is "unverified" for that reason, not because the memories actually drifted.
  graphError?: string;
}

// Composite read: search memories for `task`, then classify each by drift state and
// nature into usable / warning / do-not-use. Returns classified memories instead of
// raw hits — the caller gets context it can trust, with a reason for anything it can't.
export function getVerifiedContext(
  store: MemoryRepository,
  task: string,
  verify: NodeVerifier,
  opts?: SearchOpts,
): VerifiedContext {
  const hits = store.search(task, opts);
  const ctx: VerifiedContext = { usable: [], warning: [], doNotUse: [] };
  for (const h of hits) {
    const anchors = store.anchorsForObservation(h.id);
    const { state, reason, graphError } = deriveMemoryState(anchors, verify);
    if (graphError !== undefined && ctx.graphError === undefined) ctx.graphError = graphError;
    const nature = natureOf(h.type);
    const { verdict, checkViolation } = verdictOf(state, nature, h.status);
    const item: VerifiedItem = {
      id: h.id,
      title: h.title,
      type: h.type,
      status: h.status,
      snippet: h.snippet,
      score: h.score,
      nature,
      state,
      reason,
      verdict,
      checkViolation,
    };
    if (h.topicKey !== undefined) item.topicKey = h.topicKey;
    if (verdict === "usable") ctx.usable.push(item);
    else if (verdict === "warning") ctx.warning.push(item);
    else ctx.doNotUse.push(item);
  }
  return ctx;
}
