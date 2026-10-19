// Per-file semantic extraction over the raw TypeScript compiler API.
//
// ts-morph only supplies the Program (tsconfig parsing, lib files, module resolution); the walk
// itself uses the compiler's own nodes and checker. Wrapping every visited node in a ts-morph
// object cost seconds and hundreds of MB on real repos, and ts-morph's line lookup rescans the
// file text from the start on every call.
//
// Every edge a file emits has its source inside that file, and every id it targets comes from
// the syntax-only defs of the target's file (ts-defs.ts). A file's result therefore depends only
// on the files the checker can see from it — never on which other files are being extracted in
// the same run — which is what makes per-file caching (the incremental path) exact.

import { ts } from "ts-morph";
import type {
  GraphEdge,
  GraphNode,
  ParameterInfo,
  Relation,
  Signature,
} from "../../../domain/graph/model.ts";
import { nameText, unwrapExpression, type FileDefs, type FnLike, type TsDef } from "./ts-defs.ts";

export interface TsProgramEnv {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Defs of a program file, or undefined when it is not one of the extracted files. */
  defsOf(sf: ts.SourceFile): FileDefs | undefined;
}

export interface TsFileResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Signatures — annotation-primary: prefer the source annotation (faithful, no cross-file
// qualification); fall back to the resolved type with the `import("...").` prefix stripped,
// capped at MAX_TYPE_LEN chars.
// ---------------------------------------------------------------------------

const MAX_TYPE_LEN = 200;

// Same flags ts-morph's Type#getText() used, so resolved texts stay byte-identical.
const TYPE_FORMAT =
  ts.TypeFormatFlags.UseTypeOfFunction |
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteTypeArgumentsOfSignature;

const NODE_BUILDER =
  (TYPE_FORMAT & ts.TypeFormatFlags.NodeBuilderFlagsMask) |
  ts.NodeBuilderFlags.IgnoreErrors |
  ts.NodeBuilderFlags.NoTruncation;

const printer = ts.createPrinter({ removeComments: true });

// typeToString's own call shape: no source file, so every node prints from its data.
const print = (n: ts.Node): string => printer.printNode(ts.EmitHint.Unspecified, n, undefined as unknown as ts.SourceFile);

const INTRINSIC_TYPE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.UnknownKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.ObjectKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.UndefinedKeyword,
]);

/** 0 = intrinsic (fixed checker order), 1 = everything else, 2 = null, 3 = undefined. */
function unionRank(t: ts.TypeNode): number {
  if (t.kind === ts.SyntaxKind.UndefinedKeyword) return 3;
  if (ts.isLiteralTypeNode(t)) {
    if (t.literal.kind === ts.SyntaxKind.NullKeyword) return 2;
    if (t.literal.kind === ts.SyntaxKind.TrueKeyword || t.literal.kind === ts.SyntaxKind.FalseKeyword) return 0;
  }
  return INTRINSIC_TYPE_KINDS.has(t.kind) ? 0 : 1;
}

function sortedIfChanged<T>(items: readonly T[], key: (t: T, i: number) => [number, string]): T[] | undefined {
  const keyed = items.map((t, i) => ({ t, i, k: key(t, i) }));
  keyed.sort((a, b) => a.k[0] - b.k[0] || (a.k[1] < b.k[1] ? -1 : a.k[1] > b.k[1] ? 1 : 0) || a.i - b.i);
  return keyed.some((e, i) => e.i !== i) ? keyed.map((e) => e.t) : undefined;
}

function memberName(m: ts.TypeElement): string | undefined {
  const name = m.name;
  if (name === undefined) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : print(name);
}

