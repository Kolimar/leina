// application/capabilities/registry.ts — canonical capability registry.
//
// Single source of truth for the capabilities exposed by leina.
// Consumed by CLI handlers and by the MCP server (`leina mcp`), which maps each
// contract's mcp.tool to an executor that injects the ports fn expects.
//
// Design decisions:
//   D1: fn holds a REFERENCE to the use-case function with its port injected by the
//       transport layer. In v1, fn is NEVER invoked through this registry — handlers
//       call use cases directly. fn is a typed reference for future transports.
//   D4: capabilities list serialisation omits fn by explicit projection (JSON.stringify
//       cannot be relied upon to drop functions).
//
// Arch constraints:
//   REQ-CR-3: ZERO imports from src/cli/. All deps are application/ or domain/.
//   arch-rule-1: registry.ts is in application/, not domain/, so it may import
//                from both application/ and domain/ layers.

import type { CommandContract } from "../../domain/capabilities/model.ts";
import type { MemoryRepository } from "../../domain/memory/ports.ts";
import type { ObservationInput, UpdateFields } from "../../domain/memory/model.ts";
import {
  graphQueryOutputSchema,
  graphStatusOutputSchema,
  memoryAddOutputSchema,
  memorySearchOutputSchema,
  contextBuildOutputSchema,
  auditRunOutputSchema,
} from "../../domain/contracts/schemas.ts";
import { affected, queryGraph, resolveSeed, shortestPath } from "../graph/query.ts";
import { analyzeImpact } from "../graph/impact.ts";
import { buildGraph } from "../graph/build.ts";
import { getVerifiedContext } from "../memory/query.ts";
import { graphStatus } from "../graph/manifest.ts";
import { searchMemory } from "../memory/query.ts";
import { buildActiveContext } from "../context/active-context.ts";
import { runAudit } from "../audit/run.ts";

// ---------------------------------------------------------------------------
// Input schemas — minimal descriptors; v1 does not validate inputs at runtime.
// ---------------------------------------------------------------------------

const graphQueryInputSchema = {
  type: "object" as const,
  required: ["store", "question"],
  properties: {
    store: { type: "object" as const },
    question: { type: "string" as const },
    depth: { type: "number" as const },
    maxNodes: { type: "number" as const },
  },
};

const graphStatusInputSchema = {
  type: "object" as const,
  required: ["root"],
  properties: {
    root: { type: "string" as const },
  },
};

const memoryAddInputSchema = {
  type: "object" as const,
  required: ["store", "input"],
  properties: {
    store: { type: "object" as const },
    input: { type: "object" as const },
  },
};

const memorySearchInputSchema = {
  type: "object" as const,
  required: ["store", "terms"],
  properties: {
    store: { type: "object" as const },
    terms: { type: "string" as const },
  },
};

const contextBuildInputSchema = {
  type: "object" as const,
  required: ["cwd"],
  properties: {
    cwd: { type: "string" as const },
  },
};

const auditRunInputSchema = {
  type: "object" as const,
  required: ["store"],
  properties: {
    store: { type: "object" as const },
    fromIds: { type: "array" as const },
    maxBytes: { type: "number" as const },
  },
};


// Root-based input schemas (JSON-friendly: the transport resolves `root` to stores).
const rootOnlyInputSchema = {
  type: "object" as const,
  required: ["root"],
  properties: { root: { type: "string" as const } },
};

const graphAffectedInputSchema = {
  type: "object" as const,
  required: ["root", "symbol"],
  properties: {
    root: { type: "string" as const },
    symbol: { type: "string" as const },
    depth: { type: "number" as const },
  },
};

const graphPathInputSchema = {
  type: "object" as const,
  required: ["root", "from", "to"],
  properties: {
    root: { type: "string" as const },
    from: { type: "string" as const },
    to: { type: "string" as const },
  },
};

const memoryQueryInputSchema = {
  type: "object" as const,
  required: ["root", "query"],
  properties: {
    root: { type: "string" as const },
    query: { type: "string" as const },
    type: { type: "string" as const },
    limit: { type: "number" as const },
  },
};

const memoryGetInputSchema = {
  type: "object" as const,
  required: ["root"],
  properties: {
    root: { type: "string" as const },
    id: { type: "string" as const },
    ids: { type: "array" as const },
  },
};

