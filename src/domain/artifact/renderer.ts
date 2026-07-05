// domain/artifact/renderer.ts
// Renderer<T> — generic render interface for audit artifacts.
//
// path === ""                → caller writes content to stdout
// path === "audit-graph.html" → caller writes content to that file
//
// No imports outside domain/ (arch-rule D1).

export interface Renderer<T> {
  render(pack: T): { path: string; content: string };
}
