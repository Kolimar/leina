// leina CLI dispatcher: build and query a code knowledge graph + local project memory.
//
// This package ships this CLI plus an MCP stdio server (`leina mcp`, ./handlers/mcp.ts) that
// reuses the same capability registry, so both surfaces share one implementation. There is no
// global project registry: every per-project command takes an optional <dir> (default: the
// cwd, resolved to the project root) and runs in a short-lived process.
// The read/query path is kept cheap to start by lazy-importing the heavy extractor stack
// (web-tree-sitter + ts-morph) only when a build/rebuild actually happens.
//
// This file is a PURE DISPATCHER. ./commands.ts classifies argv first (resolveInvocation):
// help requests (`leina <cmd> --help`, `leina help <cmd>`, a bare group) print the command's
// help from the one command table; usage errors — an unknown command, sub-command or flag,
// a flag without its value — exit 2 on stderr before any handler runs. Only a valid
// invocation reaches the command handler in ./handlers/*, which owns parsing/I/O/
// orchestration; shared helpers live in ./io.ts (fail/usageError/readStdin), ./args.ts
// (flags + batch parsing), ./project-args.ts (<dir> resolution) and ./wiring.ts (the
// composition root that constructs adapters behind their ports).
//
// Exit codes: 0 success · 1 runtime failure (fail()) · 2 usage error (usageError()).
// The harness group keeps its documented contract (2 also covers engine/config errors).
//
// The bin ENTRY is ./index.ts, not this file: the entry runs the Node-version gate
// (./node-gate.ts) first and only then dynamically imports this dispatcher, because this
// file's static import graph reaches `node:sqlite` — which on an unsupported Node fails at
// ESM link time, before any inline check could run. process.argv[1] still points at
// index.{ts,js}, which is what deriveCliCommand and entryAssetsRootFrom anchor on.

import {
  handleAffected,
  handleBuild,
  handleGraphGc,
  handlePath,
  handleQuery,
  handleRefresh,
  handleStats,
  handleStatus,
} from "./handlers/graph.ts";
import { handleMemory } from "./handlers/memory.ts";
import { handleEventsTail } from "./handlers/events.ts";
import { handleEnv } from "./handlers/env.ts";
import { handleActivate, handleDeactivate, handleDeinit, handleDisable, handleInit, handleRepair, handleSetup } from "./handlers/install.ts";
import { handleDoctor, handleAgentHook, handleSidecar, handleScip, handleCapabilities, handleVerify } from "./handlers/system.ts";
import { handleVisualize, handleWorkspaceVisualize } from "./handlers/visualize.ts";
import {
  handleWorkspaceBuild,
  handleWorkspaceStatus,
  handleWorkspaceDetect,
  handleWorkspaceMemory,
} from "./handlers/workspace.ts";
import {
  handleAudit,
  handleAuditCatalog,
  handleAuditReachability,
  handleAuditPack,
  handleAuditVisualize,
} from "./handlers/audit.ts";
import { handleImpact } from "./handlers/impact.ts";
import { renderHelp, resolveInvocation } from "./commands.ts";
import { setCommandPath, usageError } from "./io.ts";
import { readPackageVersion } from "../version.ts";

type Handler = (rest: string[]) => void | Promise<void>;

/** The sub-command handler of a group: `rest[0]` names it (validated by resolveInvocation). */
function bySub(subs: Record<string, Handler>, bare?: Handler): Handler {
  return (rest) => {
    const [sub, ...subRest] = rest;
    const handler = sub !== undefined ? subs[sub] : undefined;
    return handler ? handler(subRest) : bare!(rest);
  };
}

// Sub-commands and flags were validated by resolveInvocation: every entry below receives a
// known command, and every group a known sub-command (or none, when it runs bare).
const HANDLERS: Record<string, Handler> = {
  build: handleBuild,
  refresh: handleRefresh,
  status: handleStatus,
  stats: handleStats,
  affected: handleAffected,
  path: handlePath,
  query: handleQuery,
  memory: handleMemory,
  events: (rest) => handleEventsTail(rest.slice(1)),
  env: handleEnv,
  mcp: async (rest) => {
    // Admin sub-commands first — they must not load the MCP SDK.
    if (rest[0] !== undefined) {
      const admin = await import("./handlers/mcp-admin.ts");
      const subs: Record<string, Handler> = {
        register: admin.handleMcpRegister,
        unregister: admin.handleMcpUnregister,
        status: admin.handleMcpStatus,
      };
      await subs[rest[0]]!(rest.slice(1));
      return;
    }
    // Lazy: the MCP SDK must not tax the ~0.15s read-path startup.
    const { handleMcp } = await import("./handlers/mcp.ts");
    await handleMcp(rest);
  },
  tui: async (rest) => {
    // Lazy: @clack/prompts must not tax the ~0.15s read-path startup.
    const { handleTui } = await import("./handlers/tui.ts");
    await handleTui(rest);
  },
  activate: handleActivate,
  setup: handleSetup,
  disable: handleDisable,
  deactivate: handleDeactivate,
  deinit: handleDeinit,
  doctor: handleDoctor,
  repair: handleRepair,
  verify: handleVerify,
  capabilities: handleCapabilities,
  init: handleInit,
  "agent-hook": handleAgentHook, // primary, host-neutral form
  "devin-hook": handleAgentHook, // compat alias — existing .devin/hooks.v1.json installs invoke this
  sidecar: handleSidecar,
  harness: async (rest) => {
    // Lazy: the harness engine (rule loader, gates, adapters) must not tax the ~0.15s
    // read-path startup of every other command.
    const { handleHarness } = await import("./handlers/harness.ts");
    await handleHarness(rest);
  },
  scip: handleScip,
  visualize: handleVisualize,
  impact: handleImpact,
  graph: bySub({
    serve: async (rest) => {
      // Lazy: node:http + the cli/serve/* transport must not tax the read-path startup.
      const { handleServe } = await import("./handlers/serve.ts");
      await handleServe(rest);
    },
    gc: handleGraphGc,
  }),
  workspace: bySub({
    build: handleWorkspaceBuild,
    status: handleWorkspaceStatus,
    detect: handleWorkspaceDetect,
    memory: handleWorkspaceMemory,
    visualize: handleWorkspaceVisualize,
  }),
  // `audit [dir] [options]` runs the full audit; the named sub-commands are kept.
  audit: bySub(
    {
      catalog: handleAuditCatalog,
      reachability: handleAuditReachability,
      pack: handleAuditPack,
      visualize: handleAuditVisualize,
    },
    handleAudit,
  ),
};

const argv = process.argv.slice(2);
const invocation = resolveInvocation(argv);

if (invocation.kind === "version") {
  console.log(readPackageVersion());
} else if (invocation.kind === "help") {
  console.log(renderHelp(invocation.path));
} else if (invocation.kind === "usage") {
  usageError(invocation.message, invocation.path);
} else {
  setCommandPath(invocation.path);
  const [cmd, ...rest] = invocation.argv;
  await HANDLERS[cmd!]!(rest);
}