const memoryUpdateInputSchema = {
  type: "object" as const,
  required: ["root", "id"],
  properties: {
    root: { type: "string" as const },
    id: { type: "string" as const },
    title: { type: "string" as const },
    content: { type: "string" as const },
    type: { type: "string" as const },
    anchors: { type: "array" as const },
  },
};

const memorySuggestTopicInputSchema = {
  type: "object" as const,
  required: ["root", "title"],
  properties: {
    root: { type: "string" as const },
    title: { type: "string" as const },
    type: { type: "string" as const },
  },
};

const memorySessionInputSchema = {
  type: "object" as const,
  required: ["root", "content"],
  properties: {
    root: { type: "string" as const },
    content: { type: "string" as const },
    title: { type: "string" as const },
  },
};

const listOutputSchema = { type: "object" as const };

// ---------------------------------------------------------------------------
// Registry — CommandContracts for every transport-exposed capability.
// ---------------------------------------------------------------------------

export const capabilities: readonly CommandContract[] = [
  {
    capability: {
      id: "graph.query",
      description: "Query the code knowledge graph by natural-language question. Returns a term-scored subgraph (seeds, nodes, edges).",
      inputSchema: graphQueryInputSchema,
      outputSchema: graphQueryOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      // D1: fn is a typed reference; the transport injects `store` at call time.
      fn: queryGraph as (...args: unknown[]) => unknown,
    },
    cli: {
      command: "query",
      flags: ["--json"],
    },
    mcp: { tool: "graph_query" },
  },
  {
    capability: {
      id: "graph.status",
      description: "Return the freshness status of the code graph (stale/fresh, last build metadata).",
      inputSchema: graphStatusInputSchema,
      outputSchema: graphStatusOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      // D2: graphStatus takes root (string), no port injection needed (filesystem only).
      fn: graphStatus as (...args: unknown[]) => unknown,
    },
    cli: {
      command: "status",
    },
    mcp: { tool: "graph_status" },
  },
  {
    capability: {
      id: "memory.add",
      description: "Save or upsert a memory observation to the project knowledge base. Batch form: pass an `items` array (optionally `atomic`) instead of title/content.",
      inputSchema: memoryAddInputSchema,
      outputSchema: memoryAddOutputSchema,
      transports: ["cli", "mcp"],
      // v2: accepts the batch form (items[] + atomic) in addition to a single observation.
      schemaVersion: 2,
      // D1: fn wraps store.save; transport injects the MemoryRepository.
      fn: ((store: MemoryRepository, input: ObservationInput) =>
        store.save(input)) as (...args: unknown[]) => unknown,
    },
    cli: {
      command: "memory save",
      flags: ["--title", "--content", "--type", "--topic"],
    },
    mcp: { tool: "memory_add" },
  },
  {
    capability: {
      id: "memory.search",
      description: "Full-text search over project memory observations. Returns ranked search hits.",
      inputSchema: memorySearchInputSchema,
      outputSchema: memorySearchOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      // D1: fn is searchMemory; transport injects the MemoryRepository.
      fn: searchMemory as (...args: unknown[]) => unknown,
    },
    cli: {
      command: "memory search",
      flags: ["--type", "--limit"],
    },
    mcp: { tool: "memory_search" },
  },
  {
    capability: {
      id: "context.build",
      description: "Build the active context payload for a project directory (memory observations + graph stats).",
      inputSchema: contextBuildInputSchema,
      outputSchema: contextBuildOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      // REQ-RF-1: buildActiveContext was extracted to application layer for this reference.
      fn: buildActiveContext as (...args: unknown[]) => unknown,
    },
    cli: {
      command: "agent-hook SessionStart",
    },
    mcp: { tool: "context_build" },
  },
  {
    capability: {
      id: "audit.run",
      description: "Run the full security audit pipeline: source/sink detection, M:N reachability, AuditPack serialisation.",
      inputSchema: auditRunInputSchema,
      outputSchema: auditRunOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      // D3: runAudit was extracted to application layer; transport injects the GraphRepository.
      fn: runAudit as (...args: unknown[]) => unknown,
    },
    cli: {
      command: "audit",
      flags: ["--from", "--max-pack-kb", "--json"],
    },
    mcp: { tool: "audit_run" },
  },
  {
    capability: {
      id: "graph.affected",
      description: "Blast radius: everything that transitively depends on a symbol. THE check to run before renaming or refactoring.",
      inputSchema: graphAffectedInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      fn: affected as (...args: unknown[]) => unknown,
    },
    cli: { command: "affected" },
    mcp: { tool: "graph_affected" },
  },
  {
    capability: {
      id: "graph.path",
      description: "Shortest dependency path between two symbols in the code graph.",
      inputSchema: graphPathInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      fn: shortestPath as (...args: unknown[]) => unknown,
    },
    cli: { command: "path" },
    mcp: { tool: "graph_path" },
  },
  {
    capability: {
      id: "graph.stats",
      description: "Node/edge counts and confidence breakdown of the code graph.",
      inputSchema: rootOnlyInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      // fn is resolveSeed's sibling surface; the transport calls store.stats() directly.
      fn: resolveSeed as (...args: unknown[]) => unknown,
    },
    cli: { command: "stats" },
    mcp: { tool: "graph_stats" },
  },
  {
    capability: {
      id: "graph.build",
      description: "Build (or rebuild) the code knowledge graph for a project directory.",
      inputSchema: rootOnlyInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      fn: buildGraph as (...args: unknown[]) => unknown,
    },
    cli: { command: "build", flags: ["--json"] },
    mcp: { tool: "graph_build" },
  },
  {
    capability: {
      id: "impact.analyze",
      description: "Bidirectional impact BFS classifying blast radius into files, tests, services and configs.",
      inputSchema: graphAffectedInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      fn: analyzeImpact as (...args: unknown[]) => unknown,
    },
    cli: { command: "impact analyze", flags: ["--json"] },
    mcp: { tool: "impact_analyze" },
  },
  {
    capability: {
      id: "memory.verified",
      description: "Memory search with drift verdicts: each hit re-checked against the live graph (USABLE / WARNING / DO-NOT-USE).",
      inputSchema: memoryQueryInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      fn: getVerifiedContext as (...args: unknown[]) => unknown,
    },
    cli: { command: "memory verified" },
    mcp: { tool: "memory_verified" },
  },
  {
    capability: {
      id: "memory.context",
      description: "Recent sessions and latest observations for a project — the session-start context payload.",
      inputSchema: rootOnlyInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      fn: ((store: MemoryRepository) => store.recentContext()) as (...args: unknown[]) => unknown,
    },
    cli: { command: "memory context" },
    mcp: { tool: "memory_context" },
  },
  {
    capability: {
      id: "memory.get",
      description: "Fetch a single memory observation by id, full content included. Batch form: pass an `ids` array instead of `id`.",
      inputSchema: memoryGetInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      // v2: accepts the batch form (ids[]) in addition to a single id.
      schemaVersion: 2,
      fn: ((store: MemoryRepository, id: string) => store.get(id)) as (...args: unknown[]) => unknown,
    },
    cli: { command: "memory get" },
    mcp: { tool: "memory_get" },
  },
  {
    capability: {
      id: "memory.update",
      description: "In-place partial update of a live observation by id (title/content/type/anchors). Does not bump revision — use topic-key upsert (memory.add) for evolution.",
      inputSchema: memoryUpdateInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      fn: ((store: MemoryRepository, id: string, fields: UpdateFields) =>
        store.update(id, fields)) as (...args: unknown[]) => unknown,
    },
    cli: { command: "memory update", flags: ["--title", "--content", "--type"] },
    mcp: { tool: "memory_update" },
  },
  {
    capability: {
      id: "memory.suggestTopic",
      description: "Suggest a normalised topic_key for a new observation and rank near-matches from existing live keys (dedupe aid before memory.add with --topic).",
      inputSchema: memorySuggestTopicInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      fn: ((store: MemoryRepository, title: string, type: string) =>
        store.suggestTopicKeyWithMatches(title, type)) as (...args: unknown[]) => unknown,
    },
    cli: { command: "memory suggest-topic", flags: ["--title", "--type"] },
    mcp: { tool: "memory_suggest_topic" },
  },
  {
    capability: {
      id: "memory.session",
      description: "Summarise and close the active session (or open a one-shot one) — the end-of-session summary that memory.context surfaces next time.",
      inputSchema: memorySessionInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
      fn: ((store: MemoryRepository, summary: string, opts?: { title?: string }) =>
        store.saveSession(summary, opts)) as (...args: unknown[]) => unknown,
    },
    cli: { command: "memory session", flags: ["--content", "--title"] },
    mcp: { tool: "memory_session" },
  },
] as const;
