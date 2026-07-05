// application/workspace/cross-repo-linker.ts
// Links cross-repo dependencies by indexing published package manifests AND
// scanning source files directly for import statements.
//
// Supported manifest types:
//   - package.json   → "name" field (npm/Node packages)
//   - pom.xml        → groupId:artifactId (Maven/Java)
//   - *.csproj       → AssemblyName element (C#/.NET)
//
// Confidence ladder (FR-09/NFR-04):
//   EXTRACTED  — exact name↔remote match (found package name in imports with exact match)
//   INFERRED   — import path hint (module path matches package name heuristically)
//   AMBIGUOUS  — multiple repos could match (N>1 package names match the import)
//
// Two scanning strategies (combined for maximum coverage):
//   1. Graph edge scan: find `imports` edges where target node has kind="module"
//      and label is the package name (works for tree-sitter extracted repos).
//   2. Source file scan: regex scan TS/JS/Python source files for import statements
//      (works for ts-morph extracted repos where module nodes are NOT created).
//
// Use-site anchoring (FU#2): in the source-file scan, cross-repo edges are anchored at
// the function/method that USES the imported symbol (function-to-function), not at the
// importing file node. Resolution is heuristic/SYNTACTIC across all supported languages;
// when no use-site function can be resolved the edge falls back to the file node.
//
// IMPORTANT: Relative imports (`./x`, `../y`) are NEVER cross-repo (SC-11).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { GraphEdge, GraphNode } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import type { WorkspaceMember } from "../project/detect-key.ts";
import { makeId, normalizeLabel } from "../../domain/shared/id.ts";

export type PkgEvidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

interface PkgEntry {
  repoKey: string;
  packageName: string; // the published name (e.g. "@acme/payments" or "com.acme:payments")
}

interface ParsedImport {
  module: string;
  names: string[];  // named exports being imported, empty = namespace/default/unknown
}

// ---------------------------------------------------------------------------
// Manifest readers (pure I/O, no extraction engine)
// ---------------------------------------------------------------------------

function readPackageName(repoDir: string): string | null {
  const p = join(repoDir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const obj = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    return typeof obj.name === "string" ? obj.name : null;
  } catch {
    return null;
  }
}

function readPomArtifact(repoDir: string): string | null {
  const p = join(repoDir, "pom.xml");
  if (!existsSync(p)) return null;
  try {
    const xml = readFileSync(p, "utf8");
    const groupMatch = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(xml);
    const artifactMatch = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(xml);
    const group = groupMatch?.[1];
    const artifact = artifactMatch?.[1];
    if (group && artifact) return `${group}:${artifact}`;
    return null;
  } catch {
    return null;
  }
}

function readCsprojName(repoDir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(repoDir).filter((f) => f.endsWith(".csproj"));
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const xml = readFileSync(join(repoDir, file), "utf8");
      const m = /<AssemblyName>\s*([^<\s]+)\s*<\/AssemblyName>/.exec(xml);
      if (m?.[1]) return m[1];
    } catch {
      // skip
    }
  }
  return null;
}

function resolvePackageName(repoDir: string): string | null {
  return readPackageName(repoDir) ?? readPomArtifact(repoDir) ?? readCsprojName(repoDir);
}

// ---------------------------------------------------------------------------
// Index builder
// ---------------------------------------------------------------------------

