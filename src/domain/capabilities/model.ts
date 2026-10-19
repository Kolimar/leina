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
   * Every current capability declares ["cli", "mcp"]: the CLI dispatcher and the
   * MCP server (`leina mcp`) are both live transports. "sdk" is reserved.
   */
  transports: ("cli" | "mcp" | "sdk")[];
  /**
   * Monotonic integer version of this capability's schema contract.
   * Each capability versions independently; all start at 1 in v1.
   */
  schemaVersion: number;
  // NOTE: a `fn` use-case reference existed here in v1 but was never invoked through
  // the registry (CLI handlers call use-cases directly; the MCP server keeps its own
  // executor map in cli/handlers/mcp.ts), so it was removed. Capabilities are pure,
  // serialisable metadata: dispatch is owned by each transport.
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
   * MCP tool contract — optional, present when the capability is exposed over MCP.
   * The MCP server (`leina mcp`, cli/handlers/mcp.ts) lists every declared tool in
   * ListTools and dispatches it through its executor map.
   */
  mcp?: {
    /** MCP tool name corresponding to this capability. */
    tool: string;
  };
}
