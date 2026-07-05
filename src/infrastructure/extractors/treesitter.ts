// tree-sitter engine: loads grammars (WASM), walks the AST, emits nodes/edges
// and raw calls. Symbol resolution happens later (resolve.ts). Each
// LanguageConfig lists the node types for classes/functions/imports/calls.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";
import type { ExtractionResult, GraphEdge, GraphNode, ImportBinding, NodeKind, RawCall } from "../../domain/graph/model.ts";
import { makeId } from "../../domain/shared/id.ts";
import { detectLang } from "../../application/graph/detect.ts";
import type { Lang } from "../../application/graph/detect.ts";
import { GRAMMAR_WASM_FILES, parserAssetsAdvice, verifyParserAssets } from "./parser-assets.ts";

// Asset directories are resolved LAZILY (first getLanguage call), not at module scope: a
// missing/corrupted assets/wasm/ install must surface as the actionable
// parserAssetsAdvice error below, not kill this module's import with a bare resolve error.

interface LanguageConfig {
  classTypes: Set<string>;
  interfaceTypes: Set<string>;
  functionTypes: Set<string>; // top-level / standalone functions
  methodTypes: Set<string>; // functions defined inside a class
  importTypes: Set<string>;
  callTypes: Set<string>;
  nameField: string; // tree-sitter field that holds a definition's name
}

const CONFIGS: Record<Lang, LanguageConfig> = {
  python: {
    classTypes: new Set(["class_definition"]),
    interfaceTypes: new Set(),
    functionTypes: new Set(["function_definition"]),
    methodTypes: new Set(["function_definition"]),
    importTypes: new Set(["import_statement", "import_from_statement"]),
    callTypes: new Set(["call"]),
    nameField: "name",
  },
  javascript: {
    classTypes: new Set(["class_declaration"]),
    interfaceTypes: new Set(),
    functionTypes: new Set(["function_declaration", "generator_function_declaration"]),
    methodTypes: new Set(["method_definition"]),
    importTypes: new Set(["import_statement"]),
    callTypes: new Set(["call_expression", "new_expression"]),
    nameField: "name",
  },
  typescript: {
    classTypes: new Set(["class_declaration", "abstract_class_declaration"]),
    interfaceTypes: new Set(["interface_declaration"]),
    functionTypes: new Set(["function_declaration", "generator_function_declaration"]),
    methodTypes: new Set(["method_definition", "method_signature"]),
    importTypes: new Set(["import_statement"]),
    callTypes: new Set(["call_expression", "new_expression"]),
    nameField: "name",
  },
  tsx: {
    classTypes: new Set(["class_declaration", "abstract_class_declaration"]),
    interfaceTypes: new Set(["interface_declaration"]),
    functionTypes: new Set(["function_declaration", "generator_function_declaration"]),
    methodTypes: new Set(["method_definition", "method_signature"]),
    importTypes: new Set(["import_statement"]),
    callTypes: new Set(["call_expression", "new_expression"]),
    nameField: "name",
  },
  go: {
    classTypes: new Set(["type_declaration"]),
    interfaceTypes: new Set(),
    functionTypes: new Set(["function_declaration"]),
    methodTypes: new Set(["method_declaration"]),
    importTypes: new Set(["import_declaration"]),
    callTypes: new Set(["call_expression"]),
    nameField: "name",
  },
  java: {
    classTypes: new Set(["class_declaration", "enum_declaration", "record_declaration"]),
    interfaceTypes: new Set(["interface_declaration"]),
    functionTypes: new Set(), // Java has no top-level functions
    methodTypes: new Set(["method_declaration", "constructor_declaration"]),
    importTypes: new Set(["import_declaration"]),
    callTypes: new Set(["method_invocation", "object_creation_expression"]),
    nameField: "name",
  },
  csharp: {
    classTypes: new Set(["class_declaration", "struct_declaration", "record_declaration", "enum_declaration"]),
    interfaceTypes: new Set(["interface_declaration"]),
    functionTypes: new Set(["local_function_statement"]),
    methodTypes: new Set(["method_declaration", "constructor_declaration"]),
    importTypes: new Set(["using_directive"]),
    callTypes: new Set(["invocation_expression", "object_creation_expression"]),
    nameField: "name",
  },
  // tree-sitter-kotlin exposes NO field names: definition names surface as a direct
  // simple_identifier / type_identifier child (see defName's identifier fallback).
  // Kotlin interfaces parse as class_declaration too, so they classify as classes.
  kotlin: {
    classTypes: new Set(["class_declaration", "object_declaration"]),
    interfaceTypes: new Set(),
    functionTypes: new Set(["function_declaration"]),
    methodTypes: new Set(["function_declaration"]),
    importTypes: new Set(["import_header"]),
    callTypes: new Set(["call_expression"]),
    nameField: "name",
  },
  rust: {
    // impl_item has no name field; the identifier fallback labels it by its type name so
    // methods declared in impl blocks attach to the right type-shaped container.
    classTypes: new Set(["struct_item", "enum_item", "union_item", "impl_item"]),
    interfaceTypes: new Set(["trait_item"]),
    functionTypes: new Set(["function_item"]),
    methodTypes: new Set(["function_item", "function_signature_item"]),
    importTypes: new Set(["use_declaration"]),
    callTypes: new Set(["call_expression", "macro_invocation"]),
    nameField: "name",
  },
  ruby: {
    // `module` is Ruby's namespace/mixin container — class-shaped for graph purposes.
    // require/require_relative are plain method calls, so importTypes stays empty
    // (import-guided resolution simply does not apply).
    classTypes: new Set(["class", "module"]),
    interfaceTypes: new Set(),
    functionTypes: new Set(["method"]),
    methodTypes: new Set(["method", "singleton_method"]),
    importTypes: new Set(),
    callTypes: new Set(["call"]),
    nameField: "name",
  },
  php: {
    classTypes: new Set(["class_declaration", "trait_declaration", "enum_declaration"]),
    interfaceTypes: new Set(["interface_declaration"]),
    functionTypes: new Set(["function_definition"]),
    methodTypes: new Set(["method_declaration"]),
    importTypes: new Set(["namespace_use_declaration"]),
    callTypes: new Set([
      "function_call_expression",
      "member_call_expression",
      "scoped_call_expression",
      "object_creation_expression",
    ]),
    nameField: "name",
  },
};