/** packageName → array of repoKeys that publish it */
function buildPackageIndex(members: WorkspaceMember[]): Map<string, PkgEntry[]> {
  const index = new Map<string, PkgEntry[]>();
  for (const m of members) {
    const name = resolvePackageName(m.dir);
    if (!name) continue;
    const existing = index.get(name);
    const entry: PkgEntry = { repoKey: m.repoKey, packageName: name };
    if (existing) existing.push(entry);
    else index.set(name, [entry]);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Cross-repo import matching helpers
// ---------------------------------------------------------------------------

/**
 * Is this an intra-repo relative import? Relative imports NEVER cross repos (SC-11).
 */
function isRelativeImport(module: string): boolean {
  return module.startsWith("./") || module.startsWith("../");
}

/**
 * Does an import module string match a published package name?
 * EXTRACTED: exact match or sub-path (e.g. "@acme/payments/utils" matches "@acme/payments")
 * INFERRED:  last segment of module matches last segment of package name
 */
function matchConfidence(importModule: string, packageName: string): PkgEvidence | null {
  // Exact or sub-path match → EXTRACTED
  if (importModule === packageName || importModule.startsWith(`${packageName  }/`)) {
    return "EXTRACTED";
  }
  // Heuristic: last segment of module matches last segment of package name
  const modSeg = importModule.split("/").at(-1)?.toLowerCase();
  const pkgSeg = packageName.split(/[:/]/).at(-1)?.toLowerCase();
  if (modSeg && pkgSeg && modSeg === pkgSeg) {
    return "INFERRED";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source file scanning (Strategy 2: for ts-morph extracted repos)
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".cs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".leina", "dist", "build", "out", "__pycache__"]);

/** Recursively list source files in a directory. */
function listSourceFiles(dir: string): string[] {
  const result: string[] = [];
  function walk(d: string): void {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(d, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const ext = entry.slice(entry.lastIndexOf("."));
        if (SOURCE_EXTS.has(ext)) result.push(full);
      }
    }
  }
  walk(dir);
  return result;
}

/** Collect single-capture-group module imports (java/cs/py bare `import`). */
function collectModuleImports(source: string, re: RegExp): ParsedImport[] {
  const imports: ParsedImport[] = [];
  for (const m of source.matchAll(re)) {
    if (m[1]) imports.push({ module: m[1], names: [] });
  }
  return imports;
}

/** Parse the named-export groups of an ES import into a flat name list. */
function parseEsImportNames(
  group1: string | undefined,
  group4: string | undefined,
  defaultName: string | undefined,
): string[] {
  const names: string[] = [];
  for (const grp of [group1, group4]) {
    if (!grp) continue;
    for (const n of grp.split(",")) {
      const trimmed = n.trim().split(/\s+as\s+/)[0]?.trim();
      if (trimmed && trimmed !== "type") names.push(trimmed);
    }
  }
  if (defaultName) names.push(defaultName); // default import name
  return names;
}

/** Parse the import list of a Python `from … import …` statement. */
function parsePyImportNames(list: string | undefined): string[] {
  const names: string[] = [];
  for (const n of (list ?? "").replaceAll(/[()]/g, "").split(",")) {
    const t = n.trim().split(/\s+as\s+/)[0]?.trim();
    if (t && t !== "*") names.push(t);
  }
  return names;
}

/** Parse import statements from TypeScript/JavaScript source text. */
function parseTsJsImports(source: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  // ES module: import { a, b } from "pkg"
  // ES module: import * as foo from "pkg"
  // ES module: import foo from "pkg"
  // ES module: import "pkg"
  const esRe =
    // eslint-disable-next-line security/detect-unsafe-regex -- reviewed: optional groups are disjoint; input is local source text
    /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))?\s*(?:,\s*(?:\{([^}]*)\}))?\s*from\s+['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(esRe)) {
    const module = m[5];
    if (!module) continue;
    imports.push({ module, names: parseEsImportNames(m[1], m[4], m[3]) });
  }
  // Side-effect import: import "pkg"
  const sideEffectRe = /import\s+['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(sideEffectRe)) {
    if (m[1] && !imports.some((i) => i.module === m[1])) {
      imports.push({ module: m[1], names: [] });
    }
  }
  // CommonJS: require("pkg")
  const reqRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  return imports.concat(collectModuleImports(source, reqRe));
}

