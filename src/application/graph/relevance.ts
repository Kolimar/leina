// Term relevance for `query`: how strongly does a natural-language question (English or
// Spanish) name a graph node?
//
// The old scorer added +100 whenever a question word equalled a whole label, so the
// common verb in "how does the hook RESOLVE the project root" seeded the graph's
// `resolve()` function; module labels are paths, so path words made test files win; and
// every word weighed the same. This model instead:
//   - drops EN/ES stopwords and stems both sides (verified ~ verify, anchors ~ anchor);
//   - splits labels into camelCase/snake_case words — module labels by file name only,
//     directories counting as weak path evidence;
//   - weighs each term by an IDF over the graph's own vocabulary (rare words decide);
//   - rewards covering MORE of the question and labels made mostly of question words;
//   - gives an exact-name bonus only to identifier-shaped tokens (`openFreshStore`), or
//     to a one-word question — never to an ordinary English word inside a sentence;
//   - prefers symbols over modules and penalises test/mock/fixture paths unless asked.

import type { GraphNode } from "../../domain/graph/model.ts";
import { normalizeLabel, splitIdentifier } from "../../domain/shared/id.ts";
import { isTestLikePath } from "./test-paths.ts";

// Stored without diacritics: tokens are folded the same way before lookup.
const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  "a", "about", "above", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as",
  "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "could", "did", "do", "does", "doing", "done", "down", "during", "each", "few", "for",
  "from", "further", "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his",
  "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me", "more", "most", "my",
  "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other", "our", "out",
  "over", "own", "same", "she", "should", "so", "some", "such", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under",
  "until", "up", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who",
  "whom", "why", "will", "with", "would", "you", "your", "yours", "us", "let", "lets",
  // English meta words: they describe the code, they are not in it
  "code", "codebase", "repo", "function", "functions", "method", "methods", "class", "classes",
  "implemented", "implementation", "logic", "happen", "happens", "work", "works", "thing",
  // Spanish
  "al", "algo", "algun", "alguna", "algunas", "alguno", "algunos", "ante", "antes", "como",
  "con", "contra", "cual", "cuales", "cuando", "de", "del", "desde", "donde", "durante", "el",
  "ella", "ellas", "ellos", "en", "entre", "era", "es", "esa", "esas", "ese", "eso", "esos",
  "esta", "estan", "estas", "este", "esto", "estos", "fue", "hace", "hay", "la", "las", "le",
  "les", "lo", "los", "mas", "mi", "mis", "mucho", "muy", "nada", "ni", "nos", "nosotros",
  "otra", "otro", "para", "pero", "poco", "por", "porque", "que", "quien", "se", "sea", "segun",
  "ser", "si", "sin", "sobre", "son", "su", "sus", "tambien", "te", "tiene", "tienen", "todo",
  "todos", "tu", "tus", "un", "una", "unas", "uno", "unos", "ya",
  // Spanish meta words
  "codigo", "funcion", "funciones", "metodo", "metodos", "clase", "clases",
]);

// Terms that ask FOR tests: their presence lifts the test penalty.
const TEST_TERMS: ReadonlySet<string> = new Set(["test", "spec", "mock", "fixtur", "prueba"]);

const IRREGULAR: ReadonlyMap<string, string> = new Map([
  ["built", "build"], ["found", "find"], ["made", "make"], ["ran", "run"], ["written", "write"],
  ["wrote", "write"], ["sent", "send"], ["got", "get"], ["kept", "keep"], ["held", "hold"],
]);

const fold = (s: string): string => s.normalize("NFD").replaceAll(/\p{M}+/gu, "").toLowerCase();

/**
 * Light English suffix stemmer, applied identically to question terms and label words
 * so inflections meet: verified/verifies/verify → verifi, anchors → anchor,
 * confined/confine/confinement → confin, freshness → fresh.
 */
export function stem(word: string): string {
  const irregular = IRREGULAR.get(word);
  if (irregular) return irregular;
  if (word.length < 3) return word;
  let s = stripSuffix(word);
  if (s.length > 3 && s.endsWith("y")) s = `${s.slice(0, -1)}i`;
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

// [suffix, the word must be LONGER than this, replacement] — first match wins.
const SUFFIX_RULES: readonly (readonly [string, number, string])[] = [
  ["ness", 6, ""], ["ment", 7, ""], ["ies", 4, "i"], ["ied", 4, "i"],
  ["ing", 5, ""], ["ed", 4, ""], ["es", 4, ""],
];

function stripSuffix(w: string): string {
  for (const [suffix, longerThan, replacement] of SUFFIX_RULES) {
    if (w.length > longerThan && w.endsWith(suffix)) return `${w.slice(0, -suffix.length)}${replacement}`;
  }
  return w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w;
}

export interface QuestionTerms {
  /** Stemmed content terms, stopwords removed, deduplicated. */
  terms: string[];
  /** normalizeLabel() of tokens that may name a symbol exactly (see exact-name bonus). */
  names: Set<string>;
  /** The question asks about tests (test/spec/mock/fixture/prueba). */
  mentionsTests: boolean;
}

// An identifier-shaped token: camelCase/PascalCase hump, snake_case, or letters+digits.
const IDENTIFIER_RE = /\p{Ll}\p{Lu}|\p{Lu}\p{Lu}\p{Ll}|_|\p{L}\p{N}/u;

export function analyzeQuestion(question: string): QuestionTerms {
  const raw = question.split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0);
  const content = raw.filter((t) => !STOPWORDS.has(fold(t)));
  const terms = new Set<string>();
  // One-letter words are noise in a sentence, but a one-word question may name `x()`.
  const minLength = content.length === 1 ? 1 : 2;
  for (const tok of content) {
    for (const w of splitIdentifier(tok)) {
      const f = fold(w);
      if (f.length >= minLength && !STOPWORDS.has(f)) terms.add(stem(f));
    }
  }
  const names = new Set<string>();
  for (const tok of content) {
    if (content.length === 1 || IDENTIFIER_RE.test(tok)) names.add(normalizeLabel(tok));
  }
  const list = [...terms];
  return { terms: list, names, mentionsTests: list.some((t) => TEST_TERMS.has(t)) };
}

