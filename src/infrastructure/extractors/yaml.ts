// yaml.ts — YamlInfraExtractor: parses YAML infra files (docker-compose, GH Actions,
// generic config) and emits graph nodes/edges.
//
// Uses web-tree-sitter + tree-sitter-yaml.wasm — same wasm loader pattern as treesitter.ts.
// No new npm dependencies.
//
// Grammar: tree-sitter-yaml.wasm is the maintained @tree-sitter-grammars/tree-sitter-yaml
// build (C external scanner, tree-sitter-cli 0.25, ABI 14), vendored by
// scripts/vendor-wasm.ts. The earlier tree-sitter-wasms@0.1.13 build used a C++ scanner whose
// libc++ imports web-tree-sitter 0.25's runtime does not export, so every parse() threw and
// every YAML file silently took the line-based path. That path is kept as the per-file
// fallback: for a file tree-sitter cannot parse cleanly (templated YAML such as Helm charts,
// syntax errors) and for a grammar that fails to load or parse at all — extraction never
// depends on the wasm being healthy. `probeYamlGrammar()` is the publish-time smoke check
// (scripts/check-native-assets.ts).
//
// Bridge code↔infra: when a docker-compose service declares `build.context` or
// `dockerfile` pointing to an actual code file in the project, emits a `reads` edge
// from the service node to the code module node using the SAME id scheme as
// treesitter.ts (~L476): makeId(normalizedRelPath).

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { GraphEdge, GraphNode } from "../../domain/graph/model.ts";
import { makeId } from "../../domain/shared/id.ts";
import { readPackageVersion } from "../../version.ts";
import type { GraphExtractionResult, GraphExtractor } from "../../domain/graph/extractor.ts";
import { detectLang } from "../../application/graph/detect.ts";
import { YAML_WASM_FILE, wasmAssetsDir } from "./parser-assets.ts";

const require = createRequire(import.meta.url);
const WTS_DIR = dirname(require.resolve("web-tree-sitter"));
// Same vendored assets/wasm/ directory the code-grammar loader (treesitter.ts) uses —
// single source of truth, see parser-assets.ts.
const WASMS_DIR = wasmAssetsDir();

// ---------------------------------------------------------------------------
// tree-sitter YAML grammar (best-effort — the line-based fallback covers any failure)
// ---------------------------------------------------------------------------

type TsTree = import("web-tree-sitter").Tree;

/** One loaded grammar per wasm path. `reason` is set once it failed to load or a parse threw
 *  (a wasm/runtime mismatch) — from then on every file takes the line-based path. */
interface YamlGrammar {
  parser: Parser | null;
  reason: string | null;
}

let runtimeReady: Promise<void> | null = null;
const grammars = new Map<string, Promise<YamlGrammar>>();

function defaultYamlWasmPath(): string {
  return join(WASMS_DIR, YAML_WASM_FILE);
}

function loadYamlGrammar(wasmPath: string): Promise<YamlGrammar> {
  let grammar = grammars.get(wasmPath);
  if (!grammar) {
    grammar = (async (): Promise<YamlGrammar> => {
      try {
        runtimeReady ??= Parser.init({ locateFile: (scriptName: string) => join(WTS_DIR, scriptName) });
        await runtimeReady;
        const language = await Language.load(readFileSync(wasmPath));
        const parser = new Parser();
        parser.setLanguage(language);
        return { parser, reason: null };
      } catch (err) {
        return { parser: null, reason: `tree-sitter-yaml.wasm failed to load (${(err as Error).message})` };
      }
    })();
    grammars.set(wasmPath, grammar);
  }
  return grammar;
}

/** Parse with tree-sitter; null when the grammar is unusable (the caller falls back). The
 *  caller owns the returned tree and must delete() it — wasm memory is not GC-managed. */
function parseYaml(grammar: YamlGrammar, content: string): TsTree | null {
  if (grammar.reason !== null || !grammar.parser) return null;
  try {
    return grammar.parser.parse(content);
  } catch (err) {
    grammar.reason = `tree-sitter-yaml parse failed (${(err as Error).message})`;
    return null;
  }
}

/**
 * Smoke-check the vendored YAML grammar: load it and parse a small valid document. Returns
 * null when tree-sitter parses it cleanly, else why it cannot (the extractor would fall back).
 */