/** Parse import statements from Python source text. */
function parsePyImports(source: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  // from pkg import a, b   (import list is restricted to the same line — `.` does
  // NOT match a newline, so the capture cannot bleed into following statements)
  const fromRe = /from\s+([\w.]+)\s+import\s+([^\n#]+)/g;
  for (const m of source.matchAll(fromRe)) {
    const module = m[1];
    if (!module) continue;
    imports.push({ module, names: parsePyImportNames(m[2]) });
  }
  // import pkg
  return imports.concat(collectModuleImports(source, /^import\s+([\w.]+)/gm));
}

/** Parse import statements from TypeScript/JavaScript/Python source text. */
function parseImports(source: string, lang: "ts" | "js" | "py" | "java" | "cs"): ParsedImport[] {
  switch (lang) {
    case "ts":
    case "js":
      return parseTsJsImports(source);
    case "py":
      return parsePyImports(source);
    case "java":
      // eslint-disable-next-line security/detect-unsafe-regex -- reviewed: [\w.]+ vs optional .* is bounded backtracking; input is local source text
      return collectModuleImports(source, /import\s+(?:static\s+)?([\w.]+)(?:\.\*)?;/g);
    case "cs":
      return collectModuleImports(source, /using\s+([\w.]+);/g);
  }
}

function extToLang(absPath: string): "ts" | "js" | "py" | "java" | "cs" | null {
  const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "ts";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "js";
  if (ext === ".py") return "py";
  if (ext === ".java") return "java";
  if (ext === ".cs") return "cs";
  return null;
}

// ---------------------------------------------------------------------------
// Use-site resolution (FU#2): anchor cross-repo edges at the function/method that
// actually USES an imported symbol, instead of the importing file node. This gives
// function-to-function cross-repo chains (precise source->sink tracing) instead of
// file-to-symbol. Heuristic/SYNTACTIC across all supported languages; callers MUST
// fall back to the file node when no use-site function can be resolved.
// ---------------------------------------------------------------------------

/** A function/method body span discovered in a source file: [start, end) char offsets. */
interface FnSpan {
  name: string;
  start: number;
  end: number;
}

/** C-family keywords that look like `name(...) {` but are NOT function declarations. */
const CFAMILY_NON_FN = new Set([
  "if", "for", "while", "switch", "catch", "do", "else", "return", "typeof",
  "await", "new", "function", "with", "using", "lock", "fixed", "foreach",
]);

/** Find the matching `}` for the `{` at index `open`; returns index just past it, or source.length. */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/** Extract function/method body spans from C-family source (ts/js/java/cs). */
function extractCFamilySpans(source: string): FnSpan[] {
  const spans: FnSpan[] = [];

  // `name ( params ) ... {`  — function declarations, methods, ctors.
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed: adjacent \s* ambiguity is at worst quadratic; input is local source text
  const declRe = /([A-Za-z_$][\w$]*)\s*(?:<[^<>(){}]*>)?\s*\(([^()]*)\)\s*(?::\s*[^={};]+)?\s*\{/g;
  for (const m of source.matchAll(declRe)) {
    const name = m[1]!;
    if (CFAMILY_NON_FN.has(name)) continue;
    const open = m.index + m[0].length - 1; // position of the `{`
    spans.push({ name, start: m.index, end: matchBrace(source, open) });
  }

  // `name = (params) => {`  — arrow assignments / fields with block body.
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed: adjacent \s* ambiguity is at worst quadratic; input is local source text
  const arrowRe = /([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(([^()]*)\)\s*(?::\s*[^={};]+)?=>\s*\{/g;
  for (const m of source.matchAll(arrowRe)) {
    const name = m[1]!;
    if (CFAMILY_NON_FN.has(name)) continue;
    const open = m.index + m[0].length - 1;
    spans.push({ name, start: m.index, end: matchBrace(source, open) });
  }

  return spans;
}

/** Extract `def` body spans from Python source, bounded by indentation. */
function extractPythonSpans(source: string): FnSpan[] {
  const spans: FnSpan[] = [];
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed: line-anchored, linear; input is local source text
  const defRe = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm;
  for (const m of source.matchAll(defRe)) {
    const indent = m[1]!.length;
    const name = m[2]!;
    const start = m.index;
    // Body ends at the first subsequent non-blank line whose indentation is <= def indent.
    let end = source.length;
    const bodyStart = source.indexOf("\n", start);
    if (bodyStart !== -1) {
      const lineRe = /^([ \t]*)(\S)/gm;
      lineRe.lastIndex = bodyStart + 1;
      let lm: RegExpExecArray | null;
      while ((lm = lineRe.exec(source)) !== null) {
        if (lm[1]!.length <= indent) {
          end = lm.index;
          break;
        }
      }
    }
    spans.push({ name, start, end });
  }
  return spans;
}

/** Extract function/method spans from source text for a given language. */
function extractFnSpans(source: string, lang: "ts" | "js" | "py" | "java" | "cs"): FnSpan[] {
  return lang === "py" ? extractPythonSpans(source) : extractCFamilySpans(source);
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the set of function names that USE any of `names` (word-boundary references)
 * within their body. Names referenced only at module top-level (e.g. the import
 * statement itself) belong to no span and are therefore excluded — the caller falls
 * back to file-level anchoring for those.
 */
function findFunctionsUsingNames(
  spans: FnSpan[],
  source: string,
  names: string[],
): string[] {
  if (spans.length === 0 || names.length === 0) return [];
  const result = new Set<string>();
  for (const name of names) {
    if (name) addFunctionsReferencingName(result, spans, source, name);
  }
  return [...result];
}

/** Innermost span containing `off` wins (handles nested functions); null if none. */
function innermostSpanAt(spans: FnSpan[], off: number): FnSpan | null {
  let best: FnSpan | null = null;
  for (const sp of spans) {
    if (off >= sp.start && off < sp.end && (!best || sp.start > best.start)) best = sp;
  }
  return best;
}

/** Add to `result` the name of every function whose body references `name`. */
function addFunctionsReferencingName(
  result: Set<string>,
  spans: FnSpan[],
  source: string,
  name: string,
): void {
  // eslint-disable-next-line security/detect-non-literal-regexp -- name is escapeRegExp()-escaped
  const useRe = new RegExp(String.raw`\b${escapeRegExp(name)}\b`, "g");
  for (const m of source.matchAll(useRe)) {
    const best = innermostSpanAt(spans, m.index);
    if (best) result.add(best.name);
  }
}

// ---------------------------------------------------------------------------
// Node lookup helpers
// ---------------------------------------------------------------------------

/** Normalize a repo key for use as a merged-store ID prefix (same logic as merged-store.ts). */
function normalizeKeyForPrefix(repoKey: string): string {
  return (
    repoKey
      .normalize("NFKC")
      .toLowerCase()
      .replaceAll(/[/\\:]+/g, "-")
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/(^-+)|(-+$)/g, "") || "project"
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Link cross-repo dependencies into the merged GraphRepository.
 *
 * Two complementary strategies:
 *  1. Graph-edge scan: find `imports`/`imports_from` edges in merged store where
 *     the target node has kind="module" and its label is a known package name
 *     (works for tree-sitter extracted repos).
 *  2. Source-file scan: directly parse import statements from member source files
 *     (works for ts-morph extracted repos that do NOT create module nodes).
 *
 * Both strategies create cross-repo edges and add them to the merged store.
 *
 * @returns All generated cross-repo GraphEdge objects (for reporting).
 */
export function linkCrossRepo(
  merged: GraphRepository,
  members: WorkspaceMember[],
): GraphEdge[] {
  const pkgIndex = buildPackageIndex(members);
  if (pkgIndex.size === 0) return [];

  const ctx = createLinkContext(pkgIndex, merged.allNodes());

  // Strategy 1: Graph-edge scan (tree-sitter imported repos)
  for (const edge of merged.allEdges()) processImportEdge(ctx, edge);

  // Strategy 2: Source-file scan (ts-morph extracted repos)
  for (const member of members) scanMemberSources(ctx, member);

  return ctx.crossEdges;
}

// ---------------------------------------------------------------------------
// Linking context + node index construction
// ---------------------------------------------------------------------------

/** Mutable state shared across both linking strategies. */
interface LinkContext {
  pkgIndex: Map<string, PkgEntry[]>;
  allNodes: GraphNode[];
  nodeById: Map<string, GraphNode>;
  nodesByRepoAndLabel: Map<string, Map<string, string[]>>; // repoKey → normalizedLabel → [nodeId]
  nodesByRepoAndFile: Map<string, Map<string, string[]>>;  // repoKey → relPath → [nodeId]
  idToRepo: Map<string, string>;
  crossEdges: GraphEdge[];
  seen: Set<string>; // dedup key
}

/** Append `value` to the list at `key`, creating the list when absent. */
function pushToMapList(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Get (or lazily create) the inner per-repo map. */
function getRepoMap(
  outer: Map<string, Map<string, string[]>>,
  repo: string,
): Map<string, string[]> {
  let inner = outer.get(repo);
  if (!inner) {
    inner = new Map();
    outer.set(repo, inner);
  }
  return inner;
}

/** Index a single node into the label/file/id lookup maps. */
function indexNode(ctx: LinkContext, n: GraphNode): void {
  ctx.nodeById.set(n.id, n);
  const repo = n.repo ?? "";
  ctx.idToRepo.set(n.id, repo);
  pushToMapList(getRepoMap(ctx.nodesByRepoAndLabel, repo), normalizeLabel(n.label), n.id);
  pushToMapList(getRepoMap(ctx.nodesByRepoAndFile, repo), n.sourceFile, n.id);
}

/** Build the linking context and its lookup maps from all merged nodes. */
function createLinkContext(
  pkgIndex: Map<string, PkgEntry[]>,
  allNodes: GraphNode[],
): LinkContext {
  const ctx: LinkContext = {
    pkgIndex,
    allNodes,
    nodeById: new Map(),
    nodesByRepoAndLabel: new Map(),
    nodesByRepoAndFile: new Map(),
    idToRepo: new Map(),
    crossEdges: [],
    seen: new Set(),
  };
  for (const n of allNodes) indexNode(ctx, n);
  return ctx;
}

// ---------------------------------------------------------------------------
// Edge construction + node resolution helpers
// ---------------------------------------------------------------------------

/**
 * Add a cross-repo edge, de-duplicating and normalizing confidence.
 * If multiple repos publish the same package, use AMBIGUOUS.
 */
function addCrossEdge(
  ctx: LinkContext,
  sourceId: string,
  targetId: string,
  sourceRepo: string,
  targetRepo: string,
  rawConf: PkgEvidence,
  entries: PkgEntry[],
  sourceFile: string,
): void {
  if (sourceRepo === targetRepo) return; // same repo
  const key = `${sourceId}::${targetId}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  ctx.crossEdges.push({
    source: sourceId,
    target: targetId,
    relation: "imports_from",
    confidence: entries.length > 1 ? "AMBIGUOUS" : rawConf,
    sourceFile,
    weight: 1,
    repo: sourceRepo,
  });
}

/**
 * Find the best target node ID in a target repo for a given set of imported names.
 * Returns the first matching node ID, or a synthetic one derived from the repoKey.
 */
function findTargetNode(ctx: LinkContext, targetRepoKey: string, importedNames: string[]): string {
  const labelMap = ctx.nodesByRepoAndLabel.get(targetRepoKey);
  if (labelMap) {
    for (const name of importedNames) {
      const candidates = labelMap.get(normalizeLabel(name));
      if (candidates && candidates.length > 0) return candidates[0]!;
    }
  }
  // Fallback: if there are any nodes in the target repo, use the first one
  const anyInRepo = ctx.allNodes.find((n) => n.repo === targetRepoKey);
  if (anyInRepo) return anyInRepo.id;
  // Last resort: use the repoKey itself as a synthetic node ID (preserves
  // backwards compatibility with existing unit tests that check target === repoKey).
  return targetRepoKey;
}

/**
 * Find the file module node ID in the merged store for a given (repoKey, relPath).
 * The file module node has id = normalizeKeyForPrefix(repoKey) + "::" + makeId(relPath)
 * and kind="module".
 */
function findFileNode(ctx: LinkContext, repoKey: string, relPath: string): string | null {
  const nodes = ctx.nodesByRepoAndFile.get(repoKey)?.get(relPath);
  if (nodes) {
    // Return the module node (kind=module) for this file if available
    for (const nid of nodes) {
      if (ctx.nodeById.get(nid)?.kind === "module") return nid;
    }
    // Any node from this file will do as a proxy
    return nodes[0] ?? null;
  }
  // Synthesize: the file node id = repoKey_prefix::makeId(relPath)
  return `${normalizeKeyForPrefix(repoKey)}::${makeId(relPath)}`;
}

/**
 * Find a function/method node by (repoKey, relPath, label) for use-site anchoring (FU#2).
 * Returns the node id of the function in that exact file, or null when there is no
 * matching function node (caller falls back to the file node).
 */
function findFunctionNode(
  ctx: LinkContext,
  repoKey: string,
  relPath: string,
  label: string,
): string | null {
  const candidates = ctx.nodesByRepoAndLabel.get(repoKey)?.get(normalizeLabel(label));
  if (!candidates) return null;
  for (const nid of candidates) {
    const n = ctx.nodeById.get(nid);
    if (!n) continue;
    if (n.sourceFile === relPath && (n.kind === "function" || n.kind === "method")) {
      return nid;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategy 1: Graph-edge scan (tree-sitter imported repos)
// ---------------------------------------------------------------------------

/** Match one import edge against the package index and emit cross-repo edges. */
function processImportEdge(ctx: LinkContext, edge: GraphEdge): void {
  if (edge.relation !== "imports_from" && edge.relation !== "imports") return;

  // Look up the target node — if it has kind="module", its label is the module path
  const targetNode = ctx.nodeById.get(edge.target);
  const importedModule =
    (targetNode?.kind === "module" && targetNode.label !== undefined)
      ? targetNode.label
      : edge.target;

  if (!importedModule || isRelativeImport(importedModule)) return;

  const sourceRepo = edge.repo ?? ctx.idToRepo.get(edge.source) ?? "";

  for (const [pkgName, entries] of ctx.pkgIndex.entries()) {
    const conf = matchConfidence(importedModule, pkgName);
    if (conf) linkEdgeToEntries(ctx, edge, sourceRepo, conf, entries);
  }
}

/** Emit cross-repo edges from an import edge to every matching publishing repo. */
function linkEdgeToEntries(
  ctx: LinkContext,
  edge: GraphEdge,
  sourceRepo: string,
  conf: PkgEvidence,
  entries: PkgEntry[],
): void {
  for (const entry of entries) {
    if (entry.repoKey === sourceRepo) continue; // same repo
    // Use edge.source as source and find a good target in the target repo
    const sourceNode = ctx.nodeById.get(edge.source);
    const targetId = findTargetNode(ctx, entry.repoKey, []);
    addCrossEdge(
      ctx,
      edge.source,
      targetId,
      sourceRepo,
      entry.repoKey,
      conf,
      entries,
      sourceNode?.sourceFile ?? edge.sourceFile,
    );
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Source-file scan (ts-morph extracted repos)
// ---------------------------------------------------------------------------

/** Per-file scan state (lazily caches function spans for use-site anchoring). */
interface FileScan {
  member: WorkspaceMember;
  relPath: string;
  source: string;
  lang: "ts" | "js" | "py" | "java" | "cs";
  spans: FnSpan[] | null;
}

/** Lazily compute (and cache) function/method body spans for the file (FU#2). */
function getFnSpans(fs: FileScan): FnSpan[] {
  fs.spans ??= extractFnSpans(fs.source, fs.lang);
  return fs.spans;
}

/** Scan every source file of a workspace member for cross-repo imports. */
function scanMemberSources(ctx: LinkContext, member: WorkspaceMember): void {
  for (const absPath of listSourceFiles(member.dir)) {
    scanSourceFile(ctx, member, absPath);
  }
}

/** Parse one source file and link each non-relative import it declares. */
function scanSourceFile(ctx: LinkContext, member: WorkspaceMember, absPath: string): void {
  const lang = extToLang(absPath);
  if (!lang) return;

  let source: string;
  try {
    source = readFileSync(absPath, "utf8");
  } catch {
    return;
  }

  const fs: FileScan = {
    member,
    relPath: relative(member.dir, absPath).split(sep).join("/"),
    source,
    lang,
    spans: null,
  };

  for (const imp of parseImports(source, lang)) {
    if (!isRelativeImport(imp.module)) linkImport(ctx, fs, imp);
  }
}

/** Match one parsed import against the package index and emit cross-repo edges. */
function linkImport(ctx: LinkContext, fs: FileScan, imp: ParsedImport): void {
  for (const [pkgName, entries] of ctx.pkgIndex.entries()) {
    const conf = matchConfidence(imp.module, pkgName);
    if (conf) linkImportToEntries(ctx, fs, imp, conf, entries);
  }
}

/** Emit cross-repo edges from one import to every matching publishing repo. */
function linkImportToEntries(
  ctx: LinkContext,
  fs: FileScan,
  imp: ParsedImport,
  conf: PkgEvidence,
  entries: PkgEntry[],
): void {
  for (const entry of entries) {
    if (entry.repoKey === fs.member.repoKey) continue; // same repo
    const targetId = findTargetNode(ctx, entry.repoKey, imp.names);
    for (const sourceNodeId of resolveSourceIds(ctx, fs, imp)) {
      addCrossEdge(ctx, sourceNodeId, targetId, fs.member.repoKey, entry.repoKey, conf, entries, fs.relPath);
    }
  }
}

/**
 * FU#2: anchor at the function(s) that actually use the imported symbol(s),
 * so cross-repo edges are function-to-function. Fall back to the file node
 * when no use-site function can be resolved (honest SYNTACTIC heuristic).
 */
function resolveSourceIds(ctx: LinkContext, fs: FileScan, imp: ParsedImport): string[] {
  const useSiteFns = findFunctionsUsingNames(getFnSpans(fs), fs.source, imp.names);
  const sourceIds: string[] = [];
  for (const fnName of useSiteFns) {
    const fnId = findFunctionNode(ctx, fs.member.repoKey, fs.relPath, fnName);
    if (fnId) sourceIds.push(fnId);
  }
  if (sourceIds.length === 0) {
    const fileId = findFileNode(ctx, fs.member.repoKey, fs.relPath);
    if (fileId) sourceIds.push(fileId);
  }
  return sourceIds;
}