interface NodeWords {
  label: Set<string>;
  owner: Set<string>;
  path: Set<string>;
  name: string;
}

const wordsOf = (s: string): Set<string> => new Set(splitIdentifier(s).map((w) => stem(fold(w))));
const stripCall = (s: string): string => s.replace(/\(\)$/, "");

function nodeWords(n: GraphNode, owner: GraphNode | undefined): NodeWords {
  const file = n.sourceFile.replaceAll("\\", "/");
  const slash = file.lastIndexOf("/");
  const dir = slash >= 0 ? file.slice(0, slash) : "";
  const base = file.slice(slash + 1).replace(/\.[^.]+$/, "");
  const isModule = n.kind === "module";
  const name = isModule ? base : stripCall(n.label);
  const path = wordsOf(isModule ? dir : `${dir} ${base}`);
  return { label: wordsOf(name), owner: owner ? wordsOf(owner.label) : new Set(), path, name: normalizeLabel(name) };
}

const KIND_FACTOR: ReadonlyMap<string, number> = new Map([
  ["function", 1], ["method", 1], ["class", 1],
  ["interface", 0.85], ["type", 0.85], ["type_alias", 0.85], ["enum", 0.85],
  ["module", 0.6],
]);
const TEST_FACTOR = 0.1;

export interface RelevanceOptions {
  /** Score test/mock/fixture nodes like production code (default: penalised). */
  includeTests?: boolean;
}

/** Scores nodes against one question; IDF is computed over the given node set. */
export class RelevanceModel {
  readonly question: QuestionTerms;
  readonly includeTests: boolean;
  private readonly idf = new Map<string, number>();
  private readonly words = new Map<string, NodeWords>();

  constructor(
    nodes: readonly GraphNode[],
    ownerOf: (id: string) => GraphNode | undefined,
    question: string,
    opts: RelevanceOptions = {},
  ) {
    this.question = analyzeQuestion(question);
    this.includeTests = opts.includeTests === true || this.question.mentionsTests;
    const df = new Map<string, number>();
    for (const n of nodes) {
      const w = nodeWords(n, ownerOf(n.id));
      this.words.set(n.id, w);
      for (const t of new Set([...w.label, ...w.path])) df.set(t, (df.get(t) ?? 0) + 1);
    }
    for (const t of this.question.terms) {
      this.idf.set(t, Math.log((nodes.length + 1) / ((df.get(t) ?? 0) + 1)) + 0.1);
    }
  }

  /** True when `n` is test-like and tests are penalised for this question. */
  isPenalisedTest(n: GraphNode): boolean {
    return !this.includeTests && isTestLikePath(n.sourceFile);
  }

  /** Relevance of `n` (0 = unrelated). */
  score(n: GraphNode): number {
    const w = this.words.get(n.id);
    const { terms, names } = this.question;
    if (!w || terms.length === 0) return 0;
    let sum = 0;
    let covered = 0;
    let labelHits = 0;
    for (const t of terms) {
      const weight = termWeight(w, t);
      if (weight === 0) continue;
      sum += weight * (this.idf.get(t) ?? 0);
      if (weight >= 0.5) covered += weight;
      if (w.label.has(t)) labelHits++;
    }
    if (sum === 0) return 0;
    const questionCoverage = covered / terms.length;
    const labelCoverage = w.label.size > 0 ? Math.min(1, labelHits / w.label.size) : 0;
    let score = sum * (0.4 + questionCoverage) * (0.7 + 0.3 * labelCoverage);
    if (names.has(w.name)) score *= 3;
    score *= KIND_FACTOR.get(n.kind ?? "") ?? 0.7;
    if (this.isPenalisedTest(n)) score *= TEST_FACTOR;
    return score;
  }
}

// How a term meets a node: label word 1, label-word prefix 0.6, owner word 0.5, path 0.3.
function termWeight(w: NodeWords, t: string): number {
  if (w.label.has(t)) return 1;
  if (t.length >= 4) {
    for (const lw of w.label) {
      if (lw.length >= 4 && (lw.startsWith(t) || t.startsWith(lw))) return 0.6;
    }
  }
  if (w.owner.has(t)) return 0.5;
  return w.path.has(t) ? 0.3 : 0;
}
