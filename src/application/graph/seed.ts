// Seed resolution: turn a user-supplied selector into ONE graph node, deterministically.
//
// Selector forms, tried in this order:
//   1. a raw node id                     src_cli_doctor_ts:checkgraph
//   2. <path>:<symbol>                   src/cli/doctor.ts:checkGraph, memory-repository.ts:SQLiteMemoryRepository.search
//                                        (<path> matches a /-aligned suffix of the node's file)
//   3. an exact label, `()` optional     checkGraph, checkGraph(), src/cli/doctor.ts
//   4. Owner.member (or Owner#member)    SQLiteMemoryRepository.search
//   5. a /-aligned file-path suffix      handlers/graph.ts  (module nodes only)
//
// Matching is EXACT (case-insensitive allowed, case-sensitive ranked first). There is no
// substring fallback: a near-miss used to resolve silently to an unrelated node (`Relation`
// answered for `RelationCount`), which is worse than no answer. With no exact match the
// caller gets the closest candidates to suggest instead.
//
// Several exact matches are ranked: case-sensitive > case-insensitive; production code >
// test/mock/fixture paths; function/method/class > interface/type > const/var/other >
// module; then file path, line and id. The best one is used and the rest are returned as
// alternatives, each with a selector that picks it unambiguously.

import type { GraphNode } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import { splitIdentifier } from "../../domain/shared/id.ts";
import { lineOf, nodeAt, ownerOf } from "./present.ts";
import { isTestLikePath } from "./test-paths.ts";

export interface SeedCandidate {
  node: GraphNode;
  /** A selector that resolves to exactly this node: `name`, `Owner.member`, `path:name` or the id. */
  selector: string;
  /** Definition site, `file:line`. */
  at: string;
}

export interface SeedResolution {
  query: string;
  seed: GraphNode | null;
  /** The seed as a candidate (selector + site) — present only when the query was ambiguous. */
  chosen?: SeedCandidate;
  /** Other exact matches, best first (seed excluded). Non-empty = the query was ambiguous. */
  alternatives: SeedCandidate[];
  /** Only when nothing matched exactly: the closest nodes (at most 5), best first. */
  suggestions: SeedCandidate[];
}

interface Match {
  node: GraphNode;
  caseExact: boolean;
}

const SUGGESTION_LIMIT = 5;

/** Resolve `query` to a seed node (see the selector forms above). */
export function resolveSeedQuery(store: GraphRepository, rawQuery: string): SeedResolution {
  const query = rawQuery.trim();
  const byId = store.getNode(query);
  if (byId) return { query, seed: byId, alternatives: [], suggestions: [] };
  const matches = exactMatches(store, query);
  if (matches.length === 0) {
    return { query, seed: null, alternatives: [], suggestions: suggest(store, query) };
  }
  const [best, ...rest] = matches.sort(compareMatches);
  if (rest.length === 0) return { query, seed: best!.node, alternatives: [], suggestions: [] };
  return {
    query,
    seed: best!.node,
    chosen: candidate(store, best!.node),
    alternatives: rest.map((m) => candidate(store, m.node)),
    suggestions: [],
  };
}

/** A selector that resolves back to exactly `node` (shortest form that is unique). */
export function selectorFor(store: GraphRepository, node: GraphNode): string {
  const name = baseName(store, node);
  if (resolvesUniquelyTo(store, name, node)) return name;
  if (node.kind !== "module") {
    const scoped = `${node.sourceFile}:${name}`;
    if (resolvesUniquelyTo(store, scoped, node)) return scoped;
  }
  return node.id;
}

const SELECTOR_HELP =
  "selectors: <name> | <Class>.<method> | <path/to/file.ts>:<name> | <node id>";

/** `no exact match for "X"; did you mean: …` — the message for an unresolved query. */
export function noMatchMessage(res: SeedResolution): string {
  if (res.suggestions.length === 0) return `no exact match for "${res.query}" (${SELECTOR_HELP})`;
  return [
    `no exact match for "${res.query}"; did you mean:`,
    ...candidateLines(res.suggestions),
    `(${SELECTOR_HELP})`,
  ].join("\n");
}

/** The ambiguity note for a query with several exact matches; null when it was unique. */
export function ambiguityNote(res: SeedResolution, max = 10): string | null {
  if (!res.chosen || res.alternatives.length === 0) return null;
  const shown = res.alternatives.slice(0, max);
  const more = res.alternatives.length - shown.length;
  return [
    `note: "${res.query}" matches ${res.alternatives.length + 1} nodes; using ${res.chosen.selector} ` +
      `(${res.chosen.at}). To pick another, pass its selector:`,
    ...candidateLines(shown),
    ...(more > 0 ? [`  … and ${more} more`] : []),
  ].join("\n");
}

