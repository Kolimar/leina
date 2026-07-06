// application/memory/reanchor.ts — conservative retro-anchoring for existing observations.
//
// Many observations are saved WITHOUT --anchors (or predate anchoring entirely), so the
// drift-verification pipeline (query.ts) treats them as `unverified` even when their text
// plainly names a real file or symbol. `reanchorObservations` closes that gap by extracting
// ONLY explicit code references from each observation's title+content and minting an anchor
// when — and only when — the reference resolves to EXACTLY one live graph node.
//
// Deliberately narrow, by design (see design.md §3):
//   - NO fuzzy/substring matching, NO NLP, NO free-prose scanning.
//   - A candidate ambiguous across 2+ nodes, or matching none, is rejected — never guessed.
//   - Anchors are unioned onto whatever an observation already has (addAnchorsIfMissing),
//     never replacing existing anchors — and the whole operation is idempotent: re-running
//     it after a successful run mints nothing new.

import type { MemoryRepository } from "../../domain/memory/ports.ts";
import type { AnchorResolver } from "../../infrastructure/sqlite/memory-repository.ts";

// ---------------------------------------------------------------------------
// Candidate extraction — EXPLICIT references only.
//
// The only signal treated as "explicit" is a backtick-quoted code span (the same markdown
// convention leina's own memory notes already use for paths/symbols). Inside a span:
//   - `path/to/file.ts:symbolName()`  → two candidates: the path AND the symbol.
//   - `path/to/file.ts`               → one candidate: the path (must contain a "/" AND
//                                        a file extension — otherwise it is not path-shaped).
//   - `symbolName` / `symbolName()`   → one candidate: the (possibly dotted) identifier.
//   - anything else (free prose, sentences, punctuation) → skipped entirely.
// Resolution against the live graph (see reanchorObservations) is what actually decides
// whether a candidate is real — this stage only decides whether something LOOKS like code.
// ---------------------------------------------------------------------------