export async function probeYamlGrammar(wasmPath: string = defaultYamlWasmPath()): Promise<string | null> {
  const grammar = await loadYamlGrammar(wasmPath);
  const tree = parseYaml(grammar, "services:\n  api:\n    depends_on: [db]\n");
  if (!tree) return grammar.reason ?? "tree-sitter-yaml unavailable";
  try {
    return tree.rootNode.hasError ? "tree-sitter-yaml reported errors on a valid probe document" : null;
  } finally {
    tree.delete();
  }
}

// ---------------------------------------------------------------------------
// Tree-sitter YAML AST helpers (only used when tree-sitter parse succeeds)
// ---------------------------------------------------------------------------

type TsNode = import("web-tree-sitter").Node;

/** Collect all non-null direct children of a node. */
function children(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) out.push(child);
  }
  return out;
}

/** Strip surrounding quote characters from a quoted scalar's raw text. */
function unquoteScalar(text: string): string {
  return text.length >= 2 ? text.slice(1, -1) : text;
}

/** Resolve the first scalar value inside a flow_node/block_node container. */
function scalarFromContainer(node: TsNode): string | null {
  for (const child of children(node)) {
    if (child.type === "comment") continue;
    const result = scalarText(child);
    if (result !== null) return result;
  }
  return null;
}

function scalarText(node: TsNode | null | undefined): string | null {
  if (!node) return null;
  switch (node.type) {
    case "plain_scalar":
    case "block_scalar":
      return node.text;
    case "double_quote_scalar":
    case "single_quote_scalar":
      return unquoteScalar(node.text);
    case "flow_node":
    case "block_node":
      return scalarFromContainer(node);
    default:
      return null;
  }
}

function findFirstMapping(node: TsNode | null | undefined): TsNode | null {
  if (!node) return null;
  if (node.type === "block_mapping" || node.type === "flow_mapping") return node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type === "comment") continue;
    const found = findFirstMapping(child);
    if (found) return found;
  }
  return null;
}

interface MappingPair { key: string; valueNode: TsNode }

function getMappingPairs(mappingNode: TsNode | null | undefined): MappingPair[] {
  if (!mappingNode) return [];
  const pairType = mappingNode.type === "block_mapping" ? "block_mapping_pair" : "flow_pair";
  const pairs: MappingPair[] = [];
  for (let i = 0; i < mappingNode.childCount; i++) {
    const child = mappingNode.child(i);
    if (child?.type !== pairType) continue;
    const keyNode = child.childForFieldName("key");
    const valueNode = child.childForFieldName("value");
    if (!keyNode || !valueNode) continue;
    const key = scalarText(keyNode);
    if (key !== null) pairs.push({ key, valueNode });
  }
  return pairs;
}

function lookupKey(mappingNode: TsNode | null | undefined, key: string): TsNode | null {
  for (const pair of getMappingPairs(mappingNode)) {
    if (pair.key === key) return pair.valueNode;
  }
  return null;
}

function blockSequenceItems(node: TsNode): TsNode[] {
  const items: TsNode[] = [];
  for (const child of children(node)) {
    if (child.type !== "block_sequence_item") continue;
    // The grammar gives `- <value>` no field name: the value is the item's first named
    // child that is not a comment (the `-` marker is anonymous).
    const valueNode = children(child).find((c) => c.isNamed && c.type !== "comment");
    if (valueNode) items.push(valueNode);
  }
  return items;
}

function flowSequenceItems(node: TsNode): TsNode[] {
  const items: TsNode[] = [];
  for (const child of children(node)) {
    if (child.type === "flow_node" || child.type === "plain_scalar") items.push(child);
  }
  return items;
}

