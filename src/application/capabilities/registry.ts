// application/capabilities/registry.ts — canonical capability registry.
//
// Single source of truth for the capabilities exposed by leina: pure METADATA
// (ids, descriptions, schemas, transports, CLI/MCP bindings). Consumed by
// `capabilities list`, the AGENTS.md generator, and the MCP server's ListTools.
//
// Dispatch is transport-owned, not registry-owned: CLI handlers call use-cases
// directly and the MCP server keeps its own executor map (cli/handlers/mcp.ts).
// A per-capability `fn` reference existed in v1 but was never invoked through the
// registry, so it was removed — contracts here stay data-only and serialisable.
//
// Arch constraints:
//   REQ-CR-3: ZERO imports from src/cli/. All deps are application/ or domain/.
//   arch-rule-1: registry.ts is in application/, not domain/, so it may import
//                from both application/ and domain/ layers.

import type { CommandContract } from "../../domain/capabilities/model.ts";
import {
  graphQueryOutputSchema,
  graphStatusOutputSchema,
  memoryAddOutputSchema,
  memorySearchOutputSchema,
  contextBuildOutputSchema,
  auditRunOutputSchema,
  harnessContractNewOutputSchema,
  harnessContractShowOutputSchema,
  harnessContractEndOutputSchema,
  harnessVerifyOutputSchema,
  harnessRulesListOutputSchema,
} from "../../domain/contracts/schemas.ts";
import { gatesOf, type TaskContract } from "../../domain/harness/model.ts";
import { type GitPort } from "../../domain/harness/ports.ts";
import { loadContract, saveContract, writeChecklist } from "../harness/contract-io.ts";
import { loadConfig } from "../harness/config-io.ts";
import { loadResolvedRules } from "../harness/resolver.ts";

// ---------------------------------------------------------------------------
// Harness use-cases — thin JSON-friendly wrappers over application/harness/*.
// They exist here (not in cli/handlers/harness.ts) so BOTH transports — the CLI
// group and the MCP executors — share one behaviour, and so the registry keeps
// REQ-CR-3 (zero cli/ imports). Effects go through ports: the git port is
// injected by the transport, never composed here.
// ---------------------------------------------------------------------------

export interface HarnessContractNewInput {
  goal: string;
  taskType?: string;
  scope?: string[];
  outOfScope?: string[];
  criteria?: string[];
  maxRetries?: number;
}

export type HarnessContractNewResult =
  | { ok: true; contract: TaskContract }
  | { ok: false; error: string };

/** Declare the task contract (mirrors `leina harness contract new`). */
export async function harnessContractNew(
  repoRoot: string,
  input: HarnessContractNewInput,
  git?: GitPort,
): Promise<HarnessContractNewResult> {
  const existing = await loadContract(repoRoot);
  if (existing.error) return { ok: false, error: existing.error };
  if (existing.contract) {
    return {
      ok: false,
      error: "a contract is already active — finish it with `leina harness contract end` first",
    };
  }
  if (input.goal.trim().length === 0) {
    return { ok: false, error: "goal is required (one sentence: what done looks like)" };
  }

  const { config } = await loadConfig(repoRoot);
  if (input.taskType !== undefined && !config.taskTypes.includes(input.taskType)) {
    return {
      ok: false,
      error: `unknown task type "${input.taskType}" — configured types: ${config.taskTypes.join(", ")}`,
    };
  }

  const maxRetries = input.maxRetries ?? 3;
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    return { ok: false, error: "maxRetries must be a positive integer" };
  }

  const baseRef = git && (await git.isRepo(repoRoot)) ? await git.currentHead(repoRoot) : undefined;
  const created: TaskContract = {
    goal: input.goal,
    ...(input.taskType !== undefined ? { taskType: input.taskType } : {}),
    scope: input.scope ?? [],
    outOfScope: input.outOfScope ?? [],
    criteria: (input.criteria ?? []).map((text) => ({ text, done: false })),
    maxRetries,
    ...(baseRef !== undefined ? { baseRef } : {}),
    createdAt: new Date().toISOString(),
  };
  await saveContract(repoRoot, created);
  await writeChecklist(repoRoot, created);
  return { ok: true, contract: created };
}

export interface HarnessContractShowResult {
  active: boolean;
  contract?: TaskContract;
  error?: string;
}

