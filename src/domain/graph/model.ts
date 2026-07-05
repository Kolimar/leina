// Canonical graph data model — the required node/edge fields, typed for TS.

export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS" | "SYNTACTIC";

// ---------------------------------------------------------------------------
// Extensible union types — closed with `(string & { _?: never })` so:
//   • known literals get autocomplete + exhaustiveness-narrowing
//   • unknown literals compile without explicit cast
//   • ReadonlySet<Relation>.has(e.relation) compiles without cast
// The brand `{ _?: never }` carries a (member-bearing) shape so the intersection
// is not "useless" (Sonar S4335 / no-useless-intersection); `_` is optional, so
// any plain `string` is still assignable — behaviour is identical to `string & {}`.
// ---------------------------------------------------------------------------

/** Member-bearing brand for open string unions (Sonar-safe replacement for `{}`). */
type OpenStr = string & { _?: never };

/** Known code node kinds (always present in KNOWN_NODE_KINDS). */
const CODE_NODE_KINDS = [
  "class", "function", "method", "interface", "module", "concept",
] as const;

/** Known infra node kinds (always present in KNOWN_NODE_KINDS). */
const INFRA_NODE_KINDS = [
  "service", "api", "database", "queue", "config",
  "secret", "finding", "deployment", "environment",
] as const;

/** Readonly set of all known node kinds (code + infra). Single source of truth. */
export const KNOWN_NODE_KINDS: ReadonlySet<string> = new Set<string>([
  ...CODE_NODE_KINDS,
  ...INFRA_NODE_KINDS,
]);

export type NodeKind =
  | "class" | "function" | "method" | "interface" | "module" | "concept"
  | "service" | "api" | "database" | "queue" | "config"
  | "secret" | "finding" | "deployment" | "environment"
  | OpenStr;

/** Known code relations (always present in KNOWN_RELATIONS). */
const CODE_RELATIONS = [
  "calls", "imports", "imports_from", "inherits", "implements",
  "extends", "references", "contains", "method", "uses",
] as const;

/** Known infra relations (always present in KNOWN_RELATIONS). */
const INFRA_RELATIONS = [
  "deploys", "reads", "writes", "configures", "exposes", "consumes", "produces",
] as const;

/** Readonly set of all known relations (code + infra). Single source of truth. */
export const KNOWN_RELATIONS: ReadonlySet<string> = new Set<string>([
  ...CODE_RELATIONS,
  ...INFRA_RELATIONS,
]);

export type Relation =
  | "calls" | "imports" | "imports_from" | "inherits" | "implements"
  | "extends" | "references" | "contains" | "method" | "uses"
  | "deploys" | "reads" | "writes" | "configures" | "exposes" | "consumes" | "produces"
  | OpenStr;

/** Known file types (code + infra). */
const ALL_FILE_TYPES = [
  "code", "document", "concept", "rationale", "config",
] as const;

/** Readonly set of all known file types. Single source of truth. */
export const KNOWN_FILE_TYPES: ReadonlySet<string> = new Set<string>([...ALL_FILE_TYPES]);

export type FileType =
  | "code" | "document" | "concept" | "rationale" | "config"
  | OpenStr;

export type EdgeContext =
  | "parameter_type"
  | "return_type"
  | "field"
  | "generic_arg";

// Parameter info for a function/method signature. `nullable` is true when the
// parameter type itself contains `null` or `undefined`; `optional` is true when
// the parameter has a `?` modifier or a default value. These are different
// concepts: `x?: number` is optional but not nullable; `x: number | null` is
// nullable but not optional; `x: number = 0` is optional but not nullable.
export interface ParameterInfo {
  name: string;
  type: string;       // annotation-primary, resolved fallback, capped at 200 chars
  nullable: boolean;
  optional: boolean;
}

// Structured signature attached to function/method nodes. Type strings come
// from the annotation when present (faithful to source), else from the resolved
// type with `import("...").` qualification stripped, capped at 200 chars.
export interface Signature {
  returnType: { text: string; nullable: boolean };
  parameters: ParameterInfo[];
  accessModifier?: "public" | "private" | "protected";
  isAsync: boolean;
  isGenerator: boolean;
}

export interface GraphNode {
  id: string;
  label: string;
  fileType: FileType;
  sourceFile: string;
  sourceLocation?: string; // "L42"
  kind?: NodeKind;
  community?: number;
  signature?: Signature; // populated for kind: "function" | "method"
  /** Workspace mode only: the repo key this node belongs to. Absent in single-repo mode. */
  repo?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: Relation;
  confidence: Confidence;
  context?: EdgeContext;
  sourceFile: string;
  sourceLocation?: string;
  weight: number;
  /** Workspace mode only: the repo key this edge belongs to. Absent in single-repo mode. */
  repo?: string;
}

// node-link serialization (interoperable with networkx / graph tooling).
export interface NodeLinkGraph {
  directed: boolean;
  multigraph: boolean;
  graph: Record<string, unknown>;
  nodes: GraphNode[];
  links: GraphEdge[];
}

// Intermediate shape emitted by extractors before symbol resolution.
export interface RawCall {
  callee: string; // textual name at the call site
  sourceFile: string;
  sourceLocation: string;
  fromId: string; // enclosing function/method node id (the caller)
  isMember: boolean; // obj.method() vs bare foo()
  receiverType?: string; // resolved type of the receiver (e.g. `factory.m()` -> "TokenFactory")
}

// An imported name available in a file: `import { make } from "./auth"` ->
// { localName: "make", module: "./auth" }. Used for import-guided resolution.
export interface ImportBinding {
  localName: string;
  module: string;
  sourceFile: string;
  /** Workspace mode only: the published package module this import resolves to (e.g. "@acme/payments"). */
  origin?: string;
}

export interface ExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rawCalls: RawCall[];
  imports: ImportBinding[];
}
