// domain/contracts/schemas.ts — output schema constants for the 6 system capabilities
// and a lightweight runtime validator (no Zod/AJV dependency).
//
// These schemas are data-only: they document the top-level shape of each capability's
// return value and allow tests to assert correctness without external libraries.
//
// Dependency rule: this file MUST import only from other domain/ modules.
// No application/, infrastructure/, or cli/ imports allowed.

import type { JsonSchema } from "../capabilities/model.ts";

// ---------------------------------------------------------------------------
// Output schema constants — one per canonical capability id.
// ---------------------------------------------------------------------------

/** Output schema for `graph.query` — returns a subgraph with seeds, nodes and edges. */
export const graphQueryOutputSchema: JsonSchema = {
  type: "object",
  required: ["seeds", "nodes", "edges"],
  properties: {
    seeds: { type: "array" },
    nodes: { type: "array" },
    edges: { type: "array" },
  },
};

/** Output schema for `graph.status` — returns freshness metadata. */
export const graphStatusOutputSchema: JsonSchema = {
  type: "object",
  required: ["stale", "reason"],
  properties: {
    stale: { type: "boolean" },
    reason: { type: "string" },
    commitSha: { type: "string" },
    builtAt: { type: "number" },
    fileCount: { type: "number" },
    degraded: { type: "array" },
  },
};

/** Output schema for `memory.add` — returns the saved observation and whether it evolved. */
export const memoryAddOutputSchema: JsonSchema = {
  type: "object",
  required: ["observation", "evolved"],
  properties: {
    observation: { type: "object" },
    evolved: { type: "boolean" },
  },
};

/** Output schema for `memory.search` — returns an array of search hits. */
export const memorySearchOutputSchema: JsonSchema = {
  type: "array",
};

/** Output schema for `context.build` — returns injected text and delivery status. */
export const contextBuildOutputSchema: JsonSchema = {
  type: "object",
  required: ["text", "delivered"],
  properties: {
    text: { type: "string" },
    delivered: { type: "boolean" },
  },
};

/** Output schema for `audit.run` — returns a full AuditPack (schemaVersion 3). */
export const auditRunOutputSchema: JsonSchema = {
  type: "object",
  required: ["schemaVersion", "paths", "nodes", "edges", "prunedPaths", "findings"],
  properties: {
    schemaVersion: { type: "number" },
    paths: { type: "array" },
    nodes: { type: "array" },
    edges: { type: "array" },
    prunedPaths: { type: "number" },
    findings: { type: "array" },
  },
};

// ---------------------------------------------------------------------------
// Harness capability output schemas (harness.* — the task-contract engine).
// ---------------------------------------------------------------------------

/** Output schema for `harness.contract.new` — result of declaring a task contract. */
export const harnessContractNewOutputSchema: JsonSchema = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    contract: {
      type: "object",
      required: ["goal", "scope", "outOfScope", "criteria", "maxRetries"],
    },
    error: { type: "string" },
  },
};

/** Output schema for `harness.contract.show` — the active contract, if any. */
export const harnessContractShowOutputSchema: JsonSchema = {
  type: "object",
  required: ["active"],
  properties: {
    active: { type: "boolean" },
    contract: { type: "object" },
    error: { type: "string" },
  },
};

/** Output schema for `harness.contract.end` — archive result (history path on success). */
export const harnessContractEndOutputSchema: JsonSchema = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    archivedTo: { type: "string" },
    error: { type: "string" },
  },
};

/** Output schema for `harness.verify` — the full verify outcome (report + exit code). */
export const harnessVerifyOutputSchema: JsonSchema = {
  type: "object",
  required: ["report", "loadErrors", "warnings", "exitCode"],
  properties: {
    report: {
      type: "object",
      required: ["schemaVersion", "phases", "results", "summary"],
      properties: {
        results: { type: "array" },
        summary: {
          type: "object",
          required: ["total", "passed", "failed", "blockingFailures"],
        },
      },
    },
    loadErrors: { type: "array" },
    warnings: { type: "array" },
    exitCode: { type: "number" },
    usageError: { type: "string" },
    persisted: { type: "boolean" },
  },
};

/** Output schema for `harness.rules.list` — resolved rules projection. */
export const harnessRulesListOutputSchema: JsonSchema = {
  type: "object",
  required: ["rules"],
  properties: {
    rules: { type: "array" },
    errors: { type: "array" },
  },
};

// ---------------------------------------------------------------------------
// validateAgainstSchema — minimal runtime validator (no external dependencies).
//
// Semantics:
//   - type "object": value must be a non-null object; all keys in schema.required
//     must be present as own properties; recurse into schema.properties if defined.
//   - type "array":  value must be an array (Array.isArray).
//   - Other types:   only the top-level type tag is checked (no deep type coercion).
//
// Errors contain the dot-path of missing keys (e.g. "nodes", "meta.author").
// ---------------------------------------------------------------------------

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  _path = "",
): { valid: boolean; errors: string[] } {
  if (schema.type === "object") {
    return validateObjectSchema(value, schema, _path);
  }
  if (schema.type === "array") {
    return validateArraySchema(value, _path);
  }
  // string / number / boolean: no runtime coercion check in v1
  return { valid: true, errors: [] };
}

// type "object": value must be a non-null, non-array object; all required keys present;
// recurse into any present properties.
function validateObjectSchema(
  value: unknown,
  schema: JsonSchema,
  _path: string,
): { valid: boolean; errors: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const label = _path || "root";
    return { valid: false, errors: [`${label} must be an object`] };
  }
  const obj = value as Record<string, unknown>;
  const errors: string[] = [
    ...collectMissingRequired(obj, schema.required ?? [], _path),
    ...collectPropertyErrors(obj, schema.properties, _path),
  ];
  return { valid: errors.length === 0, errors };
}

// type "array": value must be an array (Array.isArray).
function validateArraySchema(
  value: unknown,
  _path: string,
): { valid: boolean; errors: string[] } {
  if (!Array.isArray(value)) {
    const label = _path || "root";
    return { valid: false, errors: [`${label} must be an array`] };
  }
  return { valid: true, errors: [] };
}

// Check required keys — returns the dot-paths of any that are missing.
function collectMissingRequired(
  obj: Record<string, unknown>,
  required: readonly string[],
  _path: string,
): string[] {
  const errors: string[] = [];
  for (const key of required) {
    if (!(key in obj)) {
      errors.push(_path ? `${_path}.${key}` : key);
    }
  }
  return errors;
}

// Recurse into properties that are present, collecting any child errors.
function collectPropertyErrors(
  obj: Record<string, unknown>,
  properties: JsonSchema["properties"],
  _path: string,
): string[] {
  if (!properties) return [];
  const errors: string[] = [];
  for (const [propKey, propSchema] of Object.entries(properties)) {
    if (!(propKey in obj)) continue;
    const childPath = _path ? `${_path}.${propKey}` : propKey;
    const childResult = validateAgainstSchema(obj[propKey], propSchema, childPath);
    if (!childResult.valid) {
      errors.push(...childResult.errors);
    }
  }
  return errors;
}