// The checker orders union members and mapped-type properties by internal type id, i.e. by
// the order in which types happened to be created — which depends on what was asked before.
// Canonical order (non-intrinsic union members and object members sorted by text; intrinsic
// and nullish members where the checker always puts them) makes a resolved type's text a
// function of the type alone, so a file extracted on its own prints what a whole-project run
// prints.
function canonicalize<T extends ts.Node>(node: T): T {
  const n = ts.visitEachChild(node, (c) => canonicalize(c), undefined);
  if (ts.isUnionTypeNode(n)) {
    const sorted = sortedIfChanged(n.types, (t) => {
      const rank = unionRank(t);
      return [rank, rank === 1 ? print(t) : ""];
    });
    return (sorted ? ts.factory.updateUnionTypeNode(n, ts.factory.createNodeArray(sorted)) : n) as unknown as T;
  }
  if (ts.isTypeLiteralNode(n)) {
    const sorted = sortedIfChanged(n.members, (m) => {
      const name = memberName(m);
      return name === undefined ? [0, ""] : [1, name];
    });
    return (sorted ? ts.factory.updateTypeLiteralNode(n, ts.factory.createNodeArray(sorted)) : n) as unknown as T;
  }
  return n;
}

function cap(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 3)}...`;
}

// Strip cross-file qualification (`import("/abs/path").Foo` -> `Foo`) and collapse
// whitespace so multi-line resolved types render as a single line.
function cleanResolved(s: string): string {
  return s.replaceAll(/import\("[^"]+"\)\./g, "").replaceAll(/\s+/g, " ").trim();
}

function isTypeNullable(t: ts.Type): boolean {
  const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined;
  if (t.flags & nullish) return true;
  if (t.isUnion()) return t.types.some((u) => (u.flags & nullish) !== 0);
  return false;
}

function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === kind);
}

function accessOf(decl: FnLike): Signature["accessModifier"] {
  const member = ts.isMethodDeclaration(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl);
  if (!member || !ts.isClassLike(decl.parent)) return undefined;
  const flags = ts.getCombinedModifierFlags(decl);
  if (flags & ts.ModifierFlags.Private) return "private";
  if (flags & ts.ModifierFlags.Protected) return "protected";
  return "public";
}

function isGenerator(decl: FnLike): boolean {
  return !ts.isArrowFunction(decl) && decl.asteriskToken !== undefined;
}

// ---------------------------------------------------------------------------
// Symbol resolution
// ---------------------------------------------------------------------------

/** ts-morph's Node#getSymbol(): bound symbol, else the checker's, else the name node's. */
function symbolOf(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const bound = (node as { symbol?: ts.Symbol }).symbol;
  if (bound) return bound;
  const s = checker.getSymbolAtLocation(node);
  if (s) return s;
  const name = (node as { name?: ts.Node }).name;
  return name !== undefined && typeof name === "object" && "kind" in name ? symbolOf(checker, name) : undefined;
}

/**
 * Which declarations of a merged symbol a reference means: `const User` + `type User` are one
 * symbol, but `User.parse()` uses the value and `u: User` the type.
 */
type Meaning = "value" | "type";

function declMeans(d: ts.Node, meaning: Meaning): boolean {
  const typeOnly = ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d);
  if (meaning === "value") return !typeOnly;
  return typeOnly || ts.isClassLike(d) || ts.isEnumDeclaration(d);
}

function isCallee(n: ts.Node): boolean {
  const p = n.parent;
  return (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n;
}

/** How many local renames (`const { a } = …`, `const b = a`, `{ b }`) resolution follows. */
const MAX_ALIAS_HOPS = 8;

const loc = (n: ts.Node, sf: ts.SourceFile): string =>
  `L${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

interface WalkState {
  enclosing: string;
  inHeritage: boolean;
  inTypeRef: boolean;
  inJsDoc: boolean;
}

interface Site {
  node: ts.Node;
  from: string;
}

class FileExtractor {
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];
  private readonly checker: ts.TypeChecker;
  private readonly rel: string;
  private readonly calls: Site[] = [];
  private readonly news: Site[] = [];
  private readonly typeRefs: Site[] = [];
  private readonly valueRefs: Site[] = [];
  private readonly resolved: Record<Meaning, Map<ts.Symbol, string | null>> = { value: new Map(), type: new Map() };
  private readonly env: TsProgramEnv;
  private readonly sf: ts.SourceFile;
  private readonly defs: FileDefs;

  constructor(env: TsProgramEnv, sf: ts.SourceFile, defs: FileDefs) {
    this.env = env;
    this.sf = sf;
    this.defs = defs;
    this.checker = env.checker;
    this.rel = defs.relPath;
  }

  run(): TsFileResult {
    this.emitDefs();
    this.walk(this.sf, { enclosing: this.defs.fileId, inHeritage: false, inTypeRef: false, inJsDoc: false });
    this.emitHeritage();
    this.emitCalls();
    this.emitReferences();
    return { nodes: this.nodes, edges: this.edges };
  }

  private addEdge(source: string, target: string, relation: Relation, at: ts.Node): void {
    if (source === target) return;
    this.edges.push({
      source,
      target,
      relation,
      confidence: "EXTRACTED",
      sourceFile: this.rel,
      sourceLocation: loc(at, this.sf),
      weight: 1,
    });
  }

  // --- nodes + structural edges --------------------------------------------------

  private emitDefs(): void {
    this.nodes.push({ id: this.defs.fileId, label: this.rel, fileType: "code", sourceFile: this.rel, kind: "module" });
    for (const d of this.defs.defs) {
      const node: GraphNode = {
        id: d.id,
        label: d.label,
        fileType: "code",
        sourceFile: this.rel,
        sourceLocation: loc(d.decl, this.sf),
        kind: d.kind,
      };
      if (d.fn) node.signature = this.signature(d.fn);
      this.nodes.push(node);
      this.addEdge(d.owner, d.id, d.relation, d.decl);
    }
  }

  private typeText(t: ts.Type): string {
    const node = this.checker.typeToTypeNode(t, undefined, NODE_BUILDER);
    return node ? print(canonicalize(node)) : this.checker.typeToString(t, undefined, TYPE_FORMAT);
  }

  private signature(decl: FnLike): Signature {
    const parameters: ParameterInfo[] = decl.parameters.map((p) => {
      const t = this.checker.getTypeAtLocation(p);
      const annotation = p.type?.getText(this.sf);
      return {
        name: p.name.getText(this.sf),
        type: annotation ? cap(annotation.trim(), MAX_TYPE_LEN) : cap(cleanResolved(this.typeText(t)), MAX_TYPE_LEN),
        // `x?: T` is T as declared, but optionality introduces undefined: treat as nullable.
        nullable: isTypeNullable(t) || p.questionToken !== undefined,
        optional: p.questionToken !== undefined || p.initializer !== undefined,
      };
    });
    const ret = this.checker.getSignatureFromDeclaration(decl)?.getReturnType();
    const retAnnotation = decl.type?.getText(this.sf);
    const sig: Signature = {
      returnType: {
        text: retAnnotation
          ? cap(retAnnotation.trim(), MAX_TYPE_LEN)
          : cap(cleanResolved(ret ? this.typeText(ret) : "any"), MAX_TYPE_LEN),
        nullable: ret ? isTypeNullable(ret) : false,
      },
      parameters,
      isAsync: hasModifier(decl, ts.SyntaxKind.AsyncKeyword),
      isGenerator: isGenerator(decl),
    };
    const access = accessOf(decl);
    if (access) sig.accessModifier = access;
    return sig;
  }

  // --- one walk collects every site; resolution happens per category afterwards ----

  private walk(n: ts.Node, st: WalkState): void {
    if (ts.isIdentifier(n)) {
      if (!this.isExcludedValueId(n, st)) this.valueRefs.push({ node: n, from: st.enclosing });
      return;
    }
    if (!st.inJsDoc) this.collectSite(n, st.enclosing);
    const own = this.defs.idByDecl.get(n);
    const next: WalkState = {
      enclosing: own ?? st.enclosing,
      inHeritage: st.inHeritage || n.kind === ts.SyntaxKind.HeritageClause,
      inTypeRef: st.inTypeRef || n.kind === ts.SyntaxKind.TypeReference,
      inJsDoc: st.inJsDoc,
    };
    // JSDoc comes first among a node's children (`{@link X}` resolves like a value use).
    const jsDoc = (n as { jsDoc?: ts.JSDoc[] }).jsDoc;
    if (jsDoc) {
      const inDoc = { ...next, inJsDoc: true };
      for (const d of jsDoc) this.walk(d, inDoc);
    }
    ts.forEachChild(n, (c) => {
      this.walk(c, next);
    });
  }

  private collectSite(n: ts.Node, from: string): void {
    if (ts.isCallExpression(n)) this.calls.push({ node: n, from });
    else if (ts.isNewExpression(n)) this.news.push({ node: n, from });
    else if (ts.isTypeReferenceNode(n)) this.typeRefs.push({ node: n, from });
  }

  // Value-position identifiers already covered by a more specific walk (calls, heritage,
  // import/export bindings) or sitting in type position (covered by the type-reference
  // walk) must NOT also produce a `references` edge here.
  private isExcludedValueId(id: ts.Identifier, st: WalkState): boolean {
    if (st.inHeritage || st.inTypeRef) return true;
    const p = id.parent;
    if (isCallee(id)) return true;
    // `obj.NAME` as a callee is the call edge's; read, written or passed as a value
    // (`a.balance = 1`, `register(handlers.build)`) it is a reference to the member.
    if (ts.isPropertyAccessExpression(p) && p.name === id) return isCallee(p);
    switch (p.kind) {
      case ts.SyntaxKind.ImportSpecifier:
      case ts.SyntaxKind.ImportClause:
      case ts.SyntaxKind.NamespaceImport:
      case ts.SyntaxKind.ImportEqualsDeclaration:
      case ts.SyntaxKind.ExportSpecifier:
      case ts.SyntaxKind.QualifiedName:
        return true;
      default:
        return false;
    }
  }

  // --- resolution ------------------------------------------------------------------

  private idOfDecl(d: ts.Node): string | undefined {
    return this.env.defsOf(d.getSourceFile())?.idByDecl.get(d);
  }

  /** First registered declaration with the wanted meaning, else the first registered one. */
  private pickDecl(decls: readonly ts.Node[], meaning: Meaning): string | undefined {
    let fallback: string | undefined;
    for (const d of decls) {
      const id = this.idOfDecl(d);
      if (id === undefined) continue;
      if (declMeans(d, meaning)) return id;
      fallback ??= id;
    }
    return fallback;
  }

  private resolveSymbol(sym: ts.Symbol, meaning: Meaning, hops = 0): string | undefined {
    const cache = this.resolved[meaning];
    const hit = cache.get(sym);
    if (hit !== undefined) return hit ?? undefined;
    cache.set(sym, null); // a cycle of aliases (`const a = b, b = a`) resolves to nothing
    let target = sym;
    if (target.flags & ts.SymbolFlags.Alias) target = this.checker.getAliasedSymbol(target);
    const decls = target.declarations ?? [];
    let id = this.pickDecl(decls, meaning);
    if (id === undefined && decls[0] !== undefined && hops < MAX_ALIAS_HOPS) {
      const next = this.aliasTarget(decls[0]);
      if (next !== undefined) id = this.resolveSymbol(next, meaning, hops + 1);
    }
    cache.set(sym, id ?? null);
    return id;
  }

  /**
   * The symbol an unregistered local declaration is only another name for: a destructured
   * member (`const { run } = await import("./m")`, a `{ run }: Deps` parameter), a const alias
   * (`const run = mod.run`), or an object-literal property holding one (`{ run }`,
   * `{ run: impl }`). Following it makes `run()` a call of the declaration it names.
   */
  private aliasTarget(d: ts.Declaration): ts.Symbol | undefined {
    if (ts.isBindingElement(d)) {
      if (d.dotDotDotToken !== undefined || !ts.isObjectBindingPattern(d.parent)) return undefined;
      const name = nameText(d.propertyName ?? d.name);
      if (name === undefined) return undefined;
      // The pattern's type is the destructured value's: a module namespace for `await import()`.
      const source = this.checker.getNonNullableType(this.checker.getTypeAtLocation(d.parent));
      return this.checker.getPropertyOfType(source, name);
    }
    if (ts.isVariableDeclaration(d)) {
      const isConst = (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) !== 0;
      return isConst && d.initializer !== undefined ? this.symbolOfAliasExpr(d.initializer) : undefined;
    }
    if (ts.isShorthandPropertyAssignment(d)) return this.checker.getShorthandAssignmentValueSymbol(d);
    if (ts.isPropertyAssignment(d)) return this.symbolOfAliasExpr(d.initializer);
    return undefined;
  }

  /** `name` or `a.b.name` (through parens/casts) → the symbol it reads; anything else → none. */
  private symbolOfAliasExpr(e: ts.Expression): ts.Symbol | undefined {
    const u = unwrapExpression(e);
    if (ts.isIdentifier(u)) return this.checker.getSymbolAtLocation(u);
    if (ts.isPropertyAccessExpression(u)) return this.checker.getSymbolAtLocation(u.name);
    return undefined;
  }

  private resolve(node: ts.Node, meaning: Meaning): string | undefined {
    const sym = symbolOf(this.checker, node);
    return sym ? this.resolveSymbol(sym, meaning) : undefined;
  }

  // --- edges -------------------------------------------------------------------------

  private emitHeritage(): void {
    const classes = this.defs.defs.filter((d) => ts.isClassLike(d.decl));
    const interfaces = this.defs.defs.filter((d) => ts.isInterfaceDeclaration(d.decl));
    for (const d of classes) this.classHeritage(d);
    for (const d of interfaces) this.interfaceHeritage(d);
  }

  private classHeritage(d: TsDef): void {
    const cls = d.decl as ts.ClassLikeDeclaration;
    for (const clause of cls.heritageClauses ?? []) {
      const isExtends = clause.token === ts.SyntaxKind.ExtendsKeyword;
      for (const t of clause.types) {
        const target = this.resolve(t.expression, isExtends ? "value" : "type");
        if (target) this.addEdge(d.id, target, isExtends ? "extends" : "implements", t);
      }
    }
  }

  private interfaceHeritage(d: TsDef): void {
    const itf = d.decl as ts.InterfaceDeclaration;
    for (const clause of itf.heritageClauses ?? []) {
      for (const t of clause.types) {
        const target = this.resolve(t.expression, "type");
        if (target) this.addEdge(d.id, target, "extends", t);
      }
    }
  }

  private emitCalls(): void {
    for (const c of this.calls) {
      const target = this.resolve((c.node as ts.CallExpression).expression, "value");
      if (target) this.addEdge(c.from, target, "calls", c.node);
    }
    for (const n of this.news) {
      const target = this.resolve((n.node as ts.NewExpression).expression, "value");
      if (target) this.addEdge(n.from, target, "references", n.node);
    }
  }

  // `references` edges dedup on (from, target) across the type and value walks (first site
  // wins). They are additive: never deduped against calls/extends/implements.
  private emitReferences(): void {
    const seen = new Set<string>();
    const emit = (from: string, target: string | undefined, at: ts.Node): void => {
      if (target === undefined) return;
      const key = `${from}\0${target}`;
      if (seen.has(key)) return;
      seen.add(key);
      this.addEdge(from, target, "references", at);
    };
    for (const t of this.typeRefs) emit(t.from, this.resolve((t.node as ts.TypeReferenceNode).typeName, "type"), t.node);
    for (const v of this.valueRefs) emit(v.from, this.resolve(v.node, "value"), v.node);
  }
}

/** Extract one source file. `sf` must be one of the extracted files (env.defsOf(sf) defined). */
export function extractTsFile(env: TsProgramEnv, sf: ts.SourceFile): TsFileResult {
  const defs = env.defsOf(sf);
  if (!defs) throw new Error(`not an extracted file: ${sf.fileName}`);
  return new FileExtractor(env, sf, defs).run();
}
