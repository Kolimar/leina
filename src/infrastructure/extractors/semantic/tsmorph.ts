// Semantic TypeScript extractor using ts-morph (the TS compiler API).
//
// Unlike the tree-sitter path (syntactic, heuristic name matching), this uses
// the real type checker: every call/reference is resolved to its EXACT
// declaration via getSymbol().getDeclarations(). That means edges are
// compiler-proven (EXTRACTED), with no AMBIGUOUS guessing — overloads, imports,
// re-exports and generics all resolve correctly.
//
// Runs in-process (ts-morph bundles TypeScript), so no external toolchain.

import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  type ArrowFunction,
  type ClassDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type MethodSignature,
  Node as TsNode,
  type Node,
  type ParameterDeclaration,
  Project,
  Scope,
  type PropertyDeclaration,
  type PropertySignature,
  type SourceFile,
  SyntaxKind,
  type Type,
  type VariableDeclaration,
} from "ts-morph";
import { makeId } from "../../../domain/shared/id.ts";
import type {
  GraphEdge,
  GraphNode,
  NodeKind,
  ParameterInfo,
  Relation,
  Signature,
} from "../../../domain/graph/model.ts";

// ---------------------------------------------------------------------------
// Signature helpers — extract structured Signature info from function/method-ish
// declarations. Annotation-primary policy: prefer the source-code annotation
// (faithful, no cross-file qualification); fall back to the resolved type with
// the `import("...").` prefix stripped, capped at MAX_TYPE_LEN chars.
// ---------------------------------------------------------------------------

const MAX_TYPE_LEN = 200;

