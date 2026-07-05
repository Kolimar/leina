// scip-indexer.ts — translation from SCIP symbols/occurrences to leina's graph
// model: `makeId`-compatible ids (byte-identical to tree-sitter/ts-morph for the
// same syntactic symbol), `calls` edges derived by range containment, and
// `extends`/`implements` edges taken directly from `SymbolInformation.relationships`.
//
// Also resolves which SCIP indexer binary (if any) is available in PATH for a
// given language — the SCIP equivalent of `resolveSidecar` (sidecar.ts), except
// indexers are third-party binaries the user installs themselves (no
// leina-owned build/distribution), so "resolve" here means "detect", never
// "compile" or "download".
//
// ---------------------------------------------------------------------------
// Symbol string grammar (see scip.proto's `Symbol` message doc comment):
//
//   <symbol>     ::= <scheme> ' ' <package> ' ' (<descriptor>)+ | 'local ' <local-id>
//   <package>    ::= <manager> ' ' <package-name> ' ' <version>
//   <descriptor> ::= <namespace> | <type> | <term> | <method> | <type-parameter>
//                   | <parameter> | <meta> | <macro>
//   <namespace>  ::= <name> '/'      <type>  ::= <name> '#'
//   <term>       ::= <name> '.'      <meta>  ::= <name> ':'
//   <macro>      ::= <name> '!'      <method> ::= <name> '(' <disambiguator>? ').'
//   <type-parameter> ::= '[' <name> ']'
//   <parameter>      ::= '(' <name> ')'
//   <name> is either a bare run of identifier characters, or a backtick-quoted
//   escaped identifier (backticks doubled to escape a literal backtick).
//
// Id translation NEVER uses the raw symbol string as an id (see design decision
// "Traducción de id con paridad byte-exacta a makeId"): the descriptor chain
// (minus `namespace` descriptors, which are Go/JVM package qualifiers with no
// tree-sitter equivalent — leina ids are file-scoped, not package-scoped) is
// folded into nested `makeId(owner, name)` calls, EXACTLY mirroring how
// treesitter.ts's `emitDef`/`handleMethodNode` build `classId` then
// `makeId(classId, methodName)`.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphEdge, GraphNode, NodeKind } from "../../../domain/graph/model.ts";
import { makeId } from "../../../domain/shared/id.ts";
import { SYMBOL_ROLE_DEFINITION, readScipDocuments, type ScipDocument, type ScipOccurrence, type ScipRange } from "./scip-proto.ts";

// ---------------------------------------------------------------------------
// Symbol string parsing
// ---------------------------------------------------------------------------

type DescriptorSuffix = "namespace" | "type" | "term" | "method" | "type-parameter" | "parameter" | "meta" | "macro";

export interface ScipDescriptor {
  name: string;
  suffix: DescriptorSuffix;
}

export interface ScipParsedSymbol {
  isLocal: boolean;
  scheme: string;
  manager: string;
  packageName: string;
  version: string;
  descriptors: ScipDescriptor[];
}

/** Split the leading space-escaped `<scheme> <manager> <package-name> <version>`
 * fields from the descriptor tail. Per the grammar, a literal space inside one
 * of these fields is escaped as two consecutive spaces; a single space is the
 * field separator. Returns null when the input has fewer than 4 head fields
 * (malformed symbol) — callers degrade to "untranslatable" rather than throw. */
