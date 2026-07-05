// cli/handlers/mcp-admin.ts — `leina mcp register|unregister|status`: user-global
// MCP registration management.
//
// Deliberately separate from mcp.ts (the stdio server): these admin commands must not
// load the MCP SDK — main.ts routes them here BEFORE the lazy server import, keeping
// the ~0.15s read-path startup intact.
//
// One user-scope registration covers all projects: the server resolves each tool's
// `root` argument at call time (default: the cwd the host launched it in). The per-repo
// `.mcp.json` (init --mcp) stays available as the committable, team-shared variant.

import {
  inspectMcpGlobal,
  registerMcpGlobal,
  unregisterMcpGlobal,
  type McpHostResult,
} from "../../infrastructure/install/mcp-hosts.ts";
import { MCP_HOSTS, type McpHostId } from "../../infrastructure/install/share-paths.ts";
import { fail } from "../io.ts";
import { optFlag } from "../args.ts";

function parseHosts(rest: string[]): McpHostId[] | undefined {
  const raw = optFlag(rest, "--hosts", undefined);
  if (raw === undefined) return undefined;
  const ids = raw.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  for (const id of ids) {
    if (!MCP_HOSTS.some((h) => h.id === id)) {
      fail(`unknown MCP host "${id}" (known: ${MCP_HOSTS.map((h) => h.id).join(", ")})`);
    }
  }
  return ids as McpHostId[];
}

const MARK: Record<McpHostResult["action"], string> = {
  written: "+",
  unchanged: "=",
  skipped: "·",
  failed: "✖",
};

/** Shared result printer (also used by activate/setup's --mcp step). */
export function printMcpResults(results: McpHostResult[]): void {
  for (const r of results) {
    console.log(`  ${MARK[r.action]} ${r.label}: ${r.detail}`);
  }
  if (results.some((r) => r.action === "failed")) process.exitCode = 1;
}

export function handleMcpRegister(rest: string[]): void {
  console.log("leina mcp register — user-global registration (one server, every project):");
  printMcpResults(registerMcpGlobal(parseHosts(rest)));
  console.log(`\nProject-level alternative (committable, for teams): leina init <dir> --mcp`);
}

export function handleMcpUnregister(rest: string[]): void {
  console.log("leina mcp unregister — removing user-global registrations:");
  printMcpResults(unregisterMcpGlobal(parseHosts(rest)));
}

export function handleMcpStatus(_rest: string[]): void {
  console.log("leina mcp status — user-global registrations:");
  for (const s of inspectMcpGlobal()) {
    const mark = s.state === "registered" ? "✔" : s.state === "not-installed" ? "·" : "—";
    console.log(`  ${mark} ${s.label}: ${s.state} (${s.detail})`);
  }
  console.log(`\nRegister with: leina mcp register [--hosts ${MCP_HOSTS.map((h) => h.id).join(",")}]`);
}