/** State of the active contract, if any (mirrors `leina harness contract show`). */
export async function harnessContractShow(repoRoot: string): Promise<HarnessContractShowResult> {
  const { contract, error } = await loadContract(repoRoot);
  return {
    active: contract !== undefined,
    ...(contract !== undefined ? { contract } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

export interface HarnessRuleProjection {
  id: string;
  layer: string;
  phase: string;
  severity: string;
  enabled: boolean;
  gates: string[];
  tags: string[];
  summary: string;
}

/** Resolved rules projection (mirrors `leina harness list --json`). */
export async function harnessRulesList(
  repoRoot: string,
): Promise<{ rules: HarnessRuleProjection[]; errors: string[] }> {
  const resolution = await loadResolvedRules(repoRoot);
  return {
    rules: resolution.rules.map((r) => ({
      id: r.id,
      layer: r.layer,
      phase: r.phase,
      severity: r.severity,
      enabled: r.enabled,
      gates: gatesOf(r).map((g) => g.type),
      tags: r.tags,
      summary: r.summary ?? "",
    })),
    errors: resolution.errors,
  };
}

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

const memoryContextInputSchema = {
  type: "object" as const,
  required: ["root"],
  properties: {
    root: { type: "string" as const },
    limit: { type: "number" as const },
    sessionLimit: { type: "number" as const },
    full: { type: "boolean" as const },
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

const harnessContractNewInputSchema = {
  type: "object" as const,
  required: ["root", "goal"],
  properties: {
    root: { type: "string" as const },
    goal: { type: "string" as const },
    taskType: { type: "string" as const },
    scope: { type: "array" as const },
    outOfScope: { type: "array" as const },
    criteria: { type: "array" as const },
    maxRetries: { type: "number" as const },
  },
};

const harnessVerifyInputSchema = {
  type: "object" as const,
  required: ["root"],
  properties: {
    root: { type: "string" as const },
    phases: { type: "array" as const },
    ruleId: { type: "string" as const },
  },
};

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
    },
    cli: { command: "memory verified" },
    mcp: { tool: "memory_verified" },
  },
  {
    capability: {
      id: "memory.context",
      description:
        "Recent sessions and latest observations for a project — the session-start context payload. Over MCP, bodies are clipped to previews (full content via memory.get, or full:true to opt out).",
      inputSchema: memoryContextInputSchema,
      outputSchema: listOutputSchema,
      transports: ["cli", "mcp"],
      // v2: accepts limit/sessionLimit/full; MCP output defaults to clipped previews.
      schemaVersion: 2,
    },
    cli: { command: "memory context", flags: ["--limit"] },
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
    },
    cli: { command: "memory session", flags: ["--content", "--title"] },
    mcp: { tool: "memory_session" },
  },
  {
    capability: {
      id: "harness.contract.new",
      description: "Declare the harness task contract (goal, scope globs, acceptance criteria) before starting a non-trivial task. Records the git base ref and seeds the criteria checklist.",
      inputSchema: harnessContractNewInputSchema,
      outputSchema: harnessContractNewOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
    },
    cli: {
      command: "harness contract new",
      flags: ["--goal", "--type", "--scope", "--out-of-scope", "--criterion", "--max-retries"],
    },
    mcp: { tool: "harness_contract_new" },
  },
  {
    capability: {
      id: "harness.contract.show",
      description: "State of the active harness task contract (goal, scope, criteria progress), or active=false when none.",
      inputSchema: rootOnlyInputSchema,
      outputSchema: harnessContractShowOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
    },
    cli: { command: "harness contract show" },
    mcp: { tool: "harness_contract_show" },
  },
  {
    capability: {
      id: "harness.contract.end",
      description: "Close the active harness contract: archives .harness/state/current/ to state/history/<timestamp>/ and returns the archive path.",
      inputSchema: rootOnlyInputSchema,
      outputSchema: harnessContractEndOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
    },
    cli: { command: "harness contract end" },
    mcp: { tool: "harness_contract_end" },
  },
  {
    capability: {
      id: "harness.verify",
      description: "Run the harness gates (the completion wall). Returns the full report (per-gate status/detail, blocking failures) and the exit-code contract: 0 complete, 1 blocking failure, 2 engine/config error.",
      inputSchema: harnessVerifyInputSchema,
      outputSchema: harnessVerifyOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
    },
    cli: { command: "harness verify", flags: ["--json", "--phase", "--rule"] },
    mcp: { tool: "harness_verify" },
  },
  {
    capability: {
      id: "harness.rules.list",
      description: "Resolved harness rules across the builtin/project/user layers: id, layer, phase, severity, enabled state and gate types.",
      inputSchema: rootOnlyInputSchema,
      outputSchema: harnessRulesListOutputSchema,
      transports: ["cli", "mcp"],
      schemaVersion: 1,
    },
    cli: { command: "harness list", flags: ["--phase", "--tag", "--json"] },
    mcp: { tool: "harness_rules_list" },
  },
] as const;