let initialized = false;
const langCache = new Map<Lang, Language>();

// Resolved on first use; verifyParserAssets performs the same require.resolve calls the
// old module-scope constants did, but failure becomes parserAssetsAdvice instead of a
// bare ENOENT/resolve stack trace.
let assetDirs: { wtsDir: string; wasmsDir: string } | null = null;

function resolveAssetDirs(): { wtsDir: string; wasmsDir: string } {
  if (assetDirs) return assetDirs;
  const report = verifyParserAssets();
  if (!report.ok || report.webTreeSitterDir === null || report.wasmsDir === null) {
    throw new Error(parserAssetsAdvice(report));
  }
  assetDirs = { wtsDir: report.webTreeSitterDir, wasmsDir: report.wasmsDir };
  return assetDirs;
}

async function getLanguage(lang: Lang): Promise<Language> {
  const { wtsDir, wasmsDir } = resolveAssetDirs();
  if (!initialized) {
    await Parser.init({
      locateFile: (scriptName: string) => join(wtsDir, scriptName),
    });
    initialized = true;
  }
  const cached = langCache.get(lang);
  if (cached) return cached;
  const wasmPath = join(wasmsDir, GRAMMAR_WASM_FILES[lang]);
  if (!existsSync(wasmPath)) {
    throw new Error(parserAssetsAdvice(verifyParserAssets()));
  }
  const bytes = readFileSync(wasmPath);
  const language = await Language.load(bytes);
  langCache.set(lang, language);
  return language;
}

function loc(node: Node): string {
  return `L${node.startPosition.row + 1}`;
}

// Last segment of a (possibly dotted/member) callee expression.
function calleeName(fnNode: Node | null): { name: string; isMember: boolean } | null {
  if (!fnNode) return null;
  const t = fnNode.type;
  // bare identifier: foo()   (PHP names its identifier node "name"/"qualified_name")
  if (t === "identifier" || t === "type_identifier" || t === "name") {
    return { name: fnNode.text, isMember: false };
  }
  if (t === "qualified_name") {
    const last = fnNode.namedChildren.at(-1);
    return { name: (last ?? fnNode).text, isMember: false };
  }
  // member / attribute / selector: obj.method()  pkg.Func()  obj.Method() (C#)
  if (
    t === "member_expression" ||
    t === "attribute" ||
    t === "selector_expression" ||
    t === "member_access_expression"
  ) {
    // the property/field/name child holds the final name
    const prop =
      fnNode.childForFieldName("property") ??
      fnNode.childForFieldName("attribute") ??
      fnNode.childForFieldName("field") ??
      fnNode.childForFieldName("name") ??
      fnNode.namedChildren.at(-1);
    if (prop) return { name: prop.text, isMember: true };
  }
  return null;
}

