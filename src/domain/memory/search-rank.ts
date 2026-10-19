// domain/memory/search-rank.ts — the ranking policy of memory search (pure).
//
// Both search back ends (FTS5 and the LIKE fallback for SQLite builds without it) produce a
// candidate pool with a base relevance in [0, 1] — normalised bm25 for FTS5, a BM25-like
// score computed here for LIKE — and hand it to rankSearchCandidates(), so the two modes
// order results by the same rules:
//
//   tier     exact hits first, then the prefix-fallback tiers (long prefix, then 4-char)
//   status   active before resolved / obsolete (those stay findable, just demoted)
//   score    relevance + match boosts (exact topic key ≫ topic family / leaf ≫ phrase in the
//            title > every token in the title > phrase in the content) + a small recency prior
//   ties     newest first, then id (descending) — the order never depends on the SQLite build
//
// All text comparisons are accent- and case-insensitive (foldText), so "publicacion" and
// "publicación" rank the same.

import type { ObservationStatus } from "./model.ts";

/** Lowercase and strip diacritics: "Publicación" → "publicacion". */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** Folded, de-duplicated whitespace-separated query tokens. */
export function queryTokens(query: string): string[] {
  return [...new Set(foldText(query).split(/\s+/).filter((t) => t.length > 0))];
}

/** Below this many characters a token never forms a prefix (too unselective). */
export const MIN_PREFIX_TOKEN = 4;

/**
 * The prefix-fallback tiers for a query: tier 1 cuts each token (≥ MIN_PREFIX_TOKEN chars) to
 * its leading ~60%, tier 2 to 4 chars — the index holds porter STEMS, which can be shorter than
 * the 60% cut ("pagination" → "pagin"). Empty tiers (or a tier equal to the previous one) are
 * dropped; an empty result means the query has no token long enough to widen.
 */
export function prefixTiers(query: string): string[][] {
  const tokens = queryTokens(query).filter((t) => Array.from(t).length >= MIN_PREFIX_TOKEN);
  const cut = (t: string, n: number): string => Array.from(t).slice(0, n).join("");
  const long = [...new Set(tokens.map((t) => cut(t, Math.max(MIN_PREFIX_TOKEN, Math.floor(Array.from(t).length * 0.6)))))];
  const short = [...new Set(tokens.map((t) => cut(t, MIN_PREFIX_TOKEN)))];
  const tiers: string[][] = [];
  if (long.length > 0) tiers.push(long);
  if (short.length > 0 && short.some((s) => !long.includes(s))) tiers.push(short);
  return tiers;
}

export interface RankCandidate {
  id: string;
  title: string;
  content: string;
  topicKey?: string;
  updatedAt: number;
  status: ObservationStatus;
  /** Base relevance from the back end, normalised to [0, 1] within the pool. */
  relevance: number;
  /** 0 = exact hit, 1.. = prefix-fallback tier. */
  tier: number;
}

export const SEARCH_BOOSTS = {
  exactTopic: 5,
  topicFamilyOrLeaf: 1.5,
  titlePhrase: 1,
  titleAllTokens: 0.5,
  contentPhrase: 0.3,
  recency: 0.3,
} as const;

/** Recency prior half-life (days), measured from the newest candidate. */
export const SEARCH_RECENCY_HALF_LIFE_DAYS = 90;
const DAY_MS = 86_400_000;

function matchBoost(c: RankCandidate, phrase: string, tokens: string[]): number {
  let boost = 0;
  if (c.topicKey !== undefined && phrase.length > 0) {
    const topic = foldText(c.topicKey);
    const underscored = phrase.replace(/\s+/g, "_");
    const hyphenated = phrase.replace(/\s+/g, "-");
    const leaf = topic.slice(topic.lastIndexOf("/") + 1);
    if (topic === underscored || topic === hyphenated || topic === phrase) boost += SEARCH_BOOSTS.exactTopic;
    else if (topic.startsWith(`${hyphenated}/`) || leaf === hyphenated || leaf === underscored) {
      boost += SEARCH_BOOSTS.topicFamilyOrLeaf;
    }
  }
  const title = foldText(c.title);
  if (phrase.length > 0 && title.includes(phrase)) boost += SEARCH_BOOSTS.titlePhrase;
  else if (tokens.length > 1 && tokens.every((t) => title.includes(t))) boost += SEARCH_BOOSTS.titleAllTokens;
  if (phrase.length > 0 && foldText(c.content).includes(phrase)) boost += SEARCH_BOOSTS.contentPhrase;
  return boost;
}

/** Final score of one candidate (exposed for tests and the hit's `score`). */
export function searchScore(c: RankCandidate, query: string, newest: number): number {
  const tokens = queryTokens(query);
  const phrase = tokens.join(" ");
  const ageDays = Math.max(0, newest - c.updatedAt) / DAY_MS;
  const recency = SEARCH_BOOSTS.recency * 0.5 ** (ageDays / SEARCH_RECENCY_HALF_LIFE_DAYS);
  return c.relevance + matchBoost(c, phrase, tokens) + recency;
}

/** Order candidates (see the header) and attach each one's final score. */
export function rankSearchCandidates<T extends RankCandidate>(candidates: readonly T[], query: string): (T & { finalScore: number })[] {
  if (candidates.length === 0) return [];
  const newest = candidates.reduce((m, c) => Math.max(m, c.updatedAt), 0);
  const scored = candidates.map((c) => ({ ...c, finalScore: searchScore(c, query, newest) }));
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(a.status !== "active") - Number(b.status !== "active") ||
      b.finalScore - a.finalScore ||
      b.updatedAt - a.updatedAt ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  return scored;
}

/** Non-overlapping occurrences of `needle` in `hay`. */
function occurrences(hay: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * BM25-style relevance for the LIKE back end, normalised to [0, 1] (best = 1). Substring term
 * frequency, title weighted 5× like the FTS5 index (bm25(obs_fts, 5.0, 1.0)), idf over
 * `corpusSize` live notes with document frequencies taken from the candidates themselves
 * (every note containing a token is a candidate).
 */
export function likeRelevance(docs: readonly { title: string; content: string }[], tokens: readonly string[], corpusSize: number): number[] {
  if (docs.length === 0) return [];
  const k1 = 1.2;
  const b = 0.75;
  const folded = docs.map((d) => ({ title: foldText(d.title), content: foldText(d.content) }));
  const lengths = folded.map((d) => (d.title.length + d.content.length) / 6 + 1);
  const avg = lengths.reduce((s, l) => s + l, 0) / lengths.length;
  const n = Math.max(corpusSize, docs.length);
  const idf = tokens.map((t) => {
    const df = folded.filter((d) => d.title.includes(t) || d.content.includes(t)).length;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  });
  const raw = folded.map((d, i) =>
    tokens.reduce((sum, t, j) => {
      const tf = 5 * occurrences(d.title, t) + occurrences(d.content, t);
      if (tf === 0) return sum;
      return sum + idf[j]! * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * lengths[i]!) / avg)));
    }, 0),
  );
  const max = Math.max(...raw);
  return raw.map((r) => (max > 0 ? r / max : 0));
}
