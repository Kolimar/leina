// Declarations consumed by refs.ts — split from the consuming file the same way
// tsmorph-crossfile/callee.ts is split from caller.ts.

export interface GraphNode {
  id: string;
}

export interface GraphEdge {
  source: string;
}

export class Target {
  run(): void {
    // no-op
  }
}

export class Base {
  // no-op
}

export interface IBase {
  tag: string;
}

export function buildGraph(): void {
  // no-op
}

export function myHandler(): void {
  // no-op
}

export function registerHandler(fn: () => void): void {
  fn();
}

// Never imported by refs.ts (REQ-NR-3 fixture needs an unused ImportSpecifier).
export function unusedExport(): void {
  // no-op
}

// REQ-NR-5 fixture: self-referencing interface.
export interface RecursiveNode {
  children: RecursiveNode[];
}
