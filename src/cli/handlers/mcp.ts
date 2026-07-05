// cli/handlers/mcp.ts — `leina mcp`: MCP server over stdio.
//
// A TRANSPORT layer over the capability registry: every CommandContract with an
// `mcp.tool` name is exposed as an MCP tool, using the contract's JSON schema. The
// executors below do exactly what the CLI handlers do — resolve `root` into stores via
// wiring (freshness gate included) and call the same use cases — so both transports can
// never diverge in behaviour. Results are returned as JSON text content.
//
// The CLI stays the primary transport (cheaper in tokens for shell-capable agents);
// MCP is the door for hosts and teams that standardize on it. Loaded lazily from the
// dispatcher so the SDK never taxes the ~0.15s read-path startup.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve as resolvePath } from "node:path";
import { capabilities } from "../../application/capabilities/registry.ts";
import { affected, queryGraph, resolveSeed, shortestPath } from "../../application/graph/query.ts";
import { analyzeImpact } from "../../application/graph/impact.ts";
import { graphStatus } from "../../application/graph/manifest.ts";
import { searchMemory, getVerifiedContext } from "../../application/memory/query.ts";
import { buildActiveContext } from "../../application/context/active-context.ts";
import { runAudit } from "../../application/audit/run.ts";
import type { ObservationInput, ObservationType, UpdateFields } from "../../domain/memory/model.ts";
import { readConsentFlag } from "../../application/install/consent.ts";
import { openFreshStoreOrThrow, openGraphRepo, memOpenOrThrow, buildDefaultRegistry } from "../wiring.ts";
import { runDoctor } from "../doctor.ts";
import { readPackageVersion } from "../../version.ts";

type ToolArgs = Record<string, unknown>;

