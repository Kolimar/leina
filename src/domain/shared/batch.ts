// Shared batch helpers for the `leina memory ... --batch` CLI handlers.
// Pure module — no I/O, no side effects, no imports beyond types.
//
// BatchResult<T>   — per-item discriminated union (ok or error)
// parseScalarOrBatch — dispatch helper: inspects the validated input and routes
//                      to the scalar path or the batch path.
// formatBatchResults — renders an ordered per-item result array as a text block.

// ---------------------------------------------------------------------------
// BatchResult<T>
// ---------------------------------------------------------------------------

export type BatchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// parseScalarOrBatch
// ---------------------------------------------------------------------------
// Inspects a validated MCP input object and returns either:
//   { mode: "scalar"; payload: S }     — no `items` key present
//   { mode: "batch";  payload: B[] }   — `items` array present
//
// Type-parameters are kept loose (unknown) at runtime so callers cast to their
// specific shapes after routing. The Zod `.refine()` on each tool's schema
// already enforces the XOR constraint before this helper runs.

type ScalarOrBatchInput = Record<string, unknown>;

export function parseScalarOrBatch<S, B>(
  input: ScalarOrBatchInput,
  _scalarKeys: readonly string[],
  batchKey: string,
): { mode: "scalar"; payload: S } | { mode: "batch"; payload: B[] } {
  if (Object.hasOwn(input, batchKey) && Array.isArray(input[batchKey])) {
    return { mode: "batch", payload: input[batchKey] as B[] };
  }
  return { mode: "scalar", payload: input as unknown as S };
}

// ---------------------------------------------------------------------------
// formatBatchResults
// ---------------------------------------------------------------------------
// Renders BatchResult<T>[] as a multi-line text response:
//   [0] ok: <render(data)>
//   [1] error: <error string>
//   [2] ok: ...

export function formatBatchResults<T>(
  results: BatchResult<T>[],
  render: (data: T) => string,
): string {
  return results
    .map((r, i) => {
      if (r.ok) {
        return `[${i}] ok: ${render(r.data)}`;
      } 
        return `[${i}] error: ${r.error}`;
      
    })
    .join("\n");
}
