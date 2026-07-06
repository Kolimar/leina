import type { GraphNode, GraphEdge } from "./decls";
import { buildGraph, myHandler, registerHandler, Target, Base, IBase } from "./decls";
// REQ-NR-3 fixture: imported but never used elsewhere — the ImportSpecifier
// binding itself must not generate a `references` edge.
import { unusedExport } from "./decls";
import type { RecursiveNode } from "./decls";
import * as declsNs from "./decls";

// REQ-TR-1: parameter + return-type annotations reference registered decls.
export function useNode(n: GraphNode): GraphEdge {
  return n as unknown as GraphEdge;
}

// REQ-TR-1: nested generic type-arg (`Map<string, GraphNode>` yields two
// TypeReference nodes — the outer `Map` (unresolvable) and inner `GraphNode`).
export function useMap(): Map<string, GraphNode> {
  return new Map();
}

// REQ-TR-1 negative: primitive types never resolve to a registered decl.
export function usePrimitive(x: string): number {
  return x.length;
}

// REQ-VR-1: symbol referenced as a value (not called) inside an object
// literal — mirrors registry.ts:337 (`fn: buildGraph as (...) => unknown`).
export const registry = {
  fn: buildGraph as (...args: unknown[]) => unknown,
};

// REQ-VR-1: symbol passed as an argument — not the callee itself.
registerHandler(myHandler);

// REQ-NR-1: callee of Call/New must NOT also produce a `references` edge from
// the value walk — only the `calls`/`references`(new) edge from linkCallEdges.
export function useTarget(): void {
  const t = new Target();
  t.run();
}

// REQ-NR-2: heritage identifiers must NOT also produce a `references` edge —
// only `extends`/`implements` from the heritage walks.
export class Derived extends Base implements IBase {
  tag = "derived";
}

// REQ-NR-4: the name-node of a namespace-qualified call (`declsNs.buildGraph()`)
// must NOT duplicate the `calls` edge already produced by linkCallEdges; only
// the namespace object identifier itself (`declsNs`) is a legitimate reference
// (to the module, not to `buildGraph`).
export function useNamespaceMember(): void {
  declsNs.buildGraph();
}

// REQ-NR-5: a self-referencing interface (decls.ts's RecursiveNode) must not
// produce a self-loop when referenced from here either.
export interface Wrap {
  self: RecursiveNode;
}
