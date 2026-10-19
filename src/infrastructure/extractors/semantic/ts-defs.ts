// Syntax-only registry of the declarations one TypeScript source file contributes to
// the graph, with their node ids.
//
// It reads nothing but the file's own AST (no type checker), so the ids of ANY file can be
// computed on demand: when the per-file extraction resolves a reference into another file it
// asks for that file's defs here. That is what lets a file be extracted on its own (the
// incremental path) and still produce exactly the ids a whole-project run produces.

import { ts } from "ts-morph";
import { makeId, normalizeLabel } from "../../../domain/shared/id.ts";
import type { NodeKind } from "../../../domain/graph/model.ts";

/** Declarations that carry a structured `signature`. */
export type FnLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

export interface TsDef {
  id: string;
  label: string;
  kind: NodeKind;
  /** Primary declaration: the node's location and the key references resolve to. */
  decl: ts.Node;
  /** Module id (top-level defs) or the owning def's id (members). */
  owner: string;
  /** Structural edge from `owner`: `contains` for top-level defs, `method` for members. */
  relation: "contains" | "method";
  /** Source of the signature, when function-like (interface method signatures carry none). */
  fn?: FnLike;
}

export interface FileDefs {
  fileId: string;
  relPath: string;
  /** Emission order (one entry per graph node). */
  defs: TsDef[];
  /** Every registered declaration node → its id (merged declarations share one id). */
  idByDecl: Map<ts.Node, string>;
}

function isFunctionInitializer(init: ts.Node | undefined): init is ts.ArrowFunction | ts.FunctionExpression {
  return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
}

/** `(x)`, `x as T`, `x satisfies T`, `<T>x`, `x!` → x. */
export function unwrapExpression(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === kind);
}