function getSequenceItems(node: TsNode | null | undefined): TsNode[] {
  if (!node) return [];
  if (node.type === "block_sequence") return blockSequenceItems(node);
  if (node.type === "flow_sequence") return flowSequenceItems(node);
  for (const child of children(node)) {
    if (child.type === "comment") continue;
    if (child.type === "block_sequence" || child.type === "flow_sequence") {
      return getSequenceItems(child);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Bridge helper (shared between tree-sitter and fallback paths)
// ---------------------------------------------------------------------------

/**
 * Resolve a path value from a YAML file to a project-relative code file path.
 * Returns null if the path doesn't point to a real code file.
 */
function resolveCodePath(contextValue: string, yamlAbsPath: string, root: string): string | null {
  const absCandidate = resolvePath(dirname(yamlAbsPath), contextValue);
  if (!existsSync(absCandidate)) return null;
  if (detectLang(absCandidate) === null) return null;
  const rel = relative(root, absCandidate);
  if (rel.startsWith("..")) return null;
  return rel;
}

/**
 * Emit a `reads` edge from an infra node to the code module node.
 * Uses the SAME id scheme as treesitter.ts L476: makeId(normalizedRelPath).
 */
function emitBridgeEdge(
  infraNodeId: string,
  codeRelPath: string,
  yamlRelPath: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const moduleId = makeId(codeRelPath);
  nodes.push({
    id: moduleId,
    label: codeRelPath,
    fileType: "code",
    sourceFile: codeRelPath,
    kind: "module",
  });
  edges.push({
    source: infraNodeId,
    target: moduleId,
    relation: "reads",
    confidence: "EXTRACTED",
    sourceFile: yamlRelPath,
    weight: 1,
  });
}

/**
 * Resolve `pathValue` to a code file and, if it points at one, emit a bridge edge.
 * No-op when the value is empty or does not resolve to a project code file.
 */
function tryBridge(
  infraNodeId: string,
  pathValue: string | null,
  yamlAbsPath: string,
  root: string,
  yamlRelPath: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  if (!pathValue) return;
  const codeRelPath = resolveCodePath(pathValue, yamlAbsPath, root);
  if (codeRelPath) emitBridgeEdge(infraNodeId, codeRelPath, yamlRelPath, nodes, edges);
}

/** Emit a `deploys` edge from a service to a dependency name. */
function pushDeployEdge(svcId: string, depName: string, yamlRelPath: string, edges: GraphEdge[]): void {
  edges.push({ source: svcId, target: makeId(yamlRelPath, depName), relation: "deploys", confidence: "EXTRACTED", sourceFile: yamlRelPath, weight: 1 });
}

// ---------------------------------------------------------------------------
// Tree-sitter extraction path (used when wasm works)
// ---------------------------------------------------------------------------

type YamlFormat = "docker-compose" | "gh-actions" | "generic";

function tsDetectFormat(rootMapping: TsNode): YamlFormat {
  for (const { key } of getMappingPairs(rootMapping)) {
    if (key === "services") return "docker-compose";
    if (key === "jobs") return "gh-actions";
  }
  return "generic";
}

/** Emit `deploys` edges for a service's `depends_on` (list or mapping form). */
function tsEmitDependsOn(svcId: string, svcMapping: TsNode, yamlRelPath: string, edges: GraphEdge[]): void {
  const dependsOnNode = lookupKey(svcMapping, "depends_on");
  if (!dependsOnNode) return;

  const items = getSequenceItems(dependsOnNode);
  if (items.length > 0) {
    for (const item of items) {
      const depName = scalarText(item);
      if (depName) pushDeployEdge(svcId, depName, yamlRelPath, edges);
    }
    return;
  }

  const depMapping = findFirstMapping(dependsOnNode);
  if (!depMapping) return;
  for (const { key: depName } of getMappingPairs(depMapping)) {
    pushDeployEdge(svcId, depName, yamlRelPath, edges);
  }
}

/** Emit bridge edges for a service's `build` (mapping with context/dockerfile, or scalar). */
function tsEmitBuildBridge(
  svcId: string,
  svcMapping: TsNode,
  yamlRelPath: string,
  yamlAbsPath: string,
  root: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const buildNode = lookupKey(svcMapping, "build");
  if (!buildNode) return;

  const buildMapping = findFirstMapping(buildNode);
  if (!buildMapping) {
    tryBridge(svcId, scalarText(buildNode), yamlAbsPath, root, yamlRelPath, nodes, edges);
    return;
  }
  tryBridge(svcId, scalarText(lookupKey(buildMapping, "context")), yamlAbsPath, root, yamlRelPath, nodes, edges);
  tryBridge(svcId, scalarText(lookupKey(buildMapping, "dockerfile")), yamlAbsPath, root, yamlRelPath, nodes, edges);
}

/** Extract a single docker-compose service: node, configures edge, depends_on + build. */
function tsExtractService(
  svcName: string,
  svcValue: TsNode,
  configId: string,
  yamlRelPath: string,
  yamlAbsPath: string,
  root: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const svcId = makeId(yamlRelPath, svcName);
  nodes.push({ id: svcId, label: svcName, fileType: "config", sourceFile: yamlRelPath, kind: "service" });
  edges.push({ source: configId, target: svcId, relation: "configures", confidence: "EXTRACTED", sourceFile: yamlRelPath, weight: 1 });

  const svcMapping = findFirstMapping(svcValue);
  if (!svcMapping) return;

  tsEmitDependsOn(svcId, svcMapping, yamlRelPath, edges);
  tsEmitBuildBridge(svcId, svcMapping, yamlRelPath, yamlAbsPath, root, nodes, edges);
}

function tsExtractDockerCompose(
  rootMapping: TsNode,
  yamlRelPath: string,
  yamlAbsPath: string,
  root: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const configId = makeId(yamlRelPath);
  nodes.push({ id: configId, label: yamlRelPath, fileType: "config", sourceFile: yamlRelPath, kind: "config" });

  const servicesValue = lookupKey(rootMapping, "services");
  const servicesMapping = findFirstMapping(servicesValue);
  if (!servicesMapping) return;

  for (const { key: svcName, valueNode: svcValue } of getMappingPairs(servicesMapping)) {
    tsExtractService(svcName, svcValue, configId, yamlRelPath, yamlAbsPath, root, nodes, edges);
  }
}

function tsExtractGhActions(rootMapping: TsNode, yamlRelPath: string, nodes: GraphNode[], edges: GraphEdge[]): void {
  const configId = makeId(yamlRelPath);
  nodes.push({ id: configId, label: yamlRelPath, fileType: "config", sourceFile: yamlRelPath, kind: "config" });
  const jobsValue = lookupKey(rootMapping, "jobs");
  const jobsMapping = findFirstMapping(jobsValue);
  if (!jobsMapping) return;
  for (const { key: jobId } of getMappingPairs(jobsMapping)) {
    const jobNodeId = makeId(yamlRelPath, jobId);
    nodes.push({ id: jobNodeId, label: jobId, fileType: "config", sourceFile: yamlRelPath, kind: "service" });
    edges.push({ source: jobNodeId, target: configId, relation: "reads", confidence: "EXTRACTED", sourceFile: yamlRelPath, weight: 1 });
  }
}

// ---------------------------------------------------------------------------
// Fallback line-based extraction path (no dependencies)
// ---------------------------------------------------------------------------

/**
 * Minimal line-based YAML structure extractor.
 * Handles docker-compose and GH Actions patterns with 2-space-per-level indentation.
 * Detects tab indentation as a syntax error.
 */
function fallbackExtract(
  content: string,
  yamlRelPath: string,
  yamlAbsPath: string,
  root: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): string[] {
  const errors: string[] = [];
  const lines = content.split("\n");

  // Detect tab indentation — invalid YAML
  if (lines.some((l) => /(?:^\t)|(?: \t)/.test(l))) {
    errors.push(`yaml-infra: YAML syntax error in ${yamlRelPath} (tab indentation) — skipping`);
    return errors;
  }

  // Detect top-level keys
  const topLevelKeys = new Set<string>();
  for (const line of lines) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*):/.exec(line);
    if (m?.[1]) topLevelKeys.add(m[1]);
  }

  if (topLevelKeys.size === 0) {
    // Possibly empty or comment-only YAML — not an error, just emit nothing
    return errors;
  }

  if (topLevelKeys.has("services")) {
    fallbackExtractDockerCompose(lines, yamlRelPath, yamlAbsPath, root, nodes, edges);
  } else if (topLevelKeys.has("jobs")) {
    fallbackExtractGhActions(lines, yamlRelPath, nodes, edges);
  } else {
    // Generic config file
    nodes.push({ id: makeId(yamlRelPath), label: yamlRelPath, fileType: "config", sourceFile: yamlRelPath, kind: "config" });
  }

  return errors;
}

type DcState = "root" | "services" | "service" | "build" | "depends_on";

/** Mutable line-based parser state for the docker-compose fallback. */
interface DcParser {
  state: DcState;
  serviceIndent: number;   // indent of service names under `services:`
  subkeyIndent: number;    // indent of build/depends_on under a service
  buildSubIndent: number;  // indent of context/dockerfile under `build:`
  depListIndent: number;   // indent of list items under `depends_on:`
  curSvcId: string;
}

/** Immutable context (ids + sinks) shared across docker-compose fallback handlers. */
interface DcContext {
  configId: string;
  yamlRelPath: string;
  yamlAbsPath: string;
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Strip an inline `#` comment and leading/trailing whitespace; returns null for blank/comment lines. */
function parseYamlLine(rawLine: string): { indent: number; content: string } | null {
  const commentIdx = rawLine.indexOf(" #");
  const line = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
  const trimmed = line.trimEnd();
  if (trimmed === "" || /^\s*#/.test(trimmed)) return null;
  const indent = trimmed.length - trimmed.trimStart().length;
  return { indent, content: trimmed.trimStart() };
}

function dcHandleTopLevel(p: DcParser, content: string): void {
  if (content.startsWith("services:")) {
    p.state = "services";
    p.serviceIndent = -1;
  } else if (p.state !== "root") {
    p.state = "root";
  }
}

function dcHandleServiceName(p: DcParser, content: string, ctx: DcContext): void {
  const m = /^([a-zA-Z0-9_][a-zA-Z0-9_.-]*):/.exec(content);
  if (!m) return;
  const curSvcName = m[1]!;
  p.curSvcId = makeId(ctx.yamlRelPath, curSvcName);
  ctx.nodes.push({ id: p.curSvcId, label: curSvcName, fileType: "config", sourceFile: ctx.yamlRelPath, kind: "service" });
  ctx.edges.push({ source: ctx.configId, target: p.curSvcId, relation: "configures", confidence: "EXTRACTED", sourceFile: ctx.yamlRelPath, weight: 1 });
  p.state = "service";
  p.subkeyIndent = -1;
  p.buildSubIndent = -1;
  p.depListIndent = -1;
}

function dcHandleInlineDepends(p: DcParser, content: string, ctx: DcContext): void {
  const inlineList = /^depends_on:\s*\[([^\]]*)\]/.exec(content);
  if (!inlineList?.[1]) return;
  for (const dep of inlineList[1].split(",").map((s) => s.trim()).filter(Boolean)) {
    pushDeployEdge(p.curSvcId, dep, ctx.yamlRelPath, ctx.edges);
  }
}

function dcHandleServiceSubkey(p: DcParser, content: string, ctx: DcContext): void {
  if (content.startsWith("build:")) {
    p.state = "build";
    p.buildSubIndent = -1;
  } else if (content.startsWith("depends_on:")) {
    p.state = "depends_on";
    p.depListIndent = -1;
    dcHandleInlineDepends(p, content, ctx); // depends_on: [inline-list] on same line
  } else {
    // Other service-level key — stay in "service" state (was build/depends_on)
    p.state = "service";
  }
}

function dcHandleBuildSub(p: DcParser, content: string, ctx: DcContext): void {
  const ctxM = /^context:\s*(.+)/.exec(content);
  if (ctxM?.[1]) tryBridge(p.curSvcId, ctxM[1].trim(), ctx.yamlAbsPath, ctx.root, ctx.yamlRelPath, ctx.nodes, ctx.edges);
  const dfM = /^dockerfile:\s*(.+)/.exec(content);
  if (dfM?.[1]) tryBridge(p.curSvcId, dfM[1].trim(), ctx.yamlAbsPath, ctx.root, ctx.yamlRelPath, ctx.nodes, ctx.edges);
}

function dcHandleDependsSub(p: DcParser, content: string, ctx: DcContext): void {
  // "- depName" or "depName:" (long form)
  const listM = /^-\s+(.+)/.exec(content);
  if (listM?.[1]) {
    pushDeployEdge(p.curSvcId, listM[1].trim().replace(/:$/, ""), ctx.yamlRelPath, ctx.edges);
    return;
  }
  const mapM = /^([a-zA-Z0-9_-]+):/.exec(content);
  if (mapM?.[1]) pushDeployEdge(p.curSvcId, mapM[1], ctx.yamlRelPath, ctx.edges);
}

/** Service-state line: lock in subkey indent and dispatch service-level keys. */
function dcHandleServiceLevel(p: DcParser, indent: number, content: string, ctx: DcContext): void {
  if (p.subkeyIndent < 0 && indent > p.serviceIndent) p.subkeyIndent = indent;
  if (indent === p.subkeyIndent) dcHandleServiceSubkey(p, content, ctx);
}

/** Build-state line: lock in build-sub indent and parse context/dockerfile. */
function dcHandleBuildLevel(p: DcParser, indent: number, content: string, ctx: DcContext): void {
  if (p.buildSubIndent < 0 && indent > p.subkeyIndent) p.buildSubIndent = indent;
  if (indent === p.buildSubIndent) dcHandleBuildSub(p, content, ctx);
}

/** depends_on-state line: lock in list indent and parse dependency entries. */
function dcHandleDependsLevel(p: DcParser, indent: number, content: string, ctx: DcContext): void {
  if (p.depListIndent < 0 && indent > p.subkeyIndent) p.depListIndent = indent;
  if (indent === p.depListIndent) dcHandleDependsSub(p, content, ctx);
}

/** Dispatch an indented line while inside the `services` subtree. */
function dcHandleActiveLine(p: DcParser, indent: number, content: string, ctx: DcContext): void {
  // Determine service indent from the first indented line under `services:`
  if (p.state === "services" && p.serviceIndent < 0) p.serviceIndent = indent;

  if (indent === p.serviceIndent) {
    dcHandleServiceName(p, content, ctx);
    return;
  }
  if (p.state === "service" && p.curSvcId) {
    dcHandleServiceLevel(p, indent, content, ctx);
    return;
  }
  if (p.state === "build" && p.curSvcId) {
    dcHandleBuildLevel(p, indent, content, ctx);
    return;
  }
  if (p.state === "depends_on" && p.curSvcId) {
    dcHandleDependsLevel(p, indent, content, ctx);
  }
}

function dcIsActiveState(state: DcState): boolean {
  return state === "services" || state === "service" || state === "build" || state === "depends_on";
}

/** Lightweight docker-compose parser — line-based state machine. */
function fallbackExtractDockerCompose(
  lines: string[],
  yamlRelPath: string,
  yamlAbsPath: string,
  root: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const configId = makeId(yamlRelPath);
  nodes.push({ id: configId, label: yamlRelPath, fileType: "config", sourceFile: yamlRelPath, kind: "config" });

  const ctx: DcContext = { configId, yamlRelPath, yamlAbsPath, root, nodes, edges };
  const p: DcParser = {
    state: "root",
    serviceIndent: -1,
    subkeyIndent: -1,
    buildSubIndent: -1,
    depListIndent: -1,
    curSvcId: "",
  };

  for (const rawLine of lines) {
    const parsed = parseYamlLine(rawLine);
    if (!parsed) continue;
    const { indent, content } = parsed;

    if (indent === 0) {
      dcHandleTopLevel(p, content);
      continue;
    }
    if (dcIsActiveState(p.state)) dcHandleActiveLine(p, indent, content, ctx);
  }
}

/** Lightweight GH Actions parser — extract job names. */
function fallbackExtractGhActions(
  lines: string[],
  yamlRelPath: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const configId = makeId(yamlRelPath);
  nodes.push({ id: configId, label: yamlRelPath, fileType: "config", sourceFile: yamlRelPath, kind: "config" });

  let inJobs = false;
  let jobIndent = -1;

  for (const rawLine of lines) {
    const parsed = parseYamlLine(rawLine);
    if (!parsed) continue;
    const { indent, content } = parsed;

    if (indent === 0) {
      inJobs = content.startsWith("jobs:");
      jobIndent = -1;
      continue;
    }

    if (!inJobs) continue;
    if (jobIndent < 0) jobIndent = indent;
    if (indent === jobIndent) ghEmitJob(content, configId, yamlRelPath, nodes, edges);
  }
}

/** Emit a job node + `reads` edge for a single GH Actions job-name line. */
function ghEmitJob(content: string, configId: string, yamlRelPath: string, nodes: GraphNode[], edges: GraphEdge[]): void {
  const m = /^([a-zA-Z0-9_][a-zA-Z0-9_-]*):/.exec(content);
  if (!m?.[1]) return;
  const jobNodeId = makeId(yamlRelPath, m[1]);
  nodes.push({ id: jobNodeId, label: m[1], fileType: "config", sourceFile: yamlRelPath, kind: "service" });
  edges.push({ source: jobNodeId, target: configId, relation: "reads", confidence: "EXTRACTED", sourceFile: yamlRelPath, weight: 1 });
}

// ---------------------------------------------------------------------------
// Per-file orchestration (shared by the extractor's main loop)
// ---------------------------------------------------------------------------

/** Emit nodes/edges for a parsed root mapping according to its detected format. */
function tsExtractByFormat(
  rootMapping: TsNode,
  yamlRelPath: string,
  yamlAbsPath: string,
  root: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const format = tsDetectFormat(rootMapping);
  if (format === "docker-compose") {
    tsExtractDockerCompose(rootMapping, yamlRelPath, yamlAbsPath, root, nodes, edges);
  } else if (format === "gh-actions") {
    tsExtractGhActions(rootMapping, yamlRelPath, nodes, edges);
  } else {
    nodes.push({ id: makeId(yamlRelPath), label: yamlRelPath, fileType: "config", sourceFile: yamlRelPath, kind: "config" });
  }
}

/**
 * Attempt the tree-sitter extraction path for one file. Returns true when the file was
 * handled; false to fall through to the line-based extractor — the grammar is unusable, or
 * the file does not parse cleanly (templated YAML, syntax errors), which the line-based path
 * either reads tolerantly or reports (tab indentation).
 */
function tryTreeSitterFile(
  grammar: YamlGrammar,
  content: string,
  yamlRelPath: string,
  yamlAbsPath: string,
  root: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): boolean {
  const tree = parseYaml(grammar, content);
  if (!tree) return false;
  try {
    if (tree.rootNode.hasError) return false;
    const rootMapping = findFirstMapping(tree.rootNode);
    if (!rootMapping) {
      // Empty, comment-only or sequence-rooted document: a generic config node.
      nodes.push({ id: makeId(yamlRelPath), label: yamlRelPath, fileType: "config", sourceFile: yamlRelPath, kind: "config" });
      return true;
    }
    tsExtractByFormat(rootMapping, yamlRelPath, yamlAbsPath, root, nodes, edges);
    return true;
  } finally {
    tree.delete();
  }
}

/** Extract a single YAML file via tree-sitter (when usable) or the line-based fallback. */
function extractYamlFile(
  file: string,
  root: string,
  grammar: YamlGrammar,
  nodes: GraphNode[],
  edges: GraphEdge[],
  errors: string[],
): void {
  const yamlRelPath = relative(root, file);
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (readErr) {
    errors.push(`yaml-infra: cannot read ${yamlRelPath}: ${String(readErr)}`);
    return;
  }

  if (tryTreeSitterFile(grammar, content, yamlRelPath, file, root, nodes, edges)) return;

  // ------ Line-based fallback path ------
  const fileErrors = fallbackExtract(content, yamlRelPath, file, root, nodes, edges);
  for (const e of fileErrors) errors.push(e);
}

// ---------------------------------------------------------------------------
// YamlInfraExtractor
// ---------------------------------------------------------------------------

export interface YamlInfraExtractorOptions {
  /** Grammar wasm to load instead of the vendored assets/wasm/tree-sitter-yaml.wasm (tests). */
  wasmPath?: string;
}

export class YamlInfraExtractor implements GraphExtractor {
  readonly id = "yaml-infra";
  readonly version: string;
  private readonly wasmPath: string;

  constructor(version?: string, opts: YamlInfraExtractorOptions = {}) {
    this.version = version ?? readPackageVersion();
    this.wasmPath = opts.wasmPath ?? defaultYamlWasmPath();
  }

  supports(filePath: string): boolean {
    return /\.ya?ml$/i.test(filePath);
  }

  async extract(root: string, files: string[]): Promise<GraphExtractionResult> {
    const start = Date.now();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const errors: string[] = [];
    const diagnostics: string[] = [];

    const grammar = await loadYamlGrammar(this.wasmPath);
    for (const file of files) {
      extractYamlFile(file, root, grammar, nodes, edges, errors);
    }
    // Set by a failed load, or by the first parse that threw: every file after it (and with a
    // failed load, every file) took the line-based path — a broken install, reported once.
    const degraded =
      grammar.reason !== null && files.length > 0
        ? [`yaml: ${files.length} file(s) via the line-based fallback (${grammar.reason}) — reinstall leina and run \`leina doctor\``]
        : [];

    return {
      schemaVersion: 1,
      extractor: { id: this.id, version: this.version },
      nodes,
      edges,
      diagnostics,
      degraded,
      durationMs: Date.now() - start,
      errors,
    };
  }
}