const BACKTICK_SPAN = /`([^`\n]{1,200})`/g;
// `path:symbol` or `path:symbol()` — path requires a slash + extension, symbol a bare identifier.
// Reviewed: the repeated group and the trailing extension use disjoint character classes
// ("/" vs "[\w.-]"), so there is no ambiguous backtracking; input is also capped at 200
// chars by BACKTICK_SPAN above.
// eslint-disable-next-line security/detect-unsafe-regex
const PATH_SYMBOL_RE = /^([\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8}):([A-Za-z_$][\w$]*)\(?\)?$/;
// Bare path: at least one "/" and a trailing extension. Reviewed: same reasoning as
// PATH_SYMBOL_RE above (disjoint classes, 200-char-capped input).
// eslint-disable-next-line security/detect-unsafe-regex
const PATH_RE = /^[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8}$/;
// Bare (optionally dotted) identifier, no slash — e.g. "openFreshStore", "Foo.bar". Reviewed:
// the repeated group requires a leading "." absent from [\w$], so there is no overlap
// between iterations; input is also capped at 200 chars by BACKTICK_SPAN above.
// eslint-disable-next-line security/detect-unsafe-regex
const IDENT_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * Extract explicit path/symbol candidates from an observation's text. Order-preserving,
 * de-duplicated. Exported for direct unit testing of the extraction heuristic in isolation
 * from graph resolution.
 */
export function extractCandidateLabels(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (label: string): void => {
    const trimmed = label.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  for (const m of text.matchAll(BACKTICK_SPAN)) {
    const raw = m[1]!.trim();
    const pathSym = PATH_SYMBOL_RE.exec(raw);
    if (pathSym) {
      add(pathSym[1]!);
      add(pathSym[2]!);
      continue;
    }
    if (PATH_RE.test(raw)) {
      add(raw);
      continue;
    }
    const stripped = raw.endsWith("()") ? raw.slice(0, -2) : raw;
    if (IDENT_RE.test(stripped)) {
      add(stripped);
    }
    // else: prose inside backticks (spaces, sentences, arbitrary punctuation) — not an
    // explicit code reference. Left alone, per design: no fuzzy/NLP guessing.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution + minting
// ---------------------------------------------------------------------------

export interface ReanchorMinted {
  label: string;
  nodeId: string;
  sourceFile: string;
}

export interface ReanchorRejected {
  label: string;
  reason: string;
}

export interface ReanchorObservationResult {
  observationId: string;
  minted: ReanchorMinted[];
  rejected: ReanchorRejected[];
}

export interface ReanchorReport {
  /** Total candidate references extracted and evaluated across every observation. */
  processed: number;
  /** Anchors actually inserted (or, under --dry-run, that WOULD be inserted). */
  minted: number;
  /** Candidates that did not result in a new anchor (unresolved, ambiguous, or already-anchored). */
  rejected: number;
  /** Per-observation detail, in exportAll() order. Observations with zero candidates are omitted. */
  items: ReanchorObservationResult[];
}

/**
 * Retro-anchor existing observations: scan every observation returned by `store.exportAll()`,
 * extract explicit candidate references from its title+content, resolve each one against the
 * live graph via `resolveAnchor`, and mint a NEW anchor for every candidate that resolves to
 * exactly one node it isn't already anchored to.
 *
 * `dryRun: true` performs the exact same extraction+resolution but never calls
 * `store.addAnchorsIfMissing` — the report describes what a real run would do.
 */
export function reanchorObservations(
  store: MemoryRepository,
  resolveAnchor: AnchorResolver,
  opts: { dryRun?: boolean } = {},
): ReanchorReport {
  const dryRun = opts.dryRun ?? false;
  const items: ReanchorObservationResult[] = [];
  let processed = 0;
  let minted = 0;
  let rejected = 0;

  for (const obs of store.exportAll()) {
    const candidates = extractCandidateLabels(`${obs.title}\n${obs.content}`);
    if (candidates.length === 0) continue;

    const alreadyAnchored = new Set(obs.anchors.map((a) => a.nodeId));
    const mintedHere: ReanchorMinted[] = [];
    const rejectedHere: ReanchorRejected[] = [];
    const toInsert: {
      nodeId: string;
      anchorLabel: string;
      anchorFile: string;
      anchorHash?: string;
    }[] = [];

    for (const label of candidates) {
      processed += 1;
      const matches = resolveAnchor(label);
      if (matches.length === 0) {
        rejectedHere.push({ label, reason: "no match found in the live graph" });
        continue;
      }
      if (matches.length > 1) {
        rejectedHere.push({ label, reason: `ambiguous — resolves to ${matches.length} nodes` });
        continue;
      }
      const match = matches[0]!;
      if (alreadyAnchored.has(match.nodeId)) {
        rejectedHere.push({ label, reason: "already anchored to this node" });
        continue;
      }
      alreadyAnchored.add(match.nodeId); // dedupe multiple labels resolving to the same node
      mintedHere.push({ label, nodeId: match.nodeId, sourceFile: match.sourceFile });
      const anchor: { nodeId: string; anchorLabel: string; anchorFile: string; anchorHash?: string } = {
        nodeId: match.nodeId,
        anchorLabel: label,
        anchorFile: match.sourceFile,
      };
      if (match.fileHash !== undefined) anchor.anchorHash = match.fileHash;
      toInsert.push(anchor);
    }

    if (!dryRun && toInsert.length > 0) {
      store.addAnchorsIfMissing(obs.id, toInsert);
    }

    minted += mintedHere.length;
    rejected += rejectedHere.length;
    if (mintedHere.length > 0 || rejectedHere.length > 0) {
      items.push({ observationId: obs.id, minted: mintedHere, rejected: rejectedHere });
    }
  }

  return { processed, minted, rejected, items };
}