export interface ResolutionInfo {
  /** Ambiguity note or no-match message (the same text the CLI prints). */
  note?: string;
  /** Other exact matches when ambiguous: selector + definition site. */
  alternatives?: { selector: string; at: string }[];
  /** Closest nodes when nothing matched exactly. */
  suggestions?: { selector: string; at: string }[];
}

/** The JSON-friendly side channel of a resolution (MCP payloads): empty when it was unique. */
export function resolutionInfo(res: SeedResolution): ResolutionInfo {
  const brief = (cs: SeedCandidate[]): { selector: string; at: string }[] =>
    cs.map((c) => ({ selector: c.selector, at: c.at }));
  if (!res.seed) {
    const hint = res.suggestions.length > 0 ? "; did you mean one of `suggestions`?" : "";
    return { note: `no exact match for "${res.query}"${hint} (${SELECTOR_HELP})`, suggestions: brief(res.suggestions) };
  }
  if (!res.chosen || res.alternatives.length === 0) return {};
  return {
    note:
      `"${res.query}" matches ${res.alternatives.length + 1} nodes; using ${res.chosen.selector} ` +
      `(${res.chosen.at}) — pass a selector from \`alternatives\` to pick another`,
    alternatives: brief(res.alternatives),
  };
}

function candidateLines(cs: SeedCandidate[]): string[] {
  const width = Math.min(60, Math.max(...cs.map((c) => c.selector.length)));
  return cs.map((c) => `  ${c.selector.padEnd(width)}  ${c.at}`);
}

// ---------------------------------------------------------------------------
// Exact matching
// ---------------------------------------------------------------------------

const stripCall = (s: string): string => s.replace(/\(\)$/, "");

// A path-ish string: has a separator or ends in a file extension.
const looksLikePath = (s: string): boolean => /[/\\]/.test(s) || /\.[A-Za-z0-9]{1,6}$/.test(s);