const str = (a: ToolArgs, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing required string argument "${k}"`);
  return v;
};
const optNum = (a: ToolArgs, k: string): number | undefined =>
  typeof a[k] === "number" ? (a[k]) : undefined;
const optStr = (a: ToolArgs, k: string): string | undefined =>
  typeof a[k] === "string" ? (a[k]) : undefined;

// Root always resolves relative to the server's cwd (the host launches `leina mcp` at
// the workspace root, per the registration entry written by init/activate).
const rootOf = (a: ToolArgs): string => resolvePath(optStr(a, "root") ?? ".");

async function withFreshStore<T>(
  root: string,
  use: (store: Awaited<ReturnType<typeof openFreshStoreOrThrow>>) => T,
): Promise<T> {
  // buildIfMissing: an MCP tool must be self-sufficient — first call on a repo builds the
  // graph instead of telling a tool-calling model to go run a shell command.
  const store = await openFreshStoreOrThrow(root, { buildIfMissing: true });
  try {
    return use(store);
  } finally {
    store.close();
  }
}

function withMemStore<T>(
  root: string,
  use: (repo: ReturnType<typeof memOpenOrThrow>) => T,
): T {
  const repo = memOpenOrThrow(root);
  try {
    return use(repo);
  } finally {
    repo.close();
  }
}

// Consent gate — a globally-registered MCP server is AMBIENT (its tools show up in every
// project, and graph tools create .leina/graph.db as a side effect), so it must honour the
// per-repo opt-out the same way the agent-gate does. Explicit CLI commands never check
// consent; here only the explicit "disabled" state blocks ("unknown" stays allowed, matching
// the always-on memory philosophy). Diagnosis stays available regardless.
const CONSENT_EXEMPT = new Set(["doctor_run"]);

function assertConsent(tool: string, root: string): void {
  if (CONSENT_EXEMPT.has(tool)) return;
  if (readConsentFlag(root) === "disabled") {
    throw new Error(
      `leina is disabled in ${root} (.leina/consent = disabled — explicit opt-out). ` +
        `Ask the user before proceeding; 'leina init ${root}' re-enables.`,
    );
  }
}

// One executor per mcp.tool declared in the registry (plus doctor_run and graph_visualize,
// cli-layer only — the registry cannot reference runDoctor/runVisualizeToFile without
// breaking REQ-CR-3's no-cli-imports rule).
// NOT exposed by design: `env exec` — the names-not-values contract injects secrets
// process-to-process; an MCP tool result would pull the values into model context.
const EXECUTORS: Record<string, (a: ToolArgs) => unknown> = {
  graph_query: async (a) =>
    withFreshStore(rootOf(a), (s) => queryGraph(s, str(a, "question"), optNum(a, "depth"), optNum(a, "maxNodes"))),
  graph_affected: async (a) =>
    withFreshStore(rootOf(a), (s) => {
      const seed = resolveSeed(s, str(a, "symbol"));
      if (!seed) return { seed: null, dependents: [], note: `no graph node matches "${str(a, "symbol")}"` };
      return { seed: { id: seed.id, label: seed.label }, dependents: affected(s, seed.id, optNum(a, "depth")) };
    }),
  graph_path: async (a) =>
    withFreshStore(rootOf(a), (s) => {
      const from = resolveSeed(s, str(a, "from"));
      const to = resolveSeed(s, str(a, "to"));
      if (!from || !to) return { path: null, note: "one or both endpoints did not resolve to graph nodes" };
      return { path: shortestPath(s, from.id, to.id) };
    }),
  graph_stats: async (a) => {
    const s = openGraphRepo(rootOf(a));
    try {
      return s.stats();
    } finally {
      s.close();
    }
  },
  graph_status: (a) => graphStatus(rootOf(a)),
  graph_build: async (a) => {
    // Heavy path: lazy-import the extractor stack exactly like the CLI does.
    const { buildGraph } = await import("../../application/graph/build.ts");
    const store = openGraphRepo(rootOf(a));
    try {
      const registry = await buildDefaultRegistry();
      return await buildGraph(rootOf(a), store, registry);
    } finally {
      store.close();
    }
  },
  impact_analyze: async (a) =>
    withFreshStore(rootOf(a), (s) => analyzeImpact(s, str(a, "symbol"))),
  memory_add: (a) =>
    withMemStore(rootOf(a), (s) => {
      // Batch form (schemaVersion 2): `items` array — same per-item normalisation and
      // defaults as the CLI `memory save --batch` path.
      if (Array.isArray(a.items)) {
        const items = (a.items as Record<string, unknown>[]).map((raw): ObservationInput => {
          if (typeof raw.title !== "string" || typeof raw.content !== "string") {
            throw new TypeError("each item requires string title and content");
          }
          return {
            title: raw.title,
            content: raw.content,
            type: (raw.type as ObservationType) ?? "manual",
            topicKey: raw.topicKey as string | undefined,
            anchors: Array.isArray(raw.anchors) ? (raw.anchors as string[]) : undefined,
          };
        });
        return s.store.saveBatch(items, { atomic: a.atomic === true });
      }
      const input: ObservationInput = {
        title: str(a, "title"),
        content: str(a, "content"),
        type: (optStr(a, "type") ?? "manual") as ObservationType,
        topicKey: optStr(a, "topic"),
      };
      return s.store.save(input);
    }),
  memory_search: (a) =>
    withMemStore(rootOf(a), (s) =>
      searchMemory(s.store, str(a, "query"), { type: optStr(a, "type") as ObservationType | undefined, limit: optNum(a, "limit") }),
    ),
  memory_verified: (a) =>
    withMemStore(rootOf(a), (mem) =>
      getVerifiedContext(mem.store, str(a, "query"), mem.verifyNode, { limit: optNum(a, "limit") }),
    ),
  memory_context: (a) => withMemStore(rootOf(a), (s) => s.store.recentContext()),
  memory_get: (a) =>
    withMemStore(rootOf(a), (s) => {
      // Batch form (schemaVersion 2): `ids` array.
      if (Array.isArray(a.ids)) return s.store.getBatch(a.ids as string[]);
      return s.store.get(str(a, "id")) ?? { error: `no observation with id "${str(a, "id")}"` };
    }),
  memory_update: (a) =>
    withMemStore(rootOf(a), (s) => {
      const fields: UpdateFields = {
        title: optStr(a, "title"),
        content: optStr(a, "content"),
        type: optStr(a, "type") as ObservationType | undefined,
        anchors: Array.isArray(a.anchors) ? (a.anchors as string[]) : undefined,
      };
      return s.store.update(str(a, "id"), fields);
    }),
  memory_suggest_topic: (a) =>
    withMemStore(rootOf(a), (s) =>
      s.store.suggestTopicKeyWithMatches(str(a, "title"), optStr(a, "type") ?? "manual"),
    ),
  memory_session: (a) =>
    withMemStore(rootOf(a), (s) =>
      s.store.saveSession(str(a, "content"), { title: optStr(a, "title") }),
    ),
  context_build: (a) => buildActiveContext(rootOf(a)),
  audit_run: async (a) =>
    withFreshStore(rootOf(a), (s) => runAudit(s, { fromIds: Array.isArray(a.fromIds) ? (a.fromIds as string[]) : undefined })),
  doctor_run: (a) => runDoctor(readPackageVersion(), rootOf(a)),
  graph_visualize: async (a) => {
    // Heavy path: lazy-import like graph_build (pulls the html-export + wiring stack).
    // Returns the PATH of the generated HTML, never the HTML itself (megabytes of
    // inlined vis-network would flood the model context).
    const { runVisualizeToFile } = await import("./visualize.ts");
    return runVisualizeToFile(rootOf(a), {
      out: optStr(a, "out"),
      drilldown: a.drilldown === true,
    });
  },
};

// JSON-friendly schema override for tools whose REGISTRY schema still describes the
// port-injected form (store objects) — the MCP surface always takes root+params.
const MCP_INPUT_OVERRIDES: Record<string, object> = {
  graph_query: {
    type: "object",
    required: ["question"],
    properties: {
      root: { type: "string", description: "Project directory (default: server cwd)" },
      question: { type: "string" },
      depth: { type: "number" },
      maxNodes: { type: "number" },
    },
  },
  memory_add: {
    type: "object",
    properties: {
      root: { type: "string" },
      title: { type: "string", description: "required unless `items` is used" },
      content: { type: "string", description: "required unless `items` is used" },
      type: { type: "string", description: "decision | bugfix | discovery | manual | ..." },
      topic: { type: "string", description: "stable topic_key to upsert in place" },
      items: {
        type: "array",
        items: { type: "object" },
        description: "batch form: array of {title, content, type?, topicKey?} — save many at once",
      },
      atomic: { type: "boolean", description: "batch form: all-or-nothing transaction" },
    },
  },
  memory_search: {
    type: "object",
    required: ["query"],
    properties: {
      root: { type: "string" },
      query: { type: "string" },
      type: { type: "string" },
      limit: { type: "number" },
    },
  },
  memory_get: {
    type: "object",
    properties: {
      root: { type: "string" },
      id: { type: "string" },
      ids: { type: "array", items: { type: "string" }, description: "batch form: fetch many ids at once" },
    },
  },
  memory_update: {
    type: "object",
    required: ["id"],
    properties: {
      root: { type: "string" },
      id: { type: "string" },
      title: { type: "string" },
      content: { type: "string" },
      type: { type: "string" },
      anchors: { type: "array", items: { type: "string" } },
    },
  },
  memory_suggest_topic: {
    type: "object",
    required: ["title"],
    properties: {
      root: { type: "string" },
      title: { type: "string" },
      type: { type: "string" },
    },
  },
  memory_session: {
    type: "object",
    required: ["content"],
    properties: {
      root: { type: "string" },
      content: { type: "string", description: "session summary to persist" },
      title: { type: "string" },
    },
  },
  context_build: { type: "object", properties: { root: { type: "string" } } },
  audit_run: {
    type: "object",
    properties: { root: { type: "string" }, fromIds: { type: "array", items: { type: "string" } } },
  },
  graph_status: { type: "object", properties: { root: { type: "string" } } },
};

function listTools(): { name: string; description: string; inputSchema: object }[] {
  const fromRegistry = capabilities
    .filter((c) => c.mcp !== undefined)
    .map((c) => ({
      name: c.mcp!.tool,
      description: `${c.capability.description} (capability ${c.capability.id} v${c.capability.schemaVersion})`,
      inputSchema: MCP_INPUT_OVERRIDES[c.mcp!.tool] ?? (c.capability.inputSchema as unknown as object),
    }));
  return [
    ...fromRegistry,
    {
      name: "doctor_run",
      description: "Read-only install/project health report (environment, share, host links, project wiring, graph freshness).",
      inputSchema: { type: "object", properties: { root: { type: "string" } } },
    },
    {
      name: "graph_visualize",
      description: "Export the code graph as a self-contained offline HTML viewer. Returns the PATH of the generated file (open it in a browser), never the HTML content.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string" },
          out: { type: "string", description: "output path (default: <root>/.leina/graph.html)" },
          drilldown: { type: "boolean", description: "workspace roots: merged per-repo-coloured graph instead of the constellation view" },
        },
      },
    },
  ];
}

export async function handleMcp(_rest: string[]): Promise<void> {
  const server = new Server(
    { name: "leina", version: readPackageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const executor = EXECUTORS[name];
    if (!executor) {
      return { content: [{ type: "text", text: `unknown tool "${name}"` }], isError: true };
    }
    try {
      const args = (req.params.arguments ?? {}) as ToolArgs;
      assertConsent(name, rootOf(args));
      const result = await executor(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  // The transport owns the process from here: stay alive until stdin closes.
  await new Promise<void>((resolveDone) => {
    process.stdin.on("close", resolveDone);
    server.onclose = () => resolveDone();
  });
}
