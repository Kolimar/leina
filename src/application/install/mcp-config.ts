// application/install/mcp-config.ts — merge-safe writer for MCP server registrations.
//
// Hosts that speak MCP read an `mcpServers` map from a JSON config: the project-level
// `.mcp.json` (Claude Code/Cursor convention), Cursor's user-global `~/.cursor/mcp.json`
// and Windsurf's `~/.codeium/windsurf/mcp_config.json` all share this exact shape, so one
// writer serves every file. It owns ONLY the "leina" entry: add/update it (default entry
// `{ command: "leina", args: ["mcp"] }`) and its inverse removes exactly that entry,
// preserving every other server and unknown top-level keys verbatim (same merge-safe
// convention as permissions.ts / devin-hooks.ts). Pure string -> string|null; the caller
// does the I/O. Returns null when nothing needs to change (idempotent).

const SERVER_KEY = "leina";

interface McpConfigShape {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface McpServerEntry {
  command: string;
  args: string[];
}

export const LEINA_MCP_ENTRY: McpServerEntry = { command: "leina", args: ["mcp"] };

export function addMcpRegistration(
  existing: string | null,
  entry: McpServerEntry = LEINA_MCP_ENTRY,
): string | null {
  let root: McpConfigShape = {};
  if (existing !== null && existing.trim() !== "") {
    try {
      root = JSON.parse(existing) as McpConfigShape;
    } catch {
      return null; // no-clobber: never rewrite a file we cannot parse
    }
    if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
  }
  const servers = (root.mcpServers ?? {});
  const current = JSON.stringify(servers[SERVER_KEY]);
  if (current === JSON.stringify(entry)) return null;
  servers[SERVER_KEY] = entry;
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, 2)  }\n`;
}

/** True when the config already carries the leina `mcpServers` entry (any launch form). */
export function hasMcpRegistration(existing: string | null): boolean {
  if (existing === null || existing.trim() === "") return false;
  try {
    const root = JSON.parse(existing) as McpConfigShape;
    return typeof root === "object" && root !== null && !Array.isArray(root) &&
      typeof root.mcpServers === "object" && root.mcpServers !== null &&
      SERVER_KEY in root.mcpServers;
  } catch {
    return false;
  }
}

export function removeMcpRegistration(existing: string | null): string | null {
  if (existing === null || existing.trim() === "") return null;
  let root: McpConfigShape;
  try {
    root = JSON.parse(existing) as McpConfigShape;
  } catch {
    return null;
  }
  if (typeof root !== "object" || !root?.mcpServers) return null;
  const servers = root.mcpServers;
  if (!(SERVER_KEY in servers)) return null;
  delete servers[SERVER_KEY];
  if (Object.keys(servers).length === 0) delete root.mcpServers;
  return `${JSON.stringify(root, null, 2)  }\n`;
}