function cap(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 3)  }...`;
}

// Strip ts-morph's cross-file qualification (`import("/abs/path").Foo` -> `Foo`)
// and collapse whitespace so multi-line resolved types render as a single line.
function cleanResolved(s: string): string {
  return s.replaceAll(/import\("[^"]+"\)\./g, "").replaceAll(/\s+/g, " ").trim();
}

function isTypeNullable(t: Type): boolean {
  if (t.isNull() || t.isUndefined()) return true;
  for (const u of t.getUnionTypes()) {
    if (u.isNull() || u.isUndefined()) return true;
  }
  return false;
}

function formatType(p: ParameterDeclaration): string {
  const annotation = p.getTypeNode()?.getText();
  if (annotation) return cap(annotation.trim(), MAX_TYPE_LEN);
  return cap(cleanResolved(p.getType().getText()), MAX_TYPE_LEN);
}

type FnLike =
  | FunctionDeclaration
  | MethodDeclaration
  | ArrowFunction
  | FunctionExpression;

function formatReturnType(decl: FnLike): string {
  const annotationNode = decl.getReturnTypeNode();
  if (annotationNode) return cap(annotationNode.getText().trim(), MAX_TYPE_LEN);
  return cap(cleanResolved(decl.getReturnType().getText()), MAX_TYPE_LEN);
}

// arrow / fn-expression initializers don't have a `getScope()` method but
// class fields can. We only set accessModifier for declarations that can have one.
function getMethodScope(
  decl: FnLike,
): "public" | "private" | "protected" | undefined {
  if (TsNode.isMethodDeclaration(decl)) {
    const scope = decl.getScope();
    if (scope === Scope.Public) return "public";
    if (scope === Scope.Private) return "private";
    if (scope === Scope.Protected) return "protected";
  }
  return undefined;
}

// async detection works uniformly across all FnLike shapes via getModifiers().
function isAsyncDecl(decl: FnLike): boolean {
  return decl.getModifiers().some((m) => m.getKind() === SyntaxKind.AsyncKeyword);
}

// generators: only FunctionDeclaration / FunctionExpression / MethodDeclaration
// can be generators in TS. ArrowFunction cannot. ts-morph exposes isGenerator()
// on the first three; we check for its presence.
function isGeneratorDecl(decl: FnLike): boolean {
  if (TsNode.isArrowFunction(decl)) return false;
  if (
    TsNode.isFunctionDeclaration(decl) ||
    TsNode.isFunctionExpression(decl) ||
    TsNode.isMethodDeclaration(decl)
  ) {
    return decl.isGenerator();
  }
  return false;
}

export function buildSignature(decl: FnLike): Signature {
  const parameters: ParameterInfo[] = decl.getParameters().map((p) => {
    const optional = p.hasQuestionToken() || p.hasInitializer();
    // For `x?: T`, the parameter type itself is T (not T | undefined), but
    // optionality semantically introduces undefined. Treat as nullable.
    const baseNullable = isTypeNullable(p.getType());
    return {
      name: p.getName(),
      type: formatType(p),
      nullable: baseNullable || p.hasQuestionToken(),
      optional,
    };
  });
  const sig: Signature = {
    returnType: {
      text: formatReturnType(decl),
      nullable: isTypeNullable(decl.getReturnType()),
    },
    parameters,
    isAsync: isAsyncDecl(decl),
    isGenerator: isGeneratorDecl(decl),
  };
  const access = getMethodScope(decl);
  if (access) sig.accessModifier = access;
  return sig;
}

// Resolve a VariableDeclaration initializer to a function-like declaration if
// it's an arrow or function expression. Used at the registration sites for
// `export const f = () => ...` and `export const g = function () { ... }`.
function fnLikeFromVarDecl(vd: VariableDeclaration): FnLike | undefined {
  const init = vd.getInitializer();
  if (!init) return undefined;
  if (TsNode.isArrowFunction(init) || TsNode.isFunctionExpression(init)) {
    return init;
  }
  return undefined;
}

// Same idea for class property initializers (`handler = () => ...`).
function fnLikeFromPropInit(init: Node | undefined): FnLike | undefined {
  if (!init) return undefined;
  if (TsNode.isArrowFunction(init) || TsNode.isFunctionExpression(init)) {
    return init;
  }
  return undefined;
}

export function isTsMorphAvailable(): boolean {
  return true; // bundled dependency
}

// Shared mutable state threaded through the two extraction passes. Helpers that
// depend on per-run state (the accumulating graph, the declaration->id map, and
// the root-relative path resolver) receive it as an explicit parameter.
interface ExtractCtx {
  nodes: GraphNode[];
  edges: GraphEdge[];
  declToId: Map<Node, string>; // ts-morph declaration -> graph id
  rel: (abs: string) => string;
}

const loc = (n: Node): string => `L${n.getStartLineNumber()}`;

function addEdge(
  ctx: ExtractCtx,
  source: string,
  target: string,
  relation: Relation,
  sourceFile: string,
  sourceLocation: string,
  confidence: GraphEdge["confidence"] = "EXTRACTED",
): void {
  if (source === target) return;
  ctx.edges.push({ source, target, relation, confidence, sourceFile, sourceLocation, weight: 1 });
}

function isFunctionInitializer(init: Node | undefined): boolean {
  if (!init) return false;
  const k = init.getKind();
  return k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression;
}

// --- Pass 1: register every definition so calls can resolve to it ------------

function registerMethod(
  ctx: ExtractCtx,
  m: MethodDeclaration | MethodSignature,
  classId: string,
  relPath: string,
): void {
  const mn = m.getName();
  const mid = makeId(classId, mn);
  const methodNode: GraphNode = {
    id: mid,
    label: `${mn}()`,
    fileType: "code",
    sourceFile: relPath,
    sourceLocation: loc(m),
    kind: "method",
  };
  // Interface methods (MethodSignature) don't carry isAsync/isGenerator;
  // only emit signature for concrete MethodDeclarations.
  if (TsNode.isMethodDeclaration(m)) {
    methodNode.signature = buildSignature(m);
  }
  ctx.nodes.push(methodNode);
  addEdge(ctx, classId, mid, "method", relPath, loc(m));
  ctx.declToId.set(m, mid);
}

// arrow-function class fields: `handler = () => {...}`
function registerArrowProperty(
  ctx: ExtractCtx,
  p: PropertyDeclaration | PropertySignature,
  classId: string,
  relPath: string,
): void {
  if (!isFunctionInitializer(p.getInitializer())) return;
  const pn = p.getName();
  const pid = makeId(classId, pn);
  const propFn = fnLikeFromPropInit(p.getInitializer());
  const propNode: GraphNode = {
    id: pid,
    label: `${pn}()`,
    fileType: "code",
    sourceFile: relPath,
    sourceLocation: loc(p),
    kind: "method",
  };
  if (propFn) propNode.signature = buildSignature(propFn);
  ctx.nodes.push(propNode);
  addEdge(ctx, classId, pid, "method", relPath, loc(p));
  ctx.declToId.set(p, pid);
}

function registerClassLike(
  ctx: ExtractCtx,
  decl: ClassDeclaration | InterfaceDeclaration,
  kind: NodeKind,
  relPath: string,
  fileId: string,
): void {
  const name = decl.getName();
  if (!name) return;
  const classId = makeId(relPath, name);
  ctx.nodes.push({ id: classId, label: name, fileType: "code", sourceFile: relPath, sourceLocation: loc(decl), kind });
  addEdge(ctx, fileId, classId, "contains", relPath, loc(decl));
  ctx.declToId.set(decl, classId);
  for (const m of decl.getMethods()) registerMethod(ctx, m, classId, relPath);
  for (const p of decl.getProperties()) registerArrowProperty(ctx, p, classId, relPath);
}

function registerFunction(
  ctx: ExtractCtx,
  fn: FunctionDeclaration,
  relPath: string,
  fileId: string,
): void {
  const name = fn.getName();
  if (!name) return;
  const id = makeId(relPath, name);
  ctx.nodes.push({
    id,
    label: `${name}()`,
    fileType: "code",
    sourceFile: relPath,
    sourceLocation: loc(fn),
    kind: "function",
    signature: buildSignature(fn),
  });
  addEdge(ctx, fileId, id, "contains", relPath, loc(fn));
  ctx.declToId.set(fn, id);
}

// top-level arrow/function-expression consts: `export const f = () => {...}`
function registerFunctionConst(
  ctx: ExtractCtx,
  vd: VariableDeclaration,
  relPath: string,
  fileId: string,
): void {
  if (!isFunctionInitializer(vd.getInitializer())) return;
  const name = vd.getName();
  const id = makeId(relPath, name);
  const fnLike = fnLikeFromVarDecl(vd);
  const node: GraphNode = {
    id,
    label: `${name}()`,
    fileType: "code",
    sourceFile: relPath,
    sourceLocation: loc(vd),
    kind: "function",
  };
  if (fnLike) node.signature = buildSignature(fnLike);
  ctx.nodes.push(node);
  addEdge(ctx, fileId, id, "contains", relPath, loc(vd));
  ctx.declToId.set(vd, id);
}

function registerSourceFileDefs(ctx: ExtractCtx, sf: SourceFile): void {
  const relPath = ctx.rel(sf.getFilePath());
  const fileId = makeId(relPath);
  ctx.nodes.push({ id: fileId, label: relPath, fileType: "code", sourceFile: relPath, kind: "module" });
  // Register the SourceFile itself so module-scope calls (top-level statements
  // outside any function declaration) attribute to the module node instead of
  // being silently dropped by enclosingId().
  ctx.declToId.set(sf, fileId);
  for (const cls of sf.getClasses()) registerClassLike(ctx, cls, "class", relPath, fileId);
  for (const itf of sf.getInterfaces()) registerClassLike(ctx, itf, "interface", relPath, fileId);
  for (const fn of sf.getFunctions()) registerFunction(ctx, fn, relPath, fileId);
  for (const vs of sf.getVariableStatements()) {
    for (const vd of vs.getDeclarations()) registerFunctionConst(ctx, vd, relPath, fileId);
  }
}

// Resolve a referenced node to a registered graph id via the type checker.
function resolveSymbolId(expr: Node, declToId: Map<Node, string>): string | undefined {
  let sym = expr.getSymbol();
  if (sym?.isAlias()) {
    sym = sym.getAliasedSymbol() ?? sym;
  }
  for (const d of sym?.getDeclarations() ?? []) {
    const id = declToId.get(d);
    if (id) return id;
  }
  return undefined;
}

function enclosingId(node: Node, declToId: Map<Node, string>): string | undefined {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    const id = declToId.get(cur);
    if (id) return id;
    cur = cur.getParent();
  }
  return undefined;
}

// --- Pass 2: heritage + calls (needs the full declToId map) ------------------

function linkClassHeritage(ctx: ExtractCtx, cls: ClassDeclaration, relPath: string): void {
  const classId = ctx.declToId.get(cls);
  if (!classId) return;
  const ext = cls.getExtends();
  if (ext) {
    const t = resolveSymbolId(ext.getExpression(), ctx.declToId);
    if (t) addEdge(ctx, classId, t, "extends", relPath, loc(ext));
  }
  for (const impl of cls.getImplements()) {
    const t = resolveSymbolId(impl.getExpression(), ctx.declToId);
    if (t) addEdge(ctx, classId, t, "implements", relPath, loc(impl));
  }
}

function linkInterfaceHeritage(ctx: ExtractCtx, itf: InterfaceDeclaration, relPath: string): void {
  const itfId = ctx.declToId.get(itf);
  if (!itfId) return;
  for (const ext of itf.getExtends()) {
    const t = resolveSymbolId(ext.getExpression(), ctx.declToId);
    if (t) addEdge(ctx, itfId, t, "extends", relPath, loc(ext));
  }
}

function linkCallEdges(ctx: ExtractCtx, sf: SourceFile, relPath: string): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const fromId = enclosingId(call, ctx.declToId);
    if (!fromId) continue;
    const target = resolveSymbolId(call.getExpression(), ctx.declToId);
    if (target) addEdge(ctx, fromId, target, "calls", relPath, loc(call));
  }
  for (const nw of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const fromId = enclosingId(nw, ctx.declToId);
    if (!fromId) continue;
    const target = resolveSymbolId(nw.getExpression(), ctx.declToId);
    if (target) addEdge(ctx, fromId, target, "references", relPath, loc(nw));
  }
}

// Emit a `references` edge with local (from,to) dedup shared across both reference
// walks. Distinct relations (calls/extends/implements) are NOT deduped against this —
// `references` is additive, never a substitute for the more specific relation.
function emitRef(
  ctx: ExtractCtx,
  fromId: string | undefined,
  target: string | undefined,
  relPath: string,
  sourceLocation: string,
  seen: Set<string>,
): void {
  if (!fromId || !target) return;
  const key = `${fromId}\0${target}`;
  if (seen.has(key)) return;
  seen.add(key);
  addEdge(ctx, fromId, target, "references", relPath, sourceLocation);
}

// Type-position references: import type, parameter/return/field annotations, and
// nested generic type-args (`Map<string, GraphNode>` yields two TypeReference nodes,
// both already present in getDescendantsOfKind — no manual recursion needed).
function linkTypeReferences(ctx: ExtractCtx, sf: SourceFile, relPath: string, seen: Set<string>): void {
  for (const tr of sf.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    // .getSymbol() on the TypeReferenceNode itself returns undefined — resolve the
    // name-node (getTypeName()) instead.
    const target = resolveSymbolId(tr.getTypeName(), ctx.declToId);
    const fromId = enclosingId(tr, ctx.declToId);
    emitRef(ctx, fromId, target, relPath, loc(tr), seen);
  }
}

// Excludes for value-position Identifiers — anything already covered by a more
// specific walk (calls, heritage, import/export bindings) or that sits in type
// position (covered by linkTypeReferences) must NOT also produce a `references` edge
// here, or the same pair would be counted twice under two different relations/paths.
function isExcludedValueId(id: Node): boolean {
  const p = id.getParent();
  if (!p) return false;
  // callee of Call/New — already covered by linkCallEdges.
  if (
    (TsNode.isCallExpression(p) || TsNode.isNewExpression(p)) &&
    p.getExpression() === id
  ) {
    return true;
  }
  // name-node of `obj.NAME` — keep scope to standalone identifiers only.
  if (TsNode.isPropertyAccessExpression(p) && p.getNameNode() === id) return true;
  // import/export binding identifiers — the binding itself isn't a use.
  const pk = p.getKind();
  if (
    pk === SyntaxKind.ImportSpecifier ||
    pk === SyntaxKind.ImportClause ||
    pk === SyntaxKind.NamespaceImport ||
    pk === SyntaxKind.ImportEqualsDeclaration ||
    pk === SyntaxKind.ExportSpecifier
  ) {
    return true;
  }
  // heritage (`extends`/`implements`) — already covered by the heritage walks.
  if (id.getFirstAncestorByKind(SyntaxKind.HeritageClause)) return true;
  // type position — already covered by linkTypeReferences.
  if (id.getFirstAncestorByKind(SyntaxKind.TypeReference)) return true;
  if (TsNode.isQualifiedName(p)) return true;
  return false;
}

// Value-position references: identifiers that alias-resolve to a registered
// declaration but aren't calls, heritage, import bindings, or type positions (all
// handled elsewhere). Covers symbols passed as values (`fn: buildGraph as ...`,
// `registerHandler(myHandler)`).
function linkValueReferences(ctx: ExtractCtx, sf: SourceFile, relPath: string, seen: Set<string>): void {
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (isExcludedValueId(id)) continue;
    const target = resolveSymbolId(id, ctx.declToId);
    const fromId = enclosingId(id, ctx.declToId);
    emitRef(ctx, fromId, target, relPath, loc(id), seen);
  }
}

// Owns the per-file dedup set shared by both reference walks.
function linkReferenceEdges(ctx: ExtractCtx, sf: SourceFile, relPath: string): void {
  const seen = new Set<string>();
  linkTypeReferences(ctx, sf, relPath, seen);
  linkValueReferences(ctx, sf, relPath, seen);
}

function linkHeritageAndCalls(ctx: ExtractCtx, sf: SourceFile): void {
  const relPath = ctx.rel(sf.getFilePath());
  for (const cls of sf.getClasses()) linkClassHeritage(ctx, cls, relPath);
  for (const itf of sf.getInterfaces()) linkInterfaceHeritage(ctx, itf, relPath);
  linkCallEdges(ctx, sf, relPath);
  linkReferenceEdges(ctx, sf, relPath);
}

export function extractTsProject(
  root: string,
  tsFiles: string[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const tsconfig = join(root, "tsconfig.json");
  const project = existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ compilerOptions: { allowJs: true, skipLibCheck: true } });

  project.addSourceFilesAtPaths(tsFiles);

  const ctx: ExtractCtx = {
    nodes: [],
    edges: [],
    declToId: new Map<Node, string>(),
    rel: (abs: string): string => relative(root, abs).split(sep).join("/"),
  };

  // --- Pass 1: register every definition so calls can resolve to it ----------
  for (const sf of project.getSourceFiles()) registerSourceFileDefs(ctx, sf);
  // --- Pass 2: heritage + calls (needs the full declToId map) ----------------
  for (const sf of project.getSourceFiles()) linkHeritageAndCalls(ctx, sf);

  return { nodes: ctx.nodes, edges: ctx.edges };
}

// ---------------------------------------------------------------------------
// GraphExtractor adapter — wraps extractTsProject en el puerto de dominio.
// ---------------------------------------------------------------------------

import { detectLang } from "../../../application/graph/detect.ts";
import type { GraphExtractor, GraphExtractionResult } from "../../../domain/graph/extractor.ts";

export class TsmorphExtractor implements GraphExtractor {
  readonly id = "tsmorph" as const;
  readonly version: string;

  constructor(version: string) {
    this.version = version;
  }

  supports(filePath: string): boolean {
    const l = detectLang(filePath);
    return l === "typescript" || l === "tsx";
  }

  async extract(root: string, files: string[]): Promise<GraphExtractionResult> {
    const base = {
      schemaVersion: 1 as const,
      extractor: { id: this.id, version: this.version },
    };

    // Deshabilitado por variable de entorno → señal D4 (errors no vacío → no handled)
    if (process.env.LEINA_NO_TSMORPH) {
      return { ...base, nodes: [], edges: [], diagnostics: [], durationMs: 0, errors: ["disabled by LEINA_NO_TSMORPH"] };
    }

    const tsFiles = files.filter((f) => {
      const l = detectLang(f);
      return l === "typescript" || l === "tsx";
    });
    if (tsFiles.length === 0) {
      return { ...base, nodes: [], edges: [], diagnostics: [], durationMs: 0, errors: ["no typescript files in candidate list"] };
    }

    const start = Date.now();
    try {
      const res = extractTsProject(root, tsFiles);
      return {
        ...base,
        nodes: res.nodes,
        edges: res.edges,
        diagnostics: [],
        durationMs: Date.now() - start,
        errors: [],
      };
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`  ! ts-morph failed, using tree-sitter for TS: ${msg}`);
      return {
        ...base,
        nodes: [],
        edges: [],
        diagnostics: [`ts-morph failed → tree-sitter: ${msg}`],
        durationMs: Date.now() - start,
        errors: [msg],
      };
    }
  }
}
