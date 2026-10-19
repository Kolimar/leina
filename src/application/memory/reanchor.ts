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
//   - Short (< 3 chars) and generic identifiers (`get`, `query`, `foo`, `npm`…) are not
//     references, and a bare identifier is never anchored to test code alone (`fn` used to
//     land on a test-local helper): name the file (`test/x.test.ts:helper`) to mean it.
//   - With an upgrader, file-level anchors (whole-file hash, the pre-3.0 format) are
//     upgraded in place to symbol fingerprints without moving their baseline (see
//     makeUpgradeAnchor in anchor-verify.ts).

import type { MemoryRepository } from "../../domain/memory/ports.ts";
import { isFileLevelHash } from "../../domain/memory/symbol-span.ts";
import type { AnchorResolver } from "../../infrastructure/sqlite/memory-repository.ts";
import type { AnchorUpgrader } from "./anchor-verify.ts";

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

// Identifiers shorter than this are locals / parameters (`fn`, `p`, `id`), not references.
const MIN_IDENT_CHARS = 3;

// Backticked words that name a concept, a command or a placeholder far more often than one
// specific symbol. Compared case-insensitively against a bare identifier; a dotted one
// (`GraphStore.close`) is already qualified and is not filtered.
const GENERIC_IDENTIFIERS = new Set([
  // placeholders and literals
  "foo", "bar", "baz", "qux", "true", "false", "null", "undefined", "nan", "this", "self",
  // types and keywords
  "string", "number", "boolean", "object", "any", "void", "never", "unknown", "async", "await",
  "return", "const", "let", "var", "function", "class", "interface", "type", "enum", "import", "export",
  // generic verbs
  "get", "set", "run", "add", "put", "use", "new", "map", "call", "apply", "bind", "then", "init",
  "main", "start", "stop", "open", "close", "read", "write", "load", "save", "update", "delete",
  "remove", "create", "build", "parse", "format", "render", "check", "verify", "query", "search",
  "fetch", "push", "pop", "test", "done", "resolve",
  // generic nouns
  "data", "value", "values", "name", "key", "keys", "args", "opts", "options", "config", "result",
  "error", "err", "input", "output", "path", "file", "files", "dir", "root", "list", "item", "items", "field",
  "node", "nodes", "edge", "edges", "graph", "memory", "index", "util", "utils", "helper", "helpers",
  "handler", "callback", "todo", "readme", "src", "dist", "tmp", "temp", "log",
  // tools and formats
  "npm", "npx", "git", "bash", "zsh", "sql", "json", "yaml", "toml", "http", "https", "cli",
  "mcp", "api", "html", "css",
]);

/** An explicit code reference: a label, plus the file it was qualified with (`path:symbol`). */
export interface Candidate {
  label: string;
  file?: string;
}

function isNoiseIdentifier(ident: string): boolean {
  if (ident.length < MIN_IDENT_CHARS) return true;
  return !ident.includes(".") && GENERIC_IDENTIFIERS.has(ident.toLowerCase());
}

/**
 * Extract explicit path/symbol candidates from an observation's text. Order-preserving,
 * de-duplicated (by label + file). Short or generic bare identifiers are not candidates.
 */
