// domain/capabilities/model.ts — capability type contracts (pure data, no external deps).
// These interfaces are the single source of truth for the capability registry declared
// in application/capabilities/registry.ts.
//
// Dependency rule: this file MUST import only from other domain/ modules.
// No application/, infrastructure/, or cli/ imports allowed.

// ---------------------------------------------------------------------------
// JsonSchema — minimal data-only schema descriptor (v1; no Zod/AJV dependency).
// Only the fields documented here are part of the v1 contract.
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "boolean";
  /** Nested schema definitions for object properties. */
  properties?: Record<string, JsonSchema>;
  /** Required property names (for type "object"). */
  required?: string[];
}

// ---------------------------------------------------------------------------
// Capability — a declared capability of the system.
// ---------------------------------------------------------------------------

export interface Capability {
  /** Canonical dot-namespaced identifier, e.g. "graph.query". */
  id: string;
  /** Human-readable description of what this capability does. */
  description: string;
  /** JSON schema describing the expected input parameters. */
  inputSchema: JsonSchema;
  /** JSON schema describing the output shape. */
  outputSchema: JsonSchema;
  /**
   * Transports through which this capability is currently active.
   * In v1 all capabilities are exposed through "cli" only.
   */
  transports: ("cli" | "mcp" | "sdk")[];
  /**
   * Monotonic integer version of this capability's schema contract.
   * Each capability versions independently; all start at 1 in v1.
   */
  schemaVersion: number;
  /**
   * Reference to the underlying use-case function.
   * The first argument is always the port (MemoryRepository / GraphRepository / string),
   * injected by the transport layer at invocation time.
   * In v1 this field is NEVER invoked through the registry — it is a typed reference
   * for future transport layers (MCP / SDK). CLI handlers call use cases directly.
   */
  fn: (...args: unknown[]) => unknown;
}

// ---------------------------------------------------------------------------
// CommandContract — binds a Capability to its transport-level invocation contract.
// ---------------------------------------------------------------------------

export interface CommandContract {
  capability: Capability;
  /** CLI invocation contract. */
  cli: {
    /** Full CLI sub-command string, e.g. "capabilities list". */
    command: string;
    /** Optional flags supported by this command, e.g. ["--json"]. */
    flags?: string[];
  };
  /**
   * MCP tool contract — optional, present only when the capability is intended
   * for future MCP exposure. Declaring it here is advisory: no MCP transport is
   * active in v1.
   */
  mcp?: {
    /** MCP tool name that will correspond to this capability. */
    tool: string;
  };
}