// Last segment of a type name (Foo.Bar -> Bar) for object-creation callees.
function lastTypeSegment(typeNode: Node): string {
  const ids = typeNode.descendantsOfType(["identifier", "type_identifier"]);
  const last = ids.at(-1);
  return last ? last.text : typeNode.text;
}

// Base name of a (possibly generic/qualified) type, IGNORING type arguments.
// `TypeAdapter<Object>` -> "TypeAdapter" (not "Object"); `a.b.Foo` -> "Foo".
function baseTypeName(node: Node): string | null {
  const t = node.type;
  if (t === "type_identifier" || t === "identifier") return node.text;
  if (t === "generic_type") {
    // first child that is the type name, before type_arguments
    for (const c of node.namedChildren) {
      if (c && c.type !== "type_arguments") return baseTypeName(c);
    }
  }
  if (t === "scoped_type_identifier" || t === "qualified_name") {
    const ids = node.descendantsOfType("type_identifier");
    const last = ids.at(-1);
    return last ? last.text : node.text;
  }
  // fallback: first type_identifier not inside type_arguments
  const first = node.namedChildren.find(
    (c) => c && (c.type === "type_identifier" || c.type === "identifier"),
  );
  return first ? first.text : null;
}

function inferType(typeNode: Node | null, valueNode: Node | null): string | null {
  let t = typeNode ? baseTypeName(typeNode) : null;
  if ((!t || t === "var") && valueNode) {
    // `var x = new Foo()` -> Foo
    const oce =
      valueNode.type === "object_creation_expression"
        ? valueNode
        : valueNode.descendantsOfType("object_creation_expression")[0];
    const ty = oce?.childForFieldName("type");
    if (ty) t = baseTypeName(ty);
  }
  return t && t !== "var" ? t : null;
}

// call_expression / call / invocation_expression all hold the callee in field "function".
const FUNCTION_FIELD_CALLS = new Set(["call_expression", "call", "invocation_expression"]);

// Java method_invocation -> field "name" (+ "object" => member call).
function methodInvocationCallee(node: Node): { name: string; isMember: boolean } | null {
  const name = node.childForFieldName("name");
  return name ? { name: name.text, isMember: !!node.childForFieldName("object") } : null;
}

// Java/C# object_creation_expression -> field "type".
function objectCreationCallee(node: Node): { name: string; isMember: boolean } | null {
  const ty = node.childForFieldName("type");
  if (ty) return { name: lastTypeSegment(ty), isMember: false };
  // PHP: `new Foo()` carries the class as a plain name/qualified_name child, no field.
  const nameChild = node.namedChildren.find((c) => c?.type === "name" || c?.type === "qualified_name");
  return nameChild ? { name: nameChild.text.split("\\").at(-1) ?? nameChild.text, isMember: false } : null;
}

// Extract the callee of a call node. Each grammar names things differently:
//   call_expression / call / invocation_expression -> field "function"
//   new_expression (JS/TS)                          -> field "constructor"
//   method_invocation (Java)                        -> field "name" (+ "object")
//   object_creation_expression (Java/C#)            -> field "type"
function getCallee(node: Node): { name: string; isMember: boolean } | null {
  const t = node.type;
  if (FUNCTION_FIELD_CALLS.has(t)) {
    const viaFunction = calleeName(node.childForFieldName("function"));
    if (viaFunction) return viaFunction;
    // Ruby `call` puts the callee in field "method" (receiver in "receiver").
    const method = node.childForFieldName("method");
    if (method) return { name: method.text, isMember: node.childForFieldName("receiver") !== null };
    // tree-sitter-kotlin exposes no fields: the callee is the first named child
    // (simple_identifier for foo(), navigation_expression for obj.foo()).
    const first = node.namedChildren[0];
    if (first?.type === "simple_identifier") return { name: first.text, isMember: false };
    if (first?.type === "navigation_expression") {
      const last = first.namedChildren.at(-1);
      const id = last?.type === "navigation_suffix" ? last.namedChildren[0] : last;
      if (id) return { name: id.text, isMember: true };
    }
    return null;
  }
  // PHP member/scoped calls carry the method in field "name".
  if (t === "member_call_expression" || t === "scoped_call_expression") {
    const n = node.childForFieldName("name");
    return n ? { name: n.text, isMember: true } : null;
  }
  if (t === "function_call_expression") return calleeName(node.childForFieldName("function"));
  if (t === "macro_invocation") {
    // rust: foo!(...) — field "macro"; treat as a plain call to the macro name.
    const m = node.childForFieldName("macro");
    return m ? { name: m.text, isMember: false } : null;
  }
  if (t === "new_expression") return calleeName(node.childForFieldName("constructor"));
  if (t === "method_invocation") return methodInvocationCallee(node);
  if (t === "object_creation_expression") return objectCreationCallee(node);
  return null;
}

