// Syntax-only facts about one TypeScript file that decide what an incremental build must
// re-extract when it changes (see ts-plan.ts):
//
// - its SHAPE: everything another file can observe of it. A per-file result depends on the
//   file itself, on the ids of the declarations it reaches (ts-defs.ts, syntax only) and on
//   what the checker tells it about the files it imports. Two versions of a file with the same
//   shape give every OTHER file the same result, so an edit that keeps the shape re-extracts
//   only the edited file. The shape is the source text with the parts no other file can see
//   cut out (bodies whose type is fixed by an annotation), plus the file's node ids.
// - whether it is GLOBAL: declarations that reach files without an import (scripts,
//   `declare global`, `declare module "x"`, triple-slash directives). Those have no
//   dependency edge to follow, so changing one rebuilds everything.
// - its MODULE SPECIFIERS: the imports whose resolution makes the dependency graph.

import { createHash } from "node:crypto";
import { ts } from "ts-morph";
import { collectDefs } from "./ts-defs.ts";

export interface FileFacts {
  shape: string;
  global: boolean;
}

function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === kind);
}

/** A script, or a module that declares into the global scope / other modules. */
export function isGlobalFile(sf: ts.SourceFile): boolean {
  if (sf.referencedFiles.length > 0 || sf.typeReferenceDirectives.length > 0 || sf.libReferenceDirectives.length > 0) {
    return true;
  }
  let isModule = false;
  for (const s of sf.statements) {
    if (ts.isNamespaceExportDeclaration(s)) return true; // `export as namespace X` (UMD global)
    if (ts.isModuleDeclaration(s) && (ts.isStringLiteral(s.name) || (s.flags & ts.NodeFlags.GlobalAugmentation) !== 0)) {
      return true; // `declare module "x" {…}` (ambient module / augmentation), `declare global {…}`
    }
    if (
      ts.isImportDeclaration(s) ||
      ts.isExportDeclaration(s) ||
      ts.isExportAssignment(s) ||
      (ts.isImportEqualsDeclaration(s) && ts.isExternalModuleReference(s.moduleReference)) ||
      hasModifier(s, ts.SyntaxKind.ExportKeyword)
    ) {
      isModule = true;
    }
  }
  return !isModule;
}

/**
 * Property declarations without a type and without an initializer take their type from the
 * constructor's assignments (`noImplicitAny` inference), so then the constructor body is shape.
 */
function constructorBodyIsPrivate(ctor: ts.ConstructorDeclaration): boolean {
  return ctor.parent.members.every(
    (m) =>
      !ts.isPropertyDeclaration(m) ||
      m.type !== undefined ||
      m.initializer !== undefined ||
      hasModifier(m, ts.SyntaxKind.StaticKeyword),
  );
}

/** The subtree of `n` no other file can observe, or undefined when all of `n` is visible. */
function privatePart(n: ts.Node): ts.Node | undefined {
  if (ts.isConstructorDeclaration(n)) return n.body && constructorBodyIsPrivate(n) ? n.body : undefined;
  if (ts.isSetAccessorDeclaration(n) || ts.isClassStaticBlockDeclaration(n)) return n.body;
  if (
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isGetAccessorDeclaration(n)
  ) {
    // An annotated return type fixes the signature; without one the body IS the return type.
    return n.type !== undefined ? n.body : undefined;
  }
  if (ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isParameter(n)) {
    return n.type !== undefined ? n.initializer : undefined;
  }
  return undefined;
}

/** The shape hash of `sf` (relPath: root-relative POSIX path, as its node ids use). */
export function fileShape(sf: ts.SourceFile, relPath: string): string {
  const text = sf.text;
  const parts: string[] = [];
  let at = 0;
  const cut = (hidden: ts.Node): void => {
    parts.push(text.slice(at, hidden.getStart(sf)), `\u0000${hidden.kind}\u0000`);
    at = hidden.end;
  };
  const visit = (n: ts.Node): void => {
    const hidden = privatePart(n);
    // Children come in source order, so the cuts do too.
    ts.forEachChild(n, (c) => {
      if (c === hidden) cut(c);
      else visit(c);
    });
  };
  visit(sf);
  parts.push(text.slice(at));
  // The ids: an object literal hidden behind an annotation still declares methods (ts-defs.ts).
  const ids = collectDefs(sf, relPath).defs.map((d) => `${d.id}\u0001${d.kind}\u0001${d.label}`);
  return createHash("sha256").update(parts.join("")).update("\u0002").update(ids.join("\n")).digest("hex");
}

export function fileFacts(sf: ts.SourceFile, relPath: string): FileFacts {
  return { shape: fileShape(sf, relPath), global: isGlobalFile(sf) };
}

/**
 * Every module specifier `sf` resolves: imports, re-exports, `import x = require()`,
 * `import("…")` calls and `import("…")` types. In source order, duplicates included.
 */
export function moduleSpecifiers(sf: ts.SourceFile): ts.StringLiteralLike[] {
  const out: ts.StringLiteralLike[] = [];
  const add = (e: ts.Node | undefined): void => {
    if (e !== undefined && ts.isStringLiteralLike(e)) out.push(e);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) add(n.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      add(n.moduleReference.expression);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) add(n.arguments[0]);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) add(n.argument.literal);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
