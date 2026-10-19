// Syntax-only registry of the declarations one TypeScript source file contributes to
// the graph, with their node ids.
//
// It reads nothing but the file's own AST (no type checker), so the ids of ANY file can be
// computed on demand: when the per-file extraction resolves a reference into another file it
// asks for that file's defs here. That is what lets a file be extracted on its own (the
// incremental path) and still produce exactly the ids a whole-project run produces.

import { ts } from "ts-morph";
import { makeId } from "../../../domain/shared/id.ts";
import type { NodeKind } from "../../../domain/graph/model.ts";

/** Declarations that carry a structured `signature`. */
export type FnLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

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
  /** Source of the signature, when function-like. */
  fn?: FnLike;
  /** True for interface method signatures (they never carry a signature). */
  signatureless?: boolean;
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

class DefCollector {
  readonly defs: TsDef[] = [];
  readonly idByDecl = new Map<ts.Node, string>();
  readonly fileId: string;
  readonly relPath: string;

  constructor(fileId: string, relPath: string) {
    this.fileId = fileId;
    this.relPath = relPath;
  }

  add(def: TsDef): void {
    this.defs.push(def);
    this.idByDecl.set(def.decl, def.id);
  }

  // --- members ---------------------------------------------------------------

  private member(ownerId: string, decl: ts.Node, name: string, fn?: FnLike, signatureless?: boolean): void {
    const def: TsDef = {
      id: makeId(ownerId, name),
      label: `${name}()`,
      kind: "method",
      decl,
      owner: ownerId,
      relation: "method",
    };
    if (fn) def.fn = fn;
    if (signatureless) def.signatureless = true;
    this.add(def);
  }

  classMembers(cls: ts.ClassLikeDeclaration, classId: string): void {
    const ambient = isAmbient(cls);
    for (const m of cls.members) {
      if (!ts.isMethodDeclaration(m)) continue;
      // Overload signatures are not the method: keep implementations (+ abstract, + ambient).
      if (!ambient && m.body === undefined && !hasModifier(m, ts.SyntaxKind.AbstractKeyword)) continue;
      const name = nameText(m.name);
      if (name !== undefined) this.member(classId, m, name, m);
    }
    for (const p of cls.members) {
      if (!ts.isPropertyDeclaration(p) || !isFunctionInitializer(p.initializer)) continue;
      const name = nameText(p.name);
      if (name !== undefined) this.member(classId, p, name, p.initializer);
    }
  }

  interfaceMembers(itf: ts.InterfaceDeclaration, itfId: string): void {
    for (const m of itf.members) {
      if (!ts.isMethodSignature(m)) continue;
      const name = nameText(m.name);
      if (name !== undefined) this.member(itfId, m, name, undefined, true);
    }
  }

  // --- top level -----------------------------------------------------------------

  topLevel(decl: ts.Node, name: string, kind: NodeKind, label: string, fn?: FnLike): string {
    const id = makeId(this.relPath, name);
    const def: TsDef = { id, label, kind, decl, owner: this.fileId, relation: "contains" };
    if (fn) def.fn = fn;
    this.add(def);
    return id;
  }
}

/** Collect the graph definitions of `sf` (relPath: root-relative POSIX path). */
export function collectDefs(sf: ts.SourceFile, relPath: string): FileDefs {
  const c = new DefCollector(makeId(relPath), relPath);
  // The SourceFile is the module node: module-scope sites attribute to it, and a namespace
  // import (`import * as ns`) resolves to it.
  c.idByDecl.set(sf, c.fileId);
  const stmts = sf.statements;
  for (const s of stmts) {
    if (!ts.isClassDeclaration(s) || !s.name) continue;
    const id = c.topLevel(s, s.name.text, "class", s.name.text);
    c.classMembers(s, id);
  }
  for (const s of stmts) {
    if (!ts.isInterfaceDeclaration(s)) continue;
    const id = c.topLevel(s, s.name.text, "interface", s.name.text);
    c.interfaceMembers(s, id);
  }
  for (const s of stmts) {
    if (!ts.isFunctionDeclaration(s) || !s.name) continue;
    if (s.body === undefined && !isAmbient(s)) continue; // overload signature
    c.topLevel(s, s.name.text, "function", `${s.name.text}()`, s);
  }
  for (const s of stmts) {
    if (!ts.isVariableStatement(s)) continue;
    for (const vd of s.declarationList.declarations) {
      if (!ts.isIdentifier(vd.name) || !isFunctionInitializer(vd.initializer)) continue;
      c.topLevel(vd, vd.name.text, "function", `${vd.name.text}()`, vd.initializer);
    }
  }
  return { fileId: c.fileId, relPath, defs: c.defs, idByDecl: c.idByDecl };
}
