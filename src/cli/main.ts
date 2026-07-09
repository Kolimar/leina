// leina CLI dispatcher: build and query a code knowledge graph + local project memory.
//
// This package ships this CLI plus an MCP stdio server (`leina mcp`, ./handlers/mcp.ts) that
// reuses the same capability registry, so both surfaces share one implementation. There is no
// global project registry: every command operates on an explicit <dir> (defaulting to ".")
// and runs in a short-lived process.
// The read/query path is kept cheap to start by lazy-importing the heavy extractor stack
// (web-tree-sitter + ts-morph) only when a build/rebuild actually happens.
//
// This file is a PURE DISPATCHER: it parses argv into <command> + tail and delegates to a
// command handler in ./handlers/*. The handlers own all parsing/I/O/orchestration; shared
// helpers live in ./io.ts (fail/readStdin/readIfExists), ./args.ts (flags + batch parsing)
// and ./wiring.ts (the composition root that constructs adapters behind their ports).
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
import { handleDoctor, handleAgentHook, handleSidecar, handleScip, handleCapabilities, handleVerify, printRootHelp } from "./handlers/system.ts";
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
import { readPackageVersion } from "../version.ts";

const [cmd, ...rest] = process.argv.slice(2);

// `--help`/`-h` after a subcommand must print help, never be consumed as a positional.
// Several handlers resolve <dir> from their first arg, so without this guard `leina stats
// --help` (and friends) treated "--help" as a directory — building/opening a graph in a
// folder literally named "--help". No command uses --help/-h as a functional value, so
// intercepting them here is safe. Top-level help/version tokens fall through to the switch.
if (
  cmd !== undefined &&
  !["help", "--help", "-h", "version", "--version", "-v"].includes(cmd) &&
  (rest.includes("--help") || rest.includes("-h"))
) {
  printRootHelp();
  process.exit(0);
}

switch (cmd) {
  case "version":
  case "--version":
  case "-v":
    console.log(readPackageVersion());
    break;

  case "help":
  case "--help":
  case "-h":
    // Same text as the unknown-command default.
    printRootHelp();
    break;

  case "build":
    await handleBuild(rest);
    break;

  case "refresh":
    await handleRefresh(rest);
    break;

  case "status":
    handleStatus(rest);
    break;

  case "stats":
    handleStats(rest);
    break;

  case "affected":
    await handleAffected(rest);
    break;

  case "path":
    await handlePath(rest);
    break;

  case "query":
    await handleQuery(rest);
    break;

  case "memory":
    await handleMemory(rest);
    break;

  case "events":
    handleEventsTail(rest);
    break;

  case "env":
    await handleEnv(rest);
    break;

  case "mcp": {
    // Admin subcommands first — they must not load the MCP SDK.
    if (rest[0] === "register" || rest[0] === "unregister" || rest[0] === "status") {
      const admin = await import("./handlers/mcp-admin.ts");
      if (rest[0] === "register") admin.handleMcpRegister(rest.slice(1));
      else if (rest[0] === "unregister") admin.handleMcpUnregister(rest.slice(1));
      else admin.handleMcpStatus(rest.slice(1));
      break;
    }
    // Lazy: the MCP SDK must not tax the ~0.15s read-path startup.
    const { handleMcp } = await import("./handlers/mcp.ts");
    await handleMcp(rest);
    break;
  }

  case "tui": {
    // Lazy: @clack/prompts must not tax the ~0.15s read-path startup.
    const { handleTui } = await import("./handlers/tui.ts");
    await handleTui(rest);
    break;
  }

  case "activate":
    handleActivate(rest);
    break;

  case "setup":
    handleSetup(rest);
    break;

  case "disable":
    handleDisable(rest);
    break;

  case "deactivate":
    handleDeactivate(rest);
    break;

  case "deinit":
    handleDeinit(rest);
    break;


  case "doctor":
    handleDoctor(rest);
    break;

  case "repair":
    handleRepair(rest);
    break;

  case "verify":
    handleVerify(rest);
    break;

  case "capabilities":
    handleCapabilities(rest);
    break;

  case "init":
    await handleInit(rest);
    break;

  case "agent-hook": // primary, host-neutral form
  case "devin-hook": // compat alias — existing .devin/hooks.v1.json installs invoke this
    handleAgentHook(rest);
    break;

  case "sidecar":
    await handleSidecar(rest);
    break;

  case "scip":
    await handleScip(rest);
    break;

  case "visualize":
    await handleVisualize(rest);
    break;

  // ---------------------------------------------------------------------------
  // Impact sub-command dispatcher
  // ---------------------------------------------------------------------------
  case "impact":
    await handleImpact(rest);
    break;

  // ---------------------------------------------------------------------------
  // Graph sub-command dispatcher (graph-serve) — build/refresh/status/stats/affected/
  // path/query/visualize stay top-level (unchanged); `graph serve` is the one new
  // sub-command living under its own group, per design's open question.
  // ---------------------------------------------------------------------------
  case "graph": {
    const [graphSub, ...graphRest] = rest;
    switch (graphSub) {
      case "serve": {
        // Lazy: node:http + the cli/serve/* transport must not tax the ~0.15s
        // read-path startup of every other command.
        const { handleServe } = await import("./handlers/serve.ts");
        await handleServe(graphRest);
        break;
      }
      case "gc":
        handleGraphGc(graphRest);
        break;
      default:
        process.stderr.write(
          "Usage: leina graph <serve|gc> [options]\n" +
            "  serve [<dir>] [--port <n>] [--host <h>]  live graph explorer\n" +
            "  gc [--dry-run] [--json]                  prune vanished roots from the project registry\n",
        );
        process.exit(1);
    }
    break;
  }

  // ---------------------------------------------------------------------------
  // Workspace sub-command dispatcher
  // ---------------------------------------------------------------------------
  case "workspace": {
    const [wsSub, ...wsRest] = rest;
    switch (wsSub) {
      case "build":
        await handleWorkspaceBuild(wsRest);
        break;
      case "status":
        handleWorkspaceStatus(wsRest);
        break;
      case "detect":
        handleWorkspaceDetect(wsRest);
        break;
      case "memory":
        handleWorkspaceMemory(wsRest);
        break;
      case "visualize":
        await handleWorkspaceVisualize(wsRest);
        break;
      default:
        process.stderr.write(
          "Usage: leina workspace <build|status|detect|memory|visualize> [dir] [options]\n",
        );
        process.exit(1);
    }
    break;
  }

  // ---------------------------------------------------------------------------
  // Audit sub-command dispatcher (WARN-2/FR-17)
  // `audit [dir]` is the top-level form (FR-17); sub-commands are also kept.
  // ---------------------------------------------------------------------------
  case "audit": {
    const [auditSub, ...auditRest] = rest;
    const AUDIT_SUBS = new Set(["catalog", "reachability", "pack", "visualize"]);
    if (auditSub !== undefined && AUDIT_SUBS.has(auditSub)) {
      // Named sub-command
      if (auditSub === "catalog") {
        handleAuditCatalog(auditRest);
      } else if (auditSub === "reachability") {
        handleAuditReachability(auditRest);
      } else if (auditSub === "pack") {
        await handleAuditPack(auditRest);
      } else if (auditSub === "visualize") {
        await handleAuditVisualize(auditRest);
      }
    } else {
      // `audit [dir] [options]` — full audit run (FR-17)
      const dirAndOpts = auditSub !== undefined ? [auditSub, ...auditRest] : rest;
      await handleAudit(dirAndOpts);
    }
    break;
  }

  default:
    printRootHelp();
}