// Simple receiver name of a member call (`factory.m()` -> "factory", `this.m()`
// -> "this"). Java/C# only — used for receiver-type disambiguation. Returns null
// for complex receivers (chains, calls) we can't cheaply type.
function getReceiverName(node: Node): string | null {
  if (node.type === "method_invocation") return methodInvocationReceiver(node);
  if (node.type === "invocation_expression") return invocationExprReceiver(node);
  return null;
}

function methodInvocationReceiver(node: Node): string | null {
  const obj = node.childForFieldName("object");
  if (!obj) return null;
  if (obj.type === "this") return "this";
  if (obj.type === "identifier") return obj.text;
  return null;
}

function invocationExprReceiver(node: Node): string | null {
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_access_expression") return null;
  const expr = fn.childForFieldName("expression");
  if (!expr) return null;
  if (expr.type === "this_expression") return "this";
  if (expr.type === "identifier") return expr.text;
  return null;
}

interface HeritageRef { name: string; relation: "extends" | "implements" }

function isHeritageTypeId(n: Node | null): n is Node {
  return !!n && (n.type === "identifier" || n.type === "type_identifier" || n.type === "attribute");
}

// Heritage syntax differs a lot per language:
//   Python -> field "superclasses" (argument_list)
//   TS/JS  -> class_heritage > extends_clause / implements_clause
//   Java   -> "superclass" (extends) + "super_interfaces" (implements)
//   C#     -> base_list (no extends/implements distinction -> treat as extends)
function heritageNames(classNode: Node): HeritageRef[] {
  const names: HeritageRef[] = [];
  const supers = classNode.childForFieldName("superclasses");
  if (supers) {
    for (const c of supers.namedChildren) if (isHeritageTypeId(c)) names.push({ name: c.text, relation: "extends" });
  }
  for (const c of classNode.namedChildren) {
    if (c) names.push(...heritageFromChild(c));
  }
  return names;
}

function heritageFromChild(c: Node): HeritageRef[] {
  if (c.type === "class_heritage") return tsHeritage(c);
  if (c.type === "superclass") return javaSuperclass(c);
  if (c.type === "super_interfaces") return javaInterfaces(c);
  if (c.type === "base_list") return csharpBaseList(c);
  return [];
}

function tsHeritage(c: Node): HeritageRef[] {
  const out: HeritageRef[] = [];
  for (const clause of c.namedChildren) {
    if (!clause) continue;
    const rel = clause.type === "implements_clause" ? "implements" : "extends";
    for (const id of clause.namedChildren) if (isHeritageTypeId(id)) out.push({ name: id.text, relation: rel });
  }
  return out;
}

// Java: extends — one type, possibly generic. Take base name only.
function javaSuperclass(c: Node): HeritageRef[] {
  const base = c.namedChildren.find((x) => x && x.type !== "type_arguments");
  const name = base ? baseTypeName(base) : null;
  return name ? [{ name, relation: "extends" }] : [];
}

// Java: implements — a type_list of (possibly generic) types.
function javaInterfaces(c: Node): HeritageRef[] {
  const list = c.namedChildren.find((x) => x?.type === "type_list") ?? c;
  const out: HeritageRef[] = [];
  for (const ty of list.namedChildren) {
    const name = ty ? baseTypeName(ty) : null;
    if (name) out.push({ name, relation: "implements" });
  }
  return out;
}

// C#: base class + interfaces (undistinguished), each possibly generic.
function csharpBaseList(c: Node): HeritageRef[] {
  const out: HeritageRef[] = [];
  for (const ty of c.namedChildren) {
    const name = ty ? baseTypeName(ty) : null;
    if (name) out.push({ name, relation: "extends" });
  }
  return out;
}

function recordFieldDecl(m: Node, map: Map<string, string>): void {
  let typeNode = m.childForFieldName("type");
  let decls = m.namedChildren.filter((c) => c?.type === "variable_declarator");
  if (!typeNode) {
    // C#: field_declaration wraps a variable_declaration (type + declarators)
    const vd = m.namedChildren.find((c) => c?.type === "variable_declaration");
    if (vd) {
      typeNode = vd.namedChildren[0] ?? null;
      decls = vd.namedChildren.filter((c) => c?.type === "variable_declarator");
    }
  }
  const tname = typeNode ? baseTypeName(typeNode) : null;
  if (!tname) return;
  for (const d of decls) {
    const n = d?.childForFieldName("name") ?? d?.namedChildren.find((x) => x?.type === "identifier");
    if (n) map.set(n.text, tname);
  }
}