export function extractCandidates(text: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const add = (label: string, file?: string): void => {
    const trimmed = label.trim();
    const key = `${file ?? ""}\u0000${trimmed}`;
    if (trimmed.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push(file === undefined ? { label: trimmed } : { label: trimmed, file });
  };

  for (const m of text.matchAll(BACKTICK_SPAN)) {
    const raw = m[1]!.trim();
    const pathSym = PATH_SYMBOL_RE.exec(raw);
    if (pathSym) {
      add(pathSym[1]!);
      // The file qualifies the symbol: it resolves within that file only, so even a short
      // or generic name is unambiguous here.
      add(pathSym[2]!, pathSym[1]);
      continue;
    }
    if (PATH_RE.test(raw)) {
      add(raw);
      continue;
    }
    const stripped = raw.endsWith("()") ? raw.slice(0, -2) : raw;
    if (IDENT_RE.test(stripped) && !isNoiseIdentifier(stripped)) {
      add(stripped);
    }
    // else: prose inside backticks (spaces, sentences, arbitrary punctuation) — not an
    // explicit code reference. Left alone, per design: no fuzzy/NLP guessing.
  }
  return out;
}

/** The labels of {@link extractCandidates}, de-duplicated. */
export function extractCandidateLabels(text: string): string[] {
  return [...new Set(extractCandidates(text).map((c) => c.label))];
}

// Test code: test directories, `*.test.*` / `*.spec.*` files and fixtures.
const TEST_PATH_RE = /(^|\/)(test|tests|__tests__|spec|fixtures)\/|\.(test|spec)\.[A-Za-z0-9]+$/;

export function isTestPath(file: string): boolean {
  return TEST_PATH_RE.test(file);
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

export interface ReanchorUpgraded {
  nodeId: string;
  label?: string;
}

export interface ReanchorObservationResult {
  observationId: string;
  minted: ReanchorMinted[];
  rejected: ReanchorRejected[];
  /** File-level anchors upgraded (or, under --dry-run, that WOULD be) to symbol fingerprints. */
  upgraded: ReanchorUpgraded[];
}

export interface ReanchorReport {
  /** Total candidate references extracted and evaluated across every observation. */
  processed: number;
  /** Anchors actually inserted (or, under --dry-run, that WOULD be inserted). */
  minted: number;
  /** Candidates that did not result in a new anchor (unresolved, ambiguous, or already-anchored). */
  rejected: number;
  /** File-level anchors upgraded to symbol fingerprints (0 without an upgrader). */
  upgraded: number;
  /** Per-observation detail, in exportAll() order. Observations with zero candidates are omitted. */
  items: ReanchorObservationResult[];
}

// Upgrades the observation's file-level anchors the upgrader can fingerprint losslessly
// (compare-and-set on the stored hash; nothing is written under dry-run).
function upgradeFileAnchors(
  store: MemoryRepository,
  obs: ReturnType<MemoryRepository["exportAll"]>[number],
  upgradeAnchor: AnchorUpgrader,
  dryRun: boolean,
): ReanchorUpgraded[] {
  const out: ReanchorUpgraded[] = [];
  for (const a of obs.anchors) {
    if (a.anchorHash === undefined || !isFileLevelHash(a.anchorHash)) continue;
    const fingerprint = upgradeAnchor({ nodeId: a.nodeId, anchorHash: a.anchorHash });
    if (fingerprint === null) continue;
    if (!dryRun) store.replaceAnchorHash(obs.id, a.nodeId, a.anchorHash, fingerprint);
    out.push(a.anchorLabel === undefined ? { nodeId: a.nodeId } : { nodeId: a.nodeId, label: a.anchorLabel });
  }
  return out;
}

type Resolution = { match: ReturnType<AnchorResolver>[number] } | { reason: string };

// One candidate → exactly one node, or why not. A `path:symbol` candidate resolves within
// its file only; a bare identifier prefers production code and is never anchored to test
// code alone.
function resolveCandidate(c: Candidate, resolveAnchor: AnchorResolver): Resolution {
  let matches = resolveAnchor(c.label);
  if (c.file !== undefined) {
    const inFile = matches.filter((m) => m.sourceFile === c.file);
    if (inFile.length === 0 && matches.length > 0) return { reason: `no match in '${c.file}'` };
    matches = inFile;
  } else if (IDENT_RE.test(c.label)) {
    const prod = matches.filter((m) => !isTestPath(m.sourceFile));
    if (prod.length === 0 && matches.length > 0) {
      return { reason: "matches only test code — qualify it as `path:symbol` to anchor it" };
    }
    matches = prod;
  }
  if (matches.length === 0) return { reason: "no match found in the live graph" };
  if (matches.length > 1) return { reason: `ambiguous — resolves to ${matches.length} nodes` };
  return { match: matches[0]! };
}

/**
 * Retro-anchor existing observations: scan every observation returned by `store.exportAll()`,
 * extract explicit candidate references from its title+content, resolve each one against the
 * live graph via `resolveAnchor`, and mint a NEW anchor for every candidate that resolves to
 * exactly one node it isn't already anchored to. With `upgradeAnchor`, also upgrade each
 * existing file-level anchor to a symbol fingerprint when the upgrader can do it losslessly.
 *
 * `dryRun: true` performs the exact same extraction+resolution but never writes — the
 * report describes what a real run would do.
 */
export function reanchorObservations(
  store: MemoryRepository,
  resolveAnchor: AnchorResolver,
  opts: { dryRun?: boolean; upgradeAnchor?: AnchorUpgrader } = {},
): ReanchorReport {
  const dryRun = opts.dryRun ?? false;
  const items: ReanchorObservationResult[] = [];
  let processed = 0;
  let minted = 0;
  let rejected = 0;
  let upgraded = 0;

  for (const obs of store.exportAll()) {
    const upgradedHere =
      opts.upgradeAnchor === undefined ? [] : upgradeFileAnchors(store, obs, opts.upgradeAnchor, dryRun);
    upgraded += upgradedHere.length;

    const candidates = extractCandidates(`${obs.title}\n${obs.content}`);
    if (candidates.length === 0) {
      if (upgradedHere.length > 0) {
        items.push({ observationId: obs.id, minted: [], rejected: [], upgraded: upgradedHere });
      }
      continue;
    }

    const alreadyAnchored = new Set(obs.anchors.map((a) => a.nodeId));
    const mintedHere: ReanchorMinted[] = [];
    const rejectedHere: ReanchorRejected[] = [];
    const toInsert: {
      nodeId: string;
      anchorLabel: string;
      anchorFile: string;
      anchorHash?: string;
    }[] = [];

    for (const candidate of candidates) {
      processed += 1;
      const label = candidate.label;
      const resolution = resolveCandidate(candidate, resolveAnchor);
      if ("reason" in resolution) {
        rejectedHere.push({ label, reason: resolution.reason });
        continue;
      }
      const { match } = resolution;
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
      if (match.anchorHash !== undefined) anchor.anchorHash = match.anchorHash;
      toInsert.push(anchor);
    }

    if (!dryRun && toInsert.length > 0) {
      store.addAnchorsIfMissing(obs.id, toInsert);
    }

    minted += mintedHere.length;
    rejected += rejectedHere.length;
    if (mintedHere.length > 0 || rejectedHere.length > 0 || upgradedHere.length > 0) {
      items.push({ observationId: obs.id, minted: mintedHere, rejected: rejectedHere, upgraded: upgradedHere });
    }
  }

  return { processed, minted, rejected, upgraded, items };
}