const normPath = (p: string): string => p.replaceAll("\\", "/").replace(/^\.\//, "");
const isAbsolutePath = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:\//.test(p);

/** `file` is `wanted`, ends with `/wanted`, or — for an absolute `wanted` — `wanted` ends with `/file`. */
function pathMatches(file: string, wanted: string): boolean {
  const f = normPath(file);
  const w = normPath(wanted);
  if (f === w || f.endsWith(`/${w}`)) return true;
  return isAbsolutePath(w) && w.endsWith(`/${f}`);
}

/** `<path>:<symbol>` when the part before the LAST `:` looks like a path. */
function splitFileSelector(q: string): { path: string; symbol: string } | null {
  const i = q.lastIndexOf(":");
  if (i <= 0 || i === q.length - 1) return null;
  const path = q.slice(0, i);
  return looksLikePath(path) ? { path, symbol: q.slice(i + 1) } : null;
}

function splitMember(name: string): { owner: string; member: string } | null {
  const i = Math.max(name.lastIndexOf("."), name.lastIndexOf("#"));
  if (i <= 0 || i === name.length - 1) return null;
  return { owner: name.slice(0, i), member: name.slice(i + 1) };
}

function exactMatches(store: GraphRepository, q: string): Match[] {
  const fileForm = splitFileSelector(q);
  if (fileForm) {
    return symbolMatches(store, fileForm.symbol).filter((m) => pathMatches(m.node.sourceFile, fileForm.path));
  }
  const symbols = symbolMatches(store, q);
  if (symbols.length > 0 || !looksLikePath(q)) return symbols;
  return store
    .allNodes()
    .filter((n) => n.kind === "module" && pathMatches(n.sourceFile, q))
    .map((node) => ({ node, caseExact: true }));
}

function symbolMatches(store: GraphRepository, q: string): Match[] {
  const name = stripCall(q);
  const direct = labelMatches(store, name);
  if (direct.length > 0) return direct;
  const member = splitMember(name);
  return member ? memberMatches(store, member.owner, member.member) : [];
}

// Nodes labelled `name` or `name()` (functions/methods carry the parens), any case.
function labelMatches(store: GraphRepository, name: string): Match[] {
  const labels = [name, `${name}()`];
  const nodes = store.findByLabelExact
    ? store.findByLabelExact(labels)
    : store.allNodes().filter((n) => labels.some((l) => l.toLowerCase() === n.label.toLowerCase()));
  return nodes.map((node) => ({ node, caseExact: stripCall(node.label) === name }));
}

function memberMatches(store: GraphRepository, owner: string, member: string): Match[] {
  // `A.B.m` names m's owner B: compare the innermost owner segment.
  const ownerLeaf = owner.split(/[.#]/).at(-1) ?? owner;
  const out: Match[] = [];
  for (const m of labelMatches(store, member)) {
    const o = ownerOf(store, m.node);
    if (o?.label.toLowerCase() !== ownerLeaf.toLowerCase()) continue;
    out.push({ node: m.node, caseExact: m.caseExact && o.label === ownerLeaf });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ranking + selectors
// ---------------------------------------------------------------------------

const KIND_RANK: ReadonlyMap<string, number> = new Map([
  ["function", 0], ["method", 0], ["class", 0],
  ["interface", 1], ["type", 1], ["type_alias", 1], ["enum", 1],
  ["module", 3],
]);
const kindRank = (kind: string | undefined): number => KIND_RANK.get(kind ?? "") ?? 2;
const lineNum = (n: GraphNode): number => Number(lineOf(n.sourceLocation) ?? Number.MAX_SAFE_INTEGER);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareMatches(a: Match, b: Match): number {
  return (
    Number(!a.caseExact) - Number(!b.caseExact) ||
    Number(isTestLikePath(a.node.sourceFile)) - Number(isTestLikePath(b.node.sourceFile)) ||
    kindRank(a.node.kind) - kindRank(b.node.kind) ||
    cmp(a.node.sourceFile, b.node.sourceFile) ||
    lineNum(a.node) - lineNum(b.node) ||
    cmp(a.node.id, b.node.id)
  );
}

function candidate(store: GraphRepository, node: GraphNode): SeedCandidate {
  return { node, selector: selectorFor(store, node), at: nodeAt(node) };
}

// `Owner.member` for members, the label without `()` otherwise (a module's label is its path).
function baseName(store: GraphRepository, node: GraphNode): string {
  const owner = ownerOf(store, node);
  const name = stripCall(node.label);
  return owner ? `${owner.label}.${name}` : name;
}

function resolvesUniquelyTo(store: GraphRepository, selector: string, node: GraphNode): boolean {
  const byId = store.getNode(selector);
  if (byId) return byId.id === node.id;
  const ms = exactMatches(store, selector);
  return ms.length === 1 && ms[0]!.node.id === node.id;
}

// ---------------------------------------------------------------------------
// Suggestions (no exact match) — the only path that scans every node
// ---------------------------------------------------------------------------

function suggest(store: GraphRepository, query: string): SeedCandidate[] {
  const fileForm = splitFileSelector(query);
  const symbol = stripCall(fileForm?.symbol ?? query);
  const needle = (splitMember(symbol)?.member ?? symbol).toLowerCase();
  if (needle.length === 0) return [];
  const words = new Set(splitIdentifier(needle));
  let pool = store.allNodes();
  if (fileForm) {
    const inFile = pool.filter((n) => pathMatches(n.sourceFile, fileForm.path));
    if (inFile.length > 0) pool = inFile;
  }
  const scored: { m: Match; s: number }[] = [];
  for (const node of pool) {
    const s = similarity(node, needle, words);
    if (s > 0) scored.push({ m: { node, caseExact: true }, s });
  }
  scored.sort((a, b) => b.s - a.s || compareMatches(a.m, b.m));
  return scored.slice(0, SUGGESTION_LIMIT).map(({ m }) => candidate(store, m.node));
}

// Higher is closer: substring containment > edit distance ≤ ~25% > shared identifier words.
function similarity(node: GraphNode, needle: string, words: ReadonlySet<string>): number {
  const raw = node.kind === "module" ? (node.label.split("/").at(-1) ?? node.label) : stripCall(node.label);
  const name = raw.toLowerCase();
  if (name.includes(needle)) return 3 + needle.length / name.length;
  if (name.length >= 3 && needle.includes(name)) return 2 + name.length / needle.length;
  const budget = Math.max(1, Math.floor(needle.length / 4));
  const d = editDistance(name, needle, budget);
  if (d <= budget) return 2 - d / 10;
  if (words.size === 0) return 0;
  const shared = new Set(splitIdentifier(raw).filter((w) => words.has(w))).size;
  return shared / words.size >= 0.5 ? shared / words.size : 0;
}

/** Levenshtein distance, giving up (returning max+1) once it must exceed `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}