function recordPropertyDecl(m: Node, map: Map<string, string>): void {
  // C# property: type + name
  const typeNode = m.childForFieldName("type") ?? m.namedChildren[0];
  const nameNode = m.childForFieldName("name");
  const tname = typeNode ? baseTypeName(typeNode) : null;
  if (tname && nameNode) map.set(nameNode.text, tname);
}

function recordMethodParams(methodNode: Node, map: Map<string, string>, lang: Lang): void {
  const paramType = lang === "java" ? "formal_parameter" : "parameter";
  for (const p of methodNode.descendantsOfType(paramType)) {
    if (!p) continue;
    const typeNode = p.childForFieldName("type") ?? p.namedChildren[0] ?? null;
    const nameNode = p.childForFieldName("name");
    const t = inferType(typeNode, null);
    if (t && nameNode) map.set(nameNode.text, t);
  }
}

function recordMethodLocals(methodNode: Node, map: Map<string, string>, lang: Lang): void {
  const localType = lang === "java" ? "local_variable_declaration" : "variable_declaration";
  for (const d of methodNode.descendantsOfType(localType)) {
    if (!d) continue;
    const typeNode = d.childForFieldName("type") ?? d.namedChildren[0] ?? null;
    for (const vd of d.namedChildren.filter((c) => c?.type === "variable_declarator")) {
      const nameNode = vd?.childForFieldName("name") ?? vd?.namedChildren.find((x) => x?.type === "identifier");
      const valueNode = vd?.childForFieldName("value") ?? vd?.namedChildren[vd.namedChildren.length - 1] ?? null;
      const t = inferType(typeNode, valueNode ?? null);
      if (t && nameNode) map.set(nameNode.text, t);
    }
  }
}