function isAmbient(n: ts.Node): boolean {
  if (n.getSourceFile().isDeclarationFile) return true;
  for (let cur: ts.Node | undefined = n; cur; cur = cur.parent) {
    if (hasModifier(cur, ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

/** Text of a declaration name usable as a node label (computed names are skipped). */
export function nameText(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

// Node ids are `makeId(<owner>, <name>)`, i.e. case-folded and punctuation-collapsed, so two
// DISTINCT declarations of one scope can map to the same id (`interface HostSpec` + `function
// hostSpec`, `class Parser` + `function parser`, a static and an instance member of the same
// name). The first declaration in registration order keeps the plain id — the id it always
// had — and every later colliding entity gets `<id>:<tag>` (then `<id>:<tag>_2`, ...), where the
// tag names its declaration kind. Declarations of the SAME entity (same exact name and tag:
// interface merging, overloads, a get/set pair) share one id and one node.
class ScopeIds {
  private readonly taken = new Set<string>();
  private readonly byEntity = new Map<string, string>();
  private readonly prefix: string;

  constructor(prefix: string, reserved?: string) {
    this.prefix = prefix;
    if (reserved !== undefined) this.taken.add(reserved);
  }

  /** The id for (name, tag), and whether this call allocated it (false: merged declaration). */
  alloc(name: string, tag: string): { id: string; fresh: boolean } {
    const entity = `${tag}\0${name}`;
    const known = this.byEntity.get(entity);
    if (known !== undefined) return { id: known, fresh: false };
    const base = makeId(this.prefix, name);
    let id = base;
    if (this.taken.has(id)) {
      const suffix = normalizeLabel(tag);
      id = `${base}:${suffix}`;
      for (let n = 2; this.taken.has(id); n++) id = `${base}:${suffix}_${n}`;
    }
    this.taken.add(id);
    this.byEntity.set(entity, id);
    return { id, fresh: true };
  }
}

interface DefSpec {
  decl: ts.Node;
  name: string;
  tag: string;
  kind: NodeKind;
  label: string;
  fn?: FnLike;
}

class DefCollector {
  readonly defs: TsDef[] = [];
  readonly idByDecl = new Map<ts.Node, string>();
  readonly fileId: string;
  readonly relPath: string;
  private readonly topScope: ScopeIds;
  private readonly memberScopes = new Map<string, ScopeIds>();

  constructor(fileId: string, relPath: string) {
    this.fileId = fileId;
    this.relPath = relPath;
    // The module id itself is taken: a symbol whose name normalizes to "" must not alias it.
    this.topScope = new ScopeIds(relPath, fileId);
  }

  private register(scope: ScopeIds, owner: string, relation: TsDef["relation"], spec: DefSpec): string {
    const { id, fresh } = scope.alloc(spec.name, spec.tag);
    this.idByDecl.set(spec.decl, id);
    if (!fresh) return id;
    const def: TsDef = { id, label: spec.label, kind: spec.kind, decl: spec.decl, owner, relation };
    if (spec.fn) def.fn = spec.fn;
    this.defs.push(def);
    return id;
  }

  // --- members ---------------------------------------------------------------

  private member(ownerId: string, spec: DefSpec): void {
    let scope = this.memberScopes.get(ownerId);
    if (scope === undefined) {
      scope = new ScopeIds(ownerId);
      this.memberScopes.set(ownerId, scope);
    }
    this.register(scope, ownerId, "method", spec);
  }

  private method(ownerId: string, decl: ts.Node, name: string, isStatic: boolean, fn?: FnLike): void {
    const spec: DefSpec = { decl, name, tag: isStatic ? "static" : "method", kind: "method", label: `${name}()` };
    if (fn) spec.fn = fn;
    this.member(ownerId, spec);
  }

  classMembers(cls: ts.ClassLikeDeclaration, classId: string): void {
    const ambient = isAmbient(cls);
    for (const m of cls.members) {
      if (!ts.isMethodDeclaration(m)) continue;
      // Overload signatures are not the method: keep implementations (+ abstract, + ambient).
      if (!ambient && m.body === undefined && !hasModifier(m, ts.SyntaxKind.AbstractKeyword)) continue;
      const name = nameText(m.name);
      if (name !== undefined) this.method(classId, m, name, hasModifier(m, ts.SyntaxKind.StaticKeyword), m);
    }
    for (const p of cls.members) {
      if (!ts.isPropertyDeclaration(p) || !isFunctionInitializer(p.initializer)) continue;
      const name = nameText(p.name);
      if (name !== undefined) this.method(classId, p, name, hasModifier(p, ts.SyntaxKind.StaticKeyword), p.initializer);
    }
    for (const a of cls.members) {
      if (ts.isGetAccessorDeclaration(a) || ts.isSetAccessorDeclaration(a)) {
        this.accessor(classId, a, hasModifier(a, ts.SyntaxKind.StaticKeyword));
      }
    }
  }

  // get/set accessors: one `accessor` node per property (a get/set pair merges).
  private accessor(ownerId: string, a: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration, isStatic: boolean): void {
    const name = nameText(a.name);
    if (name === undefined) return;
    const tag = isStatic ? "static_accessor" : "accessor";
    this.member(ownerId, { decl: a, name, tag, kind: "accessor", label: name, fn: a });
  }

  /** Methods of an object literal bound to a top-level variable (handler maps, adapters). */
  literalMembers(lit: ts.ObjectLiteralExpression, ownerId: string): void {
    for (const p of lit.properties) {
      if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
        this.accessor(ownerId, p, false);
        continue;
      }
      const name = nameText(p.name);
      if (name === undefined) continue;
      if (ts.isMethodDeclaration(p)) this.method(ownerId, p, name, false, p);
      else if (ts.isPropertyAssignment(p) && isFunctionInitializer(p.initializer)) {
        this.method(ownerId, p, name, false, p.initializer);
      }
    }
  }

  interfaceMembers(itf: ts.InterfaceDeclaration, itfId: string): void {
    for (const m of itf.members) {
      if (!ts.isMethodSignature(m)) continue;
      const name = nameText(m.name);
      if (name !== undefined) this.method(itfId, m, name, false);
    }
  }

  // --- top level -----------------------------------------------------------------

  topLevel(spec: DefSpec): string {
    return this.register(this.topScope, this.fileId, "contains", spec);
  }
}

/** Type aliases, enums and every other top-level variable (with its object-literal methods). */
function collectDataDefs(c: DefCollector, stmts: ts.NodeArray<ts.Statement>): void {
  for (const s of stmts) {
    if (ts.isTypeAliasDeclaration(s)) {
      c.topLevel({ decl: s, name: s.name.text, tag: "type", kind: "type", label: s.name.text });
    }
  }
  for (const s of stmts) {
    if (ts.isEnumDeclaration(s)) {
      c.topLevel({ decl: s, name: s.name.text, tag: "enum", kind: "enum", label: s.name.text });
    }
  }
  for (const s of stmts) {
    if (!ts.isVariableStatement(s)) continue;
    for (const vd of s.declarationList.declarations) {
      // Destructuring declarations bind other values' members — they are resolved, not nodes.
      if (!ts.isIdentifier(vd.name) || isFunctionInitializer(vd.initializer)) continue;
      const name = vd.name.text;
      const id = c.topLevel({ decl: vd, name, tag: "variable", kind: "variable", label: name });
      const init = vd.initializer && unwrapExpression(vd.initializer);
      if (init && ts.isObjectLiteralExpression(init)) c.literalMembers(init, id);
    }
  }
}

/** An anonymous default export becomes a node named `default`; `export default name` stays an alias. */
function collectDefaultExport(c: DefCollector, stmts: ts.NodeArray<ts.Statement>): void {
  for (const s of stmts) {
    if (ts.isFunctionDeclaration(s) && !s.name && hasModifier(s, ts.SyntaxKind.DefaultKeyword)) {
      if (s.body === undefined && !isAmbient(s)) continue;
      c.topLevel({ decl: s, name: "default", tag: "function", kind: "function", label: "default()", fn: s });
    } else if (ts.isClassDeclaration(s) && !s.name && hasModifier(s, ts.SyntaxKind.DefaultKeyword)) {
      c.classMembers(s, c.topLevel({ decl: s, name: "default", tag: "class", kind: "class", label: "default" }));
    } else if (ts.isExportAssignment(s) && !s.isExportEquals) {
      defaultExpression(c, s);
    }
  }
}

function defaultExpression(c: DefCollector, s: ts.ExportAssignment): void {
  const e = unwrapExpression(s.expression);
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) return; // alias of a named declaration
  // The `default` export symbol's declaration is the ExportAssignment itself.
  if (isFunctionInitializer(e)) {
    c.topLevel({ decl: s, name: "default", tag: "function", kind: "function", label: "default()", fn: e });
  } else if (ts.isClassExpression(e)) {
    const id = c.topLevel({ decl: e, name: "default", tag: "class", kind: "class", label: "default" });
    c.idByDecl.set(s, id);
    c.classMembers(e, id);
  } else {
    const id = c.topLevel({ decl: s, name: "default", tag: "variable", kind: "variable", label: "default" });
    if (ts.isObjectLiteralExpression(e)) c.literalMembers(e, id);
  }
}

/** Collect the graph definitions of `sf` (relPath: root-relative POSIX path). */
export function collectDefs(sf: ts.SourceFile, relPath: string): FileDefs {
  const c = new DefCollector(makeId(relPath), relPath);
  // The SourceFile is the module node: module-scope sites attribute to it, and a namespace
  // import (`import * as ns`) resolves to it.
  c.idByDecl.set(sf, c.fileId);
  const stmts = sf.statements;
  // Registration order decides which of two colliding declarations keeps the plain id:
  // classes, interfaces, functions, function-valued consts — the order ids were always
  // assigned in, so a symbol that used to win a collision keeps its id — then the kinds that
  // gained nodes later (type aliases, enums, variables, the anonymous default export).
  for (const s of stmts) {
    if (!ts.isClassDeclaration(s) || !s.name) continue;
    const name = s.name.text;
    const id = c.topLevel({ decl: s, name, tag: "class", kind: "class", label: name });
    c.classMembers(s, id);
  }
  for (const s of stmts) {
    if (!ts.isInterfaceDeclaration(s)) continue;
    const name = s.name.text;
    const id = c.topLevel({ decl: s, name, tag: "interface", kind: "interface", label: name });
    c.interfaceMembers(s, id);
  }
  for (const s of stmts) {
    if (!ts.isFunctionDeclaration(s) || !s.name) continue;
    if (s.body === undefined && !isAmbient(s)) continue; // overload signature
    const name = s.name.text;
    c.topLevel({ decl: s, name, tag: "function", kind: "function", label: `${name}()`, fn: s });
  }
  for (const s of stmts) {
    if (!ts.isVariableStatement(s)) continue;
    for (const vd of s.declarationList.declarations) {
      if (!ts.isIdentifier(vd.name) || !isFunctionInitializer(vd.initializer)) continue;
      const name = vd.name.text;
      c.topLevel({ decl: vd, name, tag: "function", kind: "function", label: `${name}()`, fn: vd.initializer });
    }
  }
  collectDataDefs(c, stmts);
  collectDefaultExport(c, stmts);
  return { fileId: c.fileId, relPath, defs: c.defs, idByDecl: c.idByDecl };
}