function splitScipHead(input: string): { scheme: string; manager: string; packageName: string; version: string; rest: string } | null {
  const fields: string[] = [];
  let cur = "";
  let i = 0;
  while (i < input.length && fields.length < 4) {
    const ch = input[i]!;
    if (ch === " ") {
      if (input[i + 1] === " ") {
        cur += " ";
        i += 2;
        continue;
      }
      fields.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (fields.length < 4) return null;
  return { scheme: fields[0]!, manager: fields[1]!, packageName: fields[2]!, version: fields[3]!, rest: input.slice(i) };
}

/** Parse one `<name>` token (bare identifier or backtick-escaped identifier)
 * starting at `i`. Returns the decoded name and the index right after it. */
function parseName(s: string, i: number): { name: string; next: number } {
  if (s[i] === "`") {
    let j = i + 1;
    let name = "";
    while (j < s.length) {
      if (s[j] === "`") {
        if (s[j + 1] === "`") {
          name += "`";
          j += 2;
          continue;
        }
        j += 1; // closing backtick
        break;
      }
      name += s[j];
      j += 1;
    }
    return { name, next: j };
  }
  let j = i;
  while (j < s.length && /[A-Za-z0-9_+\-$]/.test(s[j]!)) j++;
  return { name: s.slice(i, j), next: j };
}

/** Parse the descriptor chain following the package head. Stops (without
 * throwing) at the first malformed/unrecognized descriptor, returning
 * whatever was parsed successfully so far — a schema drift degrades rather
 * than crashes the build. */
function parseDescriptors(rest: string): ScipDescriptor[] {
  const out: ScipDescriptor[] = [];
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (ch === "[") {
      const close = rest.indexOf("]", i);
      if (close === -1) break;
      out.push({ name: rest.slice(i + 1, close), suffix: "type-parameter" });
      i = close + 1;
      continue;
    }
    if (ch === "(") {
      // Bare parameter descriptor: '(' name ')' — no preceding name/suffix char.
      const close = rest.indexOf(")", i);
      if (close === -1) break;
      out.push({ name: rest.slice(i + 1, close), suffix: "parameter" });
      i = close + 1;
      continue;
    }
    const { name, next } = parseName(rest, i);
    if (next === i) break; // no progress — malformed, stop gracefully
    const after = rest[next];
    if (after === "(") {
      // method: <name> '(' <disambiguator>? ').'
      const close = rest.indexOf(")", next);
      if (close === -1 || rest[close + 1] !== ".") break;
      out.push({ name, suffix: "method" });
      i = close + 2;
    } else if (after === "/") {
      out.push({ name, suffix: "namespace" });
      i = next + 1;
    } else if (after === "#") {
      out.push({ name, suffix: "type" });
      i = next + 1;
    } else if (after === ".") {
      out.push({ name, suffix: "term" });
      i = next + 1;
    } else if (after === ":") {
      out.push({ name, suffix: "meta" });
      i = next + 1;
    } else if (after === "!") {
      out.push({ name, suffix: "macro" });
      i = next + 1;
    } else {
      break; // unknown/malformed suffix — stop gracefully, no throw
    }
  }
  return out;
}

/** Parse a full SCIP symbol string. Returns null for malformed input
 * (never throws) so callers can degrade to "this reference/definition is
 * untranslatable" instead of failing the whole extraction. */
export function parseScipSymbol(symbol: string): ScipParsedSymbol | null {
  if (symbol.startsWith("local ")) {
    return { isLocal: true, scheme: "", manager: "", packageName: "", version: "", descriptors: [] };
  }
  const head = splitScipHead(symbol);
  if (!head) return null;
  return {
    isLocal: false,
    scheme: head.scheme,
    manager: head.manager,
    packageName: head.packageName,
    version: head.version,
    descriptors: parseDescriptors(head.rest),
  };
}

// Descriptor kinds that correspond to a distinct named entity in the source
// (and therefore participate in the `makeId` ownership chain). `namespace`
// descriptors are package/module qualifiers with no tree-sitter equivalent —
// excluded so ids stay file-scoped. `type-parameter`/`parameter` describe a
// signature detail, not a separate owned definition — also excluded.
const ID_CHAIN_SUFFIXES = new Set<DescriptorSuffix>(["type", "term", "method", "meta", "macro"]);

/**
 * Rust-specific rewrite, run on the RAW descriptor list (before the
 * `ID_CHAIN_SUFFIXES` filter, which would otherwise drop the only clue to
 * ownership here): rust-analyzer emits `impl` blocks as a literal `impl`
 * type-descriptor followed by one or two `type-parameter` descriptors —
 * `impl#[Foo]` for an inherent impl, `impl#[Foo][Trait]` for a trait impl —
 * with every member hanging off that synthetic `impl` descriptor, NOT off
 * `Foo#` directly (confirmed against rust-analyzer's `cli/scip.rs`). Left
 * unchanged, every `impl` block in a file would collapse to the same owner
 * id `makeId(relPath, "impl")`, colliding methods from unrelated types under
 * one invented shared parent. This rewrite substitutes the synthetic `impl`
 * descriptor's name with its self-type (the first `type-parameter`) and
 * discards the trait `type-parameter`, if present — mirroring
 * treesitter.ts's `defName` rule for `impl_item` (use the Self type, ignore
 * the trait name).
 */
function normalizeImpl(descriptors: ScipDescriptor[]): ScipDescriptor[] {
  const out: ScipDescriptor[] = [];
  let i = 0;
  while (i < descriptors.length) {
    const d = descriptors[i]!;
    if (d.suffix === "type" && d.name === "impl" && descriptors[i + 1]?.suffix === "type-parameter") {
      out.push({ name: descriptors[i + 1]!.name, suffix: "type" });
      i += 2; // consume the synthetic `impl` descriptor + its self-type type-parameter
      if (descriptors[i]?.suffix === "type-parameter") i += 1; // discard the trait type-parameter, if any
      continue;
    }
    out.push(d);
    i += 1;
  }
  return out;
}

/**
 * Build the owner-chain used by `foldChain`, per-language: applies
 * `normalizeImpl` first (Rust only, on the raw descriptor list — see its
 * doc comment for why order matters), then keeps only `ID_CHAIN_SUFFIXES`
 * descriptors, then — for languages that flatten nested functions (Python)
 * — drops every NON-FINAL `method`-suffixed descriptor. scip-python nests a
 * function inside its lexically enclosing function as a `method` descriptor
 * chain (`outer().inner().`), but treesitter.ts's `walk` never tracks an
 * enclosing FUNCTION as an owner (only classes/interfaces do) — so two
 * homonymous nested functions in different closures get the SAME flat
 * tree-sitter id and must get the same flat SCIP id too. Class/interface
 * owners (`type`-suffixed descriptors) are never dropped by this step.
 */
function idChain(parsed: ScipParsedSymbol, lang: ScipLang): ScipDescriptor[] {
  const cfg = SCIP_CONFIGS[lang];
  const descriptors = cfg.implSelfType ? normalizeImpl(parsed.descriptors) : parsed.descriptors;
  const chain = descriptors.filter((d) => ID_CHAIN_SUFFIXES.has(d.suffix));
  if (!cfg.flattenNestedFns) return chain;
  return chain.filter((d, i) => !(d.suffix === "method" && i < chain.length - 1));
}

/** Fold a descriptor chain into nested `makeId` calls, exactly mirroring
 * treesitter.ts: `classId = makeId(relPath, ownerName)`, then
 * `makeId(classId, methodName)` for a member. Returns `[finalId, ownerId]`
 * where `ownerId` is null for a top-level (chain length <= 1) definition. */
function foldChain(relPath: string, chain: ScipDescriptor[]): { id: string; ownerId: string | null } {
  let owner = relPath;
  let ownerId: string | null = null;
  let id = makeId(relPath);
  for (const [i, d] of chain.entries()) {
    id = makeId(owner, d.name);
    if (i < chain.length - 1) {
      ownerId = id;
      owner = id;
    }
  }
  return { id, ownerId: chain.length >= 2 ? ownerId : null };
}

/**
 * Translate a SCIP symbol string to a leina graph id, `makeId`-compatible and
 * byte-identical to what tree-sitter/ts-morph would produce for the same
 * syntactic symbol (file/top-level -> `makeId(relPath, name)`; member ->
 * `makeId(makeId(relPath, owner), name)`). `local ` symbols (function-local
 * variables, scoped to a single Document) and malformed symbols have no
 * tree-sitter equivalent and translate to `null`.
 */
export function translateScipSymbol(doc: ScipDocument, symbol: string, lang: ScipLang): string | null {
  const parsed = parseScipSymbol(symbol);
  if (!parsed || parsed.isLocal) return null;
  const chain = idChain(parsed, lang);
  if (chain.length === 0) return makeId(doc.relativePath);
  return foldChain(doc.relativePath, chain).id;
}

/** Like `translateScipSymbol`, but also returns the owner id (null when the
 * symbol is a top-level definition) and the resolved chain itself — the
 * latter feeds the kind-fallback (`sym.kind === 0`, see
 * `deriveDefinitionNodesAndEdges`), which needs the FINAL descriptor's
 * suffix and whether an owner exists, both already resolved here. */
function translateWithOwner(doc: ScipDocument, symbol: string, lang: ScipLang): { id: string; ownerId: string | null; chain: ScipDescriptor[] } | null {
  const parsed = parseScipSymbol(symbol);
  if (!parsed || parsed.isLocal) return null;
  const chain = idChain(parsed, lang);
  if (chain.length === 0) return { id: makeId(doc.relativePath), ownerId: null, chain };
  return { ...foldChain(doc.relativePath, chain), chain };
}

/** A symbol is "callable" (and therefore a valid `calls` edge target) when its
 * last descriptor is method-shaped (`name(...)`.) or macro-shaped (`name!`) —
 * derivable directly from the symbol string, with no dependency on
 * `SymbolInformation.kind` lookups (which would require a cross-document/
 * whole-project index for symbols defined outside the current Document).
 * `macro` is included for Rust (`foo!()` invocations); the caller
 * (`deriveCallEdges`) still only emits an edge when the target id matches an
 * actually-derived node, so a macro with no translatable definition never
 * produces an orphan edge. */
function isCallableSymbol(symbol: string): boolean {
  const parsed = parseScipSymbol(symbol);
  if (!parsed || parsed.isLocal) return false;
  const suffix = parsed.descriptors.at(-1)?.suffix;
  return suffix === "method" || suffix === "macro";
}

// ---------------------------------------------------------------------------
// SCIP SymbolInformation.Kind -> leina NodeKind. `Kind` is scip.proto's single
// GLOBAL enum (same numeric value means the same thing across every
// language's indexer), but which numbers a language actually EMITS — and
// which of leina's NodeKinds each one should become — differs per language,
// mirroring what treesitter.ts's `CONFIGS[lang]` already decides to emit a
// node for. Hence `kindToNode` lives per-language inside `SCIP_CONFIGS`
// (below), never as a single global table: reusing one global map risks
// either dropping nodes a language DOES emit (e.g. Go has no `Trait`) or
// inventing surplus nodes tree-sitter would never produce for that language.
// Entities intentionally left unmapped for every language — Field/Package/
// Variable/MethodSpecification/etc. — get no node, matching tree-sitter's
// configs exactly (interface method elements and struct fields never become
// nodes there either).
// ---------------------------------------------------------------------------

const SCIP_KIND_CLASS = 7; // Class
const SCIP_KIND_FUNCTION = 17; // Function
const SCIP_KIND_INTERFACE = 21; // Interface
const SCIP_KIND_METHOD = 26; // Method
const SCIP_KIND_STRUCT = 49; // Struct
const SCIP_KIND_ENUM = 11; // Enum (Rust)
const SCIP_KIND_TRAIT = 53; // Trait (Rust)
const SCIP_KIND_UNION = 59; // Union (Rust)
const SCIP_KIND_TRAIT_METHOD = 70; // TraitMethod (Rust)
const SCIP_KIND_STATIC_METHOD = 80; // StaticMethod (Rust)

/**
 * Per-language configuration mirroring treesitter.ts's `CONFIGS: Record<Lang,
 * LanguageConfig>` — every language-specific decision (kind->node mapping,
 * fallback NodeKind when `kind` is unset, the Rust `impl` self-type rewrite,
 * Python's nested-function flattening, file extensions, and how the indexer
 * is invoked/where its output lands) is resolved by reading this table, never
 * by scattered `if (lang === ...)` branches.
 */
export interface ScipLangConfig {
  /** Default binary name detected in PATH (see `resolveScipIndexer`). */
  bin: string;
  /** Env var name that overrides `bin` with an explicit argv (space-separated). */
  env: string;
  /** File extensions this language's indexer claims (mirrors `detect.ts`). */
  extensions: Set<string>;
  /** Build the indexer's argv; `out` is the ephemeral `tmpDir/index.scip` path
   * every currently-wired indexer (scip-go, rust-analyzer, scip-python) accepts
   * via an explicit output flag — confirmed empirically for all three (see
   * `runScipIndexer`'s doc comment; scip-python was assumed in Ola A design to
   * have NO output flag, corrected in Ola C task C1.3 once the real binary was
   * exercised: `scip-python index --output <path>` works exactly like Go/Rust). */
  argv(out: string): string[];
  /** `SymbolInformation.kind` -> NodeKind, populated only with kinds this
   * language's indexer actually emits and tree-sitter would also model. */
  kindToNode: Record<number, NodeKind>;
  /** NodeKind fallback for a final `type`-suffixed descriptor when
   * `kind === 0` (scip-python never sets `kind`; see the fallback rule in
   * `deriveDefinitionNodesAndEdges`). */
  typeFallback: NodeKind;
  /** Rust: rewrite the synthetic `impl` descriptor to its self-type before
   * folding the id chain (see `normalizeImpl`). */
  implSelfType: boolean;
  /** Python: flatten nested functions by dropping non-final `method`-suffixed
   * owners from the id chain (see `idChain`). */
  flattenNestedFns: boolean;
}

/** Every language `SCIP_CONFIGS` knows how to translate — go/rust/python, all
 * three with a green id-parity gate (`test/scip-id-parity-<lang>.test.ts`)
 * and wired end-to-end (`WIRED_SCIP_LANGS` below). Ruby is backlog (see
 * `backlog/scip-ruby-deferred`), not part of this type. */
export type ScipLang = "go" | "rust" | "python";

/** The subset of `ScipLang` actually wired end-to-end today (registry order,
 * CLI surface, doctor check, docs) — the single source of truth both
 * `system.ts`'s `leina scip` CLI group and `doctor.ts`'s `checkScipIndexers`
 * read from, so neither hardcodes its own per-language list. Grows by one
 * entry per language, each time ONLY after that language's id-parity gate
 * (`test/scip-id-parity-<lang>.test.ts`) goes green — never speculatively. */
export const WIRED_SCIP_LANGS = ["go", "rust", "python"] as const satisfies readonly ScipLang[];

const SCIP_CONFIGS: Record<ScipLang, ScipLangConfig> = {
  go: {
    bin: "scip-go",
    env: "LEINA_SCIP_GO_INDEXER",
    extensions: new Set([".go"]),
    argv: (out) => ["index", "--output", out, "./..."],
    kindToNode: {
      [SCIP_KIND_CLASS]: "class",
      [SCIP_KIND_STRUCT]: "class",
      [SCIP_KIND_INTERFACE]: "interface",
      [SCIP_KIND_FUNCTION]: "function",
      [SCIP_KIND_METHOD]: "method",
    },
    typeFallback: "class",
    implSelfType: false,
    flattenNestedFns: false,
  },
  // Rust (rust-analyzer): `kind` IS reliably populated (unlike Python), but
  // `impl` blocks need the self-type rewrite (`normalizeImpl`) — see
  // sdd/scip-lang-rollout explore hallazgo #3. Gate: green (wave B,
  // test/scip-id-parity-rust.test.ts, real test/fixtures/scip/rust/
  // 2-crate workspace) — wired in WIRED_SCIP_LANGS above.
  rust: {
    bin: "rust-analyzer",
    env: "LEINA_SCIP_RUST_INDEXER",
    extensions: new Set([".rs"]),
    argv: (out) => ["scip", ".", "--output", out],
    kindToNode: {
      [SCIP_KIND_STRUCT]: "class",
      [SCIP_KIND_ENUM]: "class",
      [SCIP_KIND_UNION]: "class",
      [SCIP_KIND_CLASS]: "class",
      [SCIP_KIND_TRAIT]: "interface",
      [SCIP_KIND_FUNCTION]: "function",
      [SCIP_KIND_METHOD]: "method",
      [SCIP_KIND_TRAIT_METHOD]: "method",
      [SCIP_KIND_STATIC_METHOD]: "method",
    },
    typeFallback: "class",
    implSelfType: true,
    flattenNestedFns: false,
  },
  // Python (scip-python): NEVER sets `kind` (always 0) — every definition
  // relies on the suffix-based fallback. Empirically confirmed in Ola C
  // (task C1.3, real `@sourcegraph/scip-python` 0.6.6): CONTRARY to the Ola A
  // design assumption ("no explicit --output flag"), `scip-python index`
  // DOES accept `--output <path>` (defaults to `index.scip` under `--cwd`
  // only when omitted) — so python needs no `cwd-default` special-casing at
  // all; it uses the exact same explicit-flag shape as Go/Rust.
  // `--project-version` is forced to a fixed dummy value because scip-python
  // otherwise shells out to `git rev-parse` to default it, and THROWS
  // (`normalizeNameOrVersion` on `undefined`) when the indexed directory
  // isn't inside a git repository — the package/version fields are parsed
  // and immediately discarded by `splitScipHead` regardless, so the
  // fixed value has zero effect on any derived id. `display_name` is ALSO
  // never populated (confirmed) — `deriveDefinitionNodesAndEdges` falls back
  // to the chain's own final descriptor name for the label in that case.
  // Gate: green (wave C, test/scip-id-parity-python.test.ts, real
  // test/fixtures/scip/python/ single-root project) — wired in
  // WIRED_SCIP_LANGS above.
  python: {
    bin: "scip-python",
    env: "LEINA_SCIP_PYTHON_INDEXER",
    extensions: new Set([".py", ".pyi"]),
    argv: (out) => ["index", "--output", out, "--project-version=0.0.0"],
    kindToNode: {},
    typeFallback: "class",
    implSelfType: false,
    flattenNestedFns: true,
  },
};

/** File extensions `lang`'s SCIP indexer claims (mirrors `detect.ts`) — the
 * single source of truth `ScipExtractor.supports()` (scip.ts) reads from,
 * instead of keeping a second, independently-maintained extension table. */
export function scipExtensionsFor(lang: ScipLang): Set<string> {
  return SCIP_CONFIGS[lang].extensions;
}

/** `SymbolInformation.kind === 0` fallback (scip-python never sets `kind`):
 * derive a NodeKind from the FINAL descriptor of the already-resolved id
 * chain (post `normalizeImpl`/flatten) — a `type`-suffixed final descriptor
 * maps to `cfg.typeFallback`; a `method`-suffixed one maps to `"method"` when
 * an owner exists (chain length >= 2) or `"function"` otherwise (a bare
 * function has no owner in the chain). Every other final suffix (`term`,
 * `meta`, `macro`) is intentionally left unmapped — no node, same principle
 * as the `kindToNode` tables above. */
function fallbackKind(cfg: ScipLangConfig, chain: ScipDescriptor[]): NodeKind | undefined {
  const last = chain.at(-1);
  if (!last) return undefined;
  if (last.suffix === "type") return cfg.typeFallback;
  if (last.suffix === "method") return chain.length >= 2 ? "method" : "function";
  return undefined;
}

// ---------------------------------------------------------------------------
// Range containment — used to derive `calls` edges: for each Reference
// occurrence, find the Definition occurrence whose `enclosingRange` contains
// it (mirrors treesitter.ts's `walk`/`enclosingDefId`).
// ---------------------------------------------------------------------------

function comparePos(l1: number, c1: number, l2: number, c2: number): number {
  return l1 !== l2 ? l1 - l2 : c1 - c2;
}

function rangeContains(outer: ScipRange, inner: ScipRange): boolean {
  return (
    comparePos(inner.startLine, inner.startCharacter, outer.startLine, outer.startCharacter) >= 0 &&
    comparePos(inner.endLine, inner.endCharacter, outer.endLine, outer.endCharacter) <= 0
  );
}

function rangeSpan(r: ScipRange): number {
  return (r.endLine - r.startLine) * 1_000_000 + (r.endCharacter - r.startCharacter);
}

function locOf(range: ScipRange | null): string | undefined {
  return range ? `L${range.startLine + 1}` : undefined;
}

interface EnclosingDef {
  id: string;
  enclosingRange: ScipRange;
}

/** Every Definition occurrence that both translates to a node id AND carries
 * an `enclosingRange` (the span callers can be "inside"). */
function collectEnclosingDefs(doc: ScipDocument, lang: ScipLang): EnclosingDef[] {
  const defs: EnclosingDef[] = [];
  for (const occ of doc.occurrences) {
    if ((occ.symbolRoles & SYMBOL_ROLE_DEFINITION) === 0) continue;
    if (!occ.enclosingRange) continue;
    const id = translateScipSymbol(doc, occ.symbol, lang);
    if (id) defs.push({ id, enclosingRange: occ.enclosingRange });
  }
  return defs;
}

function findEnclosingDef(defs: EnclosingDef[], occ: ScipOccurrence): EnclosingDef | null {
  if (!occ.range) return null;
  let best: EnclosingDef | null = null;
  for (const def of defs) {
    if (!rangeContains(def.enclosingRange, occ.range)) continue;
    if (!best || rangeSpan(def.enclosingRange) < rangeSpan(best.enclosingRange)) best = def;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Full per-Document graph derivation
// ---------------------------------------------------------------------------

export interface ScipDocumentGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Derive leina graph nodes/edges from a single SCIP Document: one node per
 * translatable definition (file + class/interface/function/method), a
 * `contains`/`method` edge from its owner, `calls` edges by range containment,
 * and `extends`/`implements` edges straight from `relationships[]`. Every
 * edge/node carries `confidence: "EXTRACTED"` — this never feeds
 * `resolveSymbols()` (no `rawCalls`/`imports` are produced at all).
 */
export function deriveScipDocumentGraph(doc: ScipDocument, lang: ScipLang): ScipDocumentGraph {
  const fileId = makeId(doc.relativePath);
  const fileNode: GraphNode = { id: fileId, label: doc.relativePath, fileType: "code", sourceFile: doc.relativePath, kind: "module" };
  const defRanges = collectDefRanges(doc);

  const { nodes: defNodes, edges: defEdges } = deriveDefinitionNodesAndEdges(doc, fileId, defRanges, lang);
  const heritageEdges = deriveHeritageEdges(doc, defRanges, lang);
  const nodeIds = new Set([fileId, ...defNodes.map((n) => n.id)]);
  const callEdges = deriveCallEdges(doc, lang, nodeIds);

  return { nodes: [fileNode, ...defNodes], edges: [...defEdges, ...heritageEdges, ...callEdges] };
}

/** symbol string -> its own (small) definition range, used for `sourceLocation`. */
function collectDefRanges(doc: ScipDocument): Map<string, ScipRange> {
  const defRanges = new Map<string, ScipRange>();
  for (const occ of doc.occurrences) {
    if ((occ.symbolRoles & SYMBOL_ROLE_DEFINITION) === 0 || !occ.range) continue;
    if (!defRanges.has(occ.symbol)) defRanges.set(occ.symbol, occ.range);
  }
  return defRanges;
}

/** One node + one `contains`/`method` edge per translatable, kind-recognized
 * `SymbolInformation` — mirrors treesitter.ts's `emitDef`. `kind` comes from
 * `cfg.kindToNode[sym.kind]` when populated (`sym.kind !== 0`), else from the
 * suffix-based `fallbackKind` (scip-python never populates `kind`). */
function deriveDefinitionNodesAndEdges(
  doc: ScipDocument,
  fileId: string,
  defRanges: Map<string, ScipRange>,
  lang: ScipLang,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const cfg = SCIP_CONFIGS[lang];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const sym of doc.symbols) {
    const translated = translateWithOwner(doc, sym.symbol, lang);
    if (!translated) continue;
    const kind = sym.kind !== 0 ? cfg.kindToNode[sym.kind] : fallbackKind(cfg, translated.chain);
    if (!kind) continue;
    // scip-python never populates `displayName` (confirmed empirically,
    // Ola C task C1.3, unlike scip-go/rust-analyzer) — fall back to the
    // already-resolved chain's final descriptor name, which IS always the
    // real identifier (Rust's `normalizeImpl` already rewrote it to the
    // self-type where applicable), rather than emitting a blank label.
    const name = sym.displayName || translated.chain.at(-1)?.name || sym.displayName;
    const label = kind === "function" || kind === "method" ? `${name}()` : name;
    const sourceLocation = locOf(defRanges.get(sym.symbol) ?? null);
    nodes.push({ id: translated.id, label, fileType: "code", sourceFile: doc.relativePath, sourceLocation, kind });
    edges.push({
      source: translated.ownerId ?? fileId,
      target: translated.id,
      relation: translated.ownerId ? "method" : "contains",
      confidence: "EXTRACTED",
      sourceFile: doc.relativePath,
      sourceLocation,
      weight: 1,
    });
  }
  return { nodes, edges };
}

/** `extends`/`implements` edges straight from `SymbolInformation.relationships[]`. */
function deriveHeritageEdges(doc: ScipDocument, defRanges: Map<string, ScipRange>, lang: ScipLang): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const sym of doc.symbols) {
    for (const rel of sym.relationships) {
      if (!rel.isImplementation && !rel.isTypeDefinition) continue;
      const sourceId = translateScipSymbol(doc, sym.symbol, lang);
      const targetId = translateScipSymbol(doc, rel.symbol, lang);
      if (!sourceId || !targetId) continue;
      edges.push({
        source: sourceId,
        target: targetId,
        relation: rel.isImplementation ? "implements" : "extends",
        confidence: "EXTRACTED",
        sourceFile: doc.relativePath,
        sourceLocation: locOf(defRanges.get(sym.symbol) ?? null),
        weight: 1,
      });
    }
  }
  return edges;
}