const lastSeg = (s: string): string => s.split(/[./]/).findLast(Boolean) ?? s;
const strip = (s: string): string => s.replaceAll(/(?:^['"`]|['"`]$)/g, "");

// Extract the names a file brings into scope (localName) and where from
// (module). This is what lets resolve.ts prove a call targets an imported
// symbol. Each grammar structures imports differently.
function importNamesAndModule(node: Node, lang: Lang): { module: string; names: string[] } {
  if (lang === "python") return pythonImport(node);
  if (lang === "javascript" || lang === "typescript" || lang === "tsx") return jsImport(node);
  if (lang === "go") return goImport(node);
  if (lang === "java") return javaImport(node);
  if (lang === "csharp") return csharpImport(node);
  return { module: "", names: [] };
}

function pythonImport(node: Node): { module: string; names: string[] } {
  return node.type === "import_from_statement" ? pythonFromImport(node) : pythonPlainImport(node);
}

function pythonFromImport(node: Node): { module: string; names: string[] } {
  const mod = node.childForFieldName("module_name");
  const module = mod ? mod.text : "";
  const names: string[] = [];
  for (const c of node.namedChildren) {
    if (!c || c === mod) continue;
    if (c.type === "dotted_name") names.push(lastSeg(c.text));
    else if (c.type === "aliased_import") {
      const alias = c.childForFieldName("alias");
      names.push(alias ? alias.text : lastSeg(c.text));
    }
  }
  return { module, names };
}

function pythonPlainImport(node: Node): { module: string; names: string[] } {
  const names: string[] = [];
  for (const c of node.namedChildren) {
    if (c?.type === "dotted_name") names.push(c.text.split(".")[0]!);
    else if (c?.type === "aliased_import") {
      const alias = c.childForFieldName("alias");
      if (alias) names.push(alias.text);
    }
  }
  return { module: "", names };
}

function jsImport(node: Node): { module: string; names: string[] } {
  const src = node.descendantsOfType("string")[0];
  const module = src ? strip(src.text) : "";
  const names: string[] = [];
  for (const spec of node.descendantsOfType("import_specifier")) {
    if (!spec) continue;
    const alias = spec.childForFieldName("alias");
    const name = spec.childForFieldName("name");
    const picked = (alias ?? name)?.text;
    if (picked) names.push(picked);
  }
  for (const ns of node.descendantsOfType("namespace_import")) {
    const id = ns?.descendantsOfType("identifier")[0];
    if (id) names.push(id.text);
  }
  const clause = node.namedChildren.find((c) => c?.type === "import_clause");
  const def = clause?.namedChildren.find((c) => c?.type === "identifier");
  if (def) names.push(def.text);
  return { module, names };
}

function goImport(node: Node): { module: string; names: string[] } {
  const spec = node.descendantsOfType("import_spec")[0] ?? node;
  const path = spec?.descendantsOfType("interpreted_string_literal")[0];
  const module = path ? strip(path.text) : "";
  const alias = spec?.descendantsOfType("package_identifier")[0];
  return { module, names: [alias ? alias.text : lastSeg(module)] };
}

function javaImport(node: Node): { module: string; names: string[] } {
  const sc = node.descendantsOfType("scoped_identifier")[0] ?? node;
  const module = sc.text;
  return { module, names: [lastSeg(module)] };
}

function csharpImport(node: Node): { module: string; names: string[] } {
  // using imports a whole namespace; only a `using X = Y` alias binds a name
  const ids = node.descendantsOfType("identifier");
  return { module: ids.map((i) => i?.text).filter(Boolean).join("."), names: [] };
}

export async function extractFile(
  relPath: string,
  source: string,
  lang: Lang,
): Promise<ExtractionResult> {
  const language = await getLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const cfg = CONFIGS[lang];

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const rawCalls: RawCall[] = [];

  if (!tree) return { nodes, edges, rawCalls, imports: [] };

  const fileId = makeId(relPath);
  nodes.push({
    id: fileId,
    label: relPath,
    fileType: "code",
    sourceFile: relPath,
    kind: "module",
  });

  // Receiver-type tracking (Java/C#): field/property name -> declared type, per
  // class. Lets `factory.make()` resolve `make` to TokenFactory's method.
  const classFieldTypes = new Map<string, Map<string, string>>();
  const classIdToLabel = new Map<string, string>();

  function scanFields(classNode: Node, classId: string): void {
    if (lang !== "java" && lang !== "csharp") return;
    const body = classNode.namedChildren.find(
      (c) => c?.type === "class_body" || c?.type === "declaration_list",
    );
    if (!body) return;
    const map = new Map<string, string>();
    for (const m of body.namedChildren) {
      if (!m) continue;
      if (m.type === "field_declaration") recordFieldDecl(m, map);
      else if (m.type === "property_declaration") recordPropertyDecl(m, map);
    }
    classFieldTypes.set(classId, map);
  }

  // Per-method local scope (Java/C#): parameters and local variable types.
  // This is where most member calls live (`JsonReader in` -> `in.nextString()`).
  const methodLocalTypes = new Map<string, Map<string, string>>();

  function scanMethodScope(methodNode: Node, methodId: string): void {
    if (lang !== "java" && lang !== "csharp") return;
    const map = new Map<string, string>();
    recordMethodParams(methodNode, map, lang);
    recordMethodLocals(methodNode, map, lang);
    methodLocalTypes.set(methodId, map);
  }

  function defName(node: Node): string | null {
    const nameNode = node.childForFieldName(cfg.nameField);
    if (nameNode) return nameNode.text;
    // Rust impl_item: the container is the Self TYPE (field "type"), never the trait —
    // `impl Greeter for Foo` must attach its methods to Foo.
    if (node.type === "impl_item") {
      const ty = node.childForFieldName("type");
      if (ty) return baseTypeName(ty) ?? ty.text;
    }
    // Grammars without field names (Kotlin; Rust's impl_item): the definition name is a
    // direct identifier-shaped child.
    const idChild = node.namedChildren.find(
      (c) => c?.type === "simple_identifier" || c?.type === "type_identifier" || c?.type === "constant",
    );
    if (idChild) return idChild.text;
    // Go type_declaration wraps a type_spec holding the name.
    const spec = node.namedChildren.find((c) => c?.type === "type_spec");
    if (spec) {
      const n = spec.childForFieldName("name");
      if (n) return n.text;
    }
    return null;
  }

  // Go methods are top-level (func (s *T) M()): the owner type comes from the
  // receiver param list, not from AST nesting like Python/TS.
  function receiverClassId(node: Node): string | null {
    const recv = node.namedChildren.find((c) => c?.type === "parameter_list");
    if (!recv) return null;
    const types = recv.descendantsOfType("type_identifier");
    const t = types[0];
    return t ? makeId(relPath, t.text) : null;
  }

  function emitDef(
    node: Node,
    kind: NodeKind,
    enclosingClassId: string | null,
  ): string | null {
    const name = defName(node);
    if (!name) return null;
    const ownerPart = enclosingClassId ?? relPath;
    const id = makeId(ownerPart, name);
    const label = kind === "function" || kind === "method" ? `${name}()` : name;
    if (kind === "class" || kind === "interface") classIdToLabel.set(id, name);
    nodes.push({
      id,
      label,
      fileType: "code",
      sourceFile: relPath,
      sourceLocation: loc(node),
      kind,
    });
    edges.push({
      source: enclosingClassId ?? fileId,
      target: id,
      relation: enclosingClassId ? "method" : "contains",
      confidence: "EXTRACTED",
      sourceFile: relPath,
      sourceLocation: loc(node),
      weight: 1,
    });
    return id;
  }

  function handleClassNode(node: Node): string | null {
    const kind: NodeKind = cfg.interfaceTypes.has(node.type) ? "interface" : "class";
    const id = emitDef(node, kind, null);
    if (id) {
      // inheritance/implements edges
      collectHeritage(node, id);
      scanFields(node, id);
    }
    return id;
  }

  // Python/TS methods nest in a class (enclosingClassId); Go methods carry a receiver.
  // Fall back to a plain function if neither applies.
  function handleMethodNode(node: Node, enclosingClassId: string | null): string | null {
    const classId = enclosingClassId ?? receiverClassId(node);
    if (!classId) return emitDef(node, "function", null);
    const id = emitDef(node, "method", classId);
    if (id) scanMethodScope(node, id);
    return id;
  }

  function resolveReceiverType(
    node: Node,
    enclosingDefId: string,
    enclosingClassId: string | null,
  ): string | undefined {
    const recv = getReceiverName(node);
    if (recv === "this" || recv === "base") {
      return enclosingClassId ? classIdToLabel.get(enclosingClassId) : undefined;
    }
    if (!recv) return undefined;
    // locals/params shadow fields
    return (
      methodLocalTypes.get(enclosingDefId)?.get(recv) ??
      (enclosingClassId ? classFieldTypes.get(enclosingClassId)?.get(recv) : undefined)
    );
  }

  function handleCallNode(node: Node, enclosingDefId: string | null, enclosingClassId: string | null): void {
    const callee = getCallee(node);
    if (!callee || !enclosingDefId) return;
    const receiverType =
      callee.isMember && (lang === "java" || lang === "csharp")
        ? resolveReceiverType(node, enclosingDefId, enclosingClassId)
        : undefined;
    rawCalls.push({
      callee: callee.name,
      sourceFile: relPath,
      sourceLocation: loc(node),
      fromId: enclosingDefId,
      isMember: callee.isMember,
      receiverType,
    });
  }

  // Walk the AST. enclosingDefId = nearest function/method (caller context for
  // calls). enclosingClassId = nearest class/interface (for method ownership).
  function walk(
    node: Node,
    enclosingDefId: string | null,
    enclosingClassId: string | null,
  ): void {
    let nextDefId = enclosingDefId;
    let nextClassId = enclosingClassId;

    if (cfg.classTypes.has(node.type) || cfg.interfaceTypes.has(node.type)) {
      nextClassId = handleClassNode(node) ?? nextClassId;
    } else if (cfg.methodTypes.has(node.type)) {
      nextDefId = handleMethodNode(node, enclosingClassId) ?? nextDefId;
    } else if (cfg.functionTypes.has(node.type)) {
      nextDefId = emitDef(node, "function", null) ?? nextDefId;
    } else if (cfg.callTypes.has(node.type)) {
      handleCallNode(node, enclosingDefId, enclosingClassId);
    } else if (cfg.importTypes.has(node.type)) {
      collectImport(node);
    }

    for (const child of node.namedChildren) {
      if (child) walk(child, nextDefId, nextClassId);
    }
  }

  function collectHeritage(classNode: Node, classId: string): void {
    for (const h of heritageNames(classNode)) {
      // Provisional edge to a by-label placeholder id; resolve.ts re-targets it
      // to the real node if found (and leaves it as an external ref otherwise).
      edges.push({
        source: classId,
        target: makeId(h.name),
        relation: h.relation,
        confidence: "INFERRED",
        sourceFile: relPath,
        sourceLocation: loc(classNode),
        weight: 1,
      });
    }
  }

  const imports: ImportBinding[] = [];

  function collectImport(node: Node): void {
    const { module, names } = importNamesAndModule(node, lang);

    for (const n of names) imports.push({ localName: n, module, sourceFile: relPath });

    if (module) {
      const modId = makeId("module", module);
      nodes.push({ id: modId, label: module, fileType: "concept", sourceFile: relPath, kind: "module" });
      edges.push({
        source: fileId,
        target: modId,
        relation: "imports",
        confidence: "EXTRACTED",
        sourceFile: relPath,
        sourceLocation: loc(node),
        weight: 1,
      });
    }
  }

  walk(tree.rootNode, null, null);

  return { nodes, edges, rawCalls, imports };
}

// ---------------------------------------------------------------------------
// GraphExtractor adapter — wraps extractFile en el puerto de dominio.
//
// OVERRIDE D1 (aprobado por el orchestrador):
// TreesitterExtractor.extract() devuelve rawCalls? e imports? SIN resolver.
// buildGraph acumula el combined set y llama resolveSymbols() UNA SOLA VEZ
// de forma global, preservando edges cross-extractor/cross-file byte-idénticos
// al pipeline previo. Esta desviación es INTENCIONAL para cumplir REQ-ER-4
// (no-regresión) por encima de REQ-EP-3 (rawCalls internos al extractor).
// ---------------------------------------------------------------------------

import type { GraphExtractor, GraphExtractionResult } from "../../domain/graph/extractor.ts";
import { ExtractCache, contentHash } from "../sqlite/extract-cache.ts";

export class TreesitterExtractor implements GraphExtractor {
  readonly id = "treesitter" as const;
  readonly version: string;

  constructor(version: string) {
    this.version = version;
  }

  supports(filePath: string): boolean {
    return detectLang(filePath) !== null;
  }

  async extract(root: string, files: string[]): Promise<GraphExtractionResult> {
    const allNodes: GraphNode[] = [];
    const allEdges: GraphEdge[] = [];
    const allRaw: RawCall[] = [];
    const allImports: ImportBinding[] = [];
    const errors: string[] = [];
    const diagnostics: string[] = [];
    const start = Date.now();

    // Per-file incremental cache: pure content-hash keyed results (see extract-cache.ts).
    // Every failure path inside the cache degrades to a miss — it can never break a build.
    const cache = new ExtractCache(root, this.version);
    let cacheHits = 0;

    for (const abs of files) {
      const rel = relative(root, abs).split(sep).join("/");
      const lang = detectLang(abs);
      if (!lang) continue;
      let source: string;
      try {
        source = readFileSync(abs, "utf8");
      } catch {
        continue; // archivo no legible — se omite silenciosamente
      }
      const hash = contentHash(source);
      const cached = cache.get(rel, hash);
      if (cached !== null) {
        cacheHits++;
        allNodes.push(...(cached.nodes as GraphNode[]));
        allEdges.push(...(cached.edges as GraphEdge[]));
        allRaw.push(...(cached.rawCalls as RawCall[]));
        allImports.push(...(cached.imports as ImportBinding[]));
        continue;
      }
      try {
        const res = await extractFile(rel, source, lang);
        allNodes.push(...res.nodes);
        allEdges.push(...res.edges);
        allRaw.push(...res.rawCalls);
        allImports.push(...res.imports);
        cache.put(rel, hash, res);
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`  ! extract failed: ${rel}: ${msg}`);
        errors.push(`extract failed for ${rel}: ${msg}`);
        diagnostics.push(`tree-sitter extract failed: ${rel}: ${msg}`);
      }
    }
    cache.prune(files.map((abs) => relative(root, abs).split(sep).join("/")));
    cache.close();
    if (cacheHits > 0) diagnostics.push(`extract cache: ${cacheHits}/${files.length} files unchanged (reused)`);

    return {
      schemaVersion: 1,
      extractor: { id: this.id, version: this.version },
      nodes: allNodes,
      edges: allEdges,
      // OVERRIDE D1: rawCalls/imports expuestos para resolveSymbols() global en buildGraph
      rawCalls: allRaw,
      imports: allImports,
      diagnostics,
      durationMs: Date.now() - start,
      errors,
    };
  }
}

// Debug helper: print the AST node types for calibration.
export async function dumpTree(source: string, lang: Lang, maxDepth = 4): Promise<string> {
  const language = await getLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const lines: string[] = [];
  function rec(node: Node, depth: number): void {
    if (depth > maxDepth) return;
    const text = node.namedChildCount === 0 ? ` "${node.text.slice(0, 20)}"` : "";
    lines.push(`${"  ".repeat(depth)}${node.type}${text}`);
    for (const c of node.namedChildren) if (c) rec(c, depth + 1);
  }
  if (tree) rec(tree.rootNode, 0);
  return lines.join("\n");
}