/** `calls` edges by range containment: for each callable Reference occurrence,
 * find the Definition whose `enclosingRange` contains it. `nodeIds` (every id
 * actually derived by `deriveDefinitionNodesAndEdges`, plus the file id) guards
 * against orphan edges — e.g. a Rust macro invocation (`isCallableSymbol` now
 * accepts `macro`) whose definition has no translatable node must not produce
 * a `calls` edge to a target that doesn't exist in this graph. */
function deriveCallEdges(doc: ScipDocument, lang: ScipLang, nodeIds: Set<string>): GraphEdge[] {
  const enclosingDefs = collectEnclosingDefs(doc, lang);
  const edges: GraphEdge[] = [];
  for (const occ of doc.occurrences) {
    if ((occ.symbolRoles & SYMBOL_ROLE_DEFINITION) !== 0) continue; // reference occurrences only
    if (!isCallableSymbol(occ.symbol)) continue;
    const from = findEnclosingDef(enclosingDefs, occ);
    const toId = translateScipSymbol(doc, occ.symbol, lang);
    if (!from || !toId || !nodeIds.has(toId)) continue;
    edges.push({
      source: from.id,
      target: toId,
      relation: "calls",
      confidence: "EXTRACTED",
      sourceFile: doc.relativePath,
      sourceLocation: locOf(occ.range),
      weight: 1,
    });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Indexer detection — the SCIP equivalent of `resolveSidecar` (sidecar.ts).
// Indexers are third-party binaries the user installs (npm/cargo/go install/
// etc.); leina only DETECTS them in PATH (or an explicit env override), never
// downloads/builds/auto-installs one — same "detect + instruct" contract the
// existing sidecars use. (`ScipLang`/`SCIP_CONFIGS` are declared above, next
// to `fallbackKind`, since `idChain` already needs `SCIP_CONFIGS` earlier in
// the file.)
// ---------------------------------------------------------------------------

function commandExists(bin: string): boolean {
  const probe = spawnSync(bin, ["--version"], { stdio: "ignore" });
  // ENOENT (binary not found in PATH) surfaces via `probe.error`; any other
  // outcome (zero or non-zero exit, unsupported flag, etc.) still proves the
  // binary itself was found and executed.
  const err = probe.error;
  return !err || !("code" in err) || err.code !== "ENOENT";
}

/**
 * Resolve how to invoke the SCIP indexer for `lang`: an explicit env override
 * first (space-separated argv, mirroring `resolveSidecar`), else the default
 * binary name detected in PATH. Returns argv parts, or null when unavailable
 * (caller should print detect+instruct and fall back to tree-sitter).
 */
export function resolveScipIndexer(lang: ScipLang): string[] | null {
  const cfg = SCIP_CONFIGS[lang];
  const override = process.env[cfg.env];
  if (override && override.trim().length > 0) return override.trim().split(/\s+/);
  return commandExists(cfg.bin) ? [cfg.bin] : null;
}

// ---------------------------------------------------------------------------
// Whole-project invocation — spawn the indexer against `root`, stream the
// resulting `.scip` Document-by-Document, and fold every Document into one
// combined nodes/edges set (mirrors `runSemanticSidecarProject` in
// sidecar.ts, except the "compiler" here is an out-of-process third-party
// binary that writes a file rather than one that prints JSON to stdout).
// ---------------------------------------------------------------------------

export interface ScipIndexerRunResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Invoke the SCIP indexer for `lang` against the WHOLE project at `root`
 * (analogous to `runSemanticSidecarProject`): spawns the indexer (always with
 * `cwd: root`, so `relative_path` in the resulting `.scip` comes out
 * root-relative for every language — confirmed against scip-ruby's
 * `lexically_relative(cwd)`, and empirically against scip-go/rust-analyzer/
 * scip-python directly), writes its output to an explicit `--output
 * <tmpDir>/index.scip` flag (every currently-wired indexer accepts one —
 * confirmed for all three in waves A-C; a future indexer with NO output flag
 * would need its own strategy, not assumed speculatively here), streams that
 * file Document-by-Document via `readScipDocuments`, folds every Document
 * into one combined `{nodes, edges}` set via `deriveScipDocumentGraph`, and
 * ALWAYS deletes the ephemeral tempdir (success or failure) before
 * returning — the project `root` itself is never written to.
 *
 * Returns `null` when the indexer isn't available, the spawn failed (non-zero
 * exit), it produced no output file, or the index contained symbols but
 * yielded ZERO translatable definition nodes (fail-closed guard — see
 * `deriveDefinitionNodesAndEdges`/`fallbackKind`: an index that translates
 * nothing must never be treated as "a valid empty index", or the file would
 * be silently claimed and tree-sitter would never get a chance to process
 * it). Callers treat any `null` as "this extractor did not claim these
 * files" and let tree-sitter take over. Never throws for those cases; a
 * genuinely unexpected error (e.g. a malformed `.scip` byte stream)
 * propagates so the caller's try/catch can log it.
 */
export function runScipIndexer(lang: ScipLang, root: string): ScipIndexerRunResult | null {
  const argv = resolveScipIndexer(lang);
  if (!argv) return null;

  const cfg = SCIP_CONFIGS[lang];
  const tmpDir = mkdtempSync(join(tmpdir(), `leina-scip-${lang}-`));
  try {
    const outFile = join(tmpDir, "index.scip");
    const [bin, ...prefixArgs] = argv;
    const proc = spawnSync(bin!, [...prefixArgs, ...cfg.argv(outFile)], {
      cwd: root,
      encoding: "utf8",
    });
    if (proc.status !== 0) return null;
    if (!existsSync(outFile)) return null;

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    let sawSymbols = false;
    let sawDefNodes = false;
    for (const doc of readScipDocuments(outFile)) {
      if (doc.symbols.length > 0) sawSymbols = true;
      const graph = deriveScipDocumentGraph(doc, lang);
      if (graph.nodes.length > 1) sawDefNodes = true; // >1: more than just the file node
      nodes.push(...graph.nodes);
      edges.push(...graph.edges);
    }
    // Fail-closed: symbols existed but NONE translated to a node — most
    // likely a kind/fallback gap for this language, not "an empty file".
    // Claiming it here would silently drop the whole file's graph forever
    // (tree-sitter never gets a turn); returning null lets it take over.
    if (sawSymbols && !sawDefNodes) return null;
    return { nodes, edges };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
