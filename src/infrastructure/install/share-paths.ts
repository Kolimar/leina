// share-paths.ts — Canonical filesystem locations for the GLOBAL leina share.
//
// The "share" is the single source of truth for skills/agents/workflows that get linked into
// the Devin host's global directory (~/.config/devin). Centralising paths here keeps the
// install layer host-agnostic and gives tests a single seam to redirect via
// LEINA_HOME / HOME / USERPROFILE.
//
// All resolvers are pure functions of `process.env`. They never touch the filesystem.

import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import type { HostId } from "../../domain/install/hosts.ts";

export { type HostId } from "../../domain/install/hosts.ts";

/** Root of leina's own home dir. Override with $LEINA_HOME (used by tests). */
export function leinaHome(): string {
  return process.env.LEINA_HOME ?? resolve(homedir(), ".leina");
}

/** Single source of truth for skills/agents/workflows shared across hosts. */
export function shareRoot(): string {
  return join(leinaHome(), "share");
}

export function shareSkillsDir(): string {
  return join(shareRoot(), "skills");
}

export function shareAgentsDir(): string {
  return join(shareRoot(), "agents");
}

/** Original flat agent .md files, kept for hosts with agentShape "file" (Claude Code). */
export function shareClaudeAgentsDir(): string {
  return join(shareRoot(), "claude-agents");
}

export function shareWorkflowsDir(): string {
  return join(shareRoot(), "workflows");
}

/** Sentinel file: when its contents differ from the running package version, repopulate. */
export function shareVersionFile(): string {
  return join(shareRoot(), ".version");
}

/** Persisted asset selection (null/absent = everything). Changing it forces a repopulate. */
export function shareSelectionFile(): string {
  return join(shareRoot(), ".selection.json");
}

// ---------------------------------------------------------------------------
// Host install roots (global, per-machine).
// ---------------------------------------------------------------------------
//
// Devin reads $XDG-style ~/.config/devin (Linux/macOS) or %APPDATA%\devin (Windows).
// Symlinks land at e.g. ~/.config/devin/skills/<name>/  →  share/skills/<name>/

/** Honour $HOME and $USERPROFILE both so tests can redirect either way. */
export function userHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

// Devin's config root: $XDG-style ~/.config/devin (Linux/macOS) or %APPDATA%\devin
// (Windows; honour $APPDATA if set). Every Devin path hangs off this one resolver.
function devinConfigRoot(): string {
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(userHome(), "AppData", "Roaming"), "devin");
  }
  return join(userHome(), ".config", "devin");
}

/** Devin global skills root. */
export function devinSkillsRoot(): string {
  return join(devinConfigRoot(), "skills");
}

/** Devin global custom-subagent profiles root. */
export function devinAgentsRoot(): string {
  return join(devinConfigRoot(), "agents");
}

/**
 * User-global Devin config file (`~/.config/devin/config.json`, or `%APPDATA%\devin\config.json`
 * on Windows). This is the machine-wide config where the global `Exec(leina)` permission
 * grant lives — see Devin's [permissions reference](file locations note).
 */
export function devinUserConfigFile(): string {
  return join(devinConfigRoot(), "config.json");
}

/** Claude Code global skills root (~/.claude/skills — same layout on all platforms). */
export function claudeSkillsRoot(): string {
  return join(userHome(), ".claude", "skills");
}

/** Claude Code global agents root (~/.claude/agents — one flat .md file per agent). */
export function claudeAgentsRoot(): string {
  return join(userHome(), ".claude", "agents");
}

// ---------------------------------------------------------------------------
// Host table — every AI host leina can link the share into. The install layer
// iterates this table and only this table: destination roots, agent format AND
// the share subdir that format is generated into are all declared here, so
// adding a host is one entry (plus a populate transform if its agent format
// is genuinely new).
// ---------------------------------------------------------------------------

export interface HostSpec {
  id: HostId;
  label: string;
  skillsRoot: () => string;
  agentsRoot: () => string;
  /** How the host consumes agents: a directory per agent (AGENT.md inside) or a flat .md file. */
  agentShape: "dir" | "file";
  /** Share subdir the host's agent links point INTO (populateShare's output for its shape). */
  agentShareDir: () => string;
}

export const HOSTS: readonly HostSpec[] = [
  {
    id: "devin",
    label: "Devin",
    skillsRoot: devinSkillsRoot,
    agentsRoot: devinAgentsRoot,
    agentShape: "dir",
    agentShareDir: shareAgentsDir,
  },
  {
    id: "claude",
    label: "Claude Code",
    skillsRoot: claudeSkillsRoot,
    agentsRoot: claudeAgentsRoot,
    agentShape: "file",
    agentShareDir: shareClaudeAgentsDir,
  },
];

export function hostSpec(id: string): HostSpec | undefined {
  return HOSTS.find((h) => h.id === id);
}

// ---------------------------------------------------------------------------
// MCP host table — every host the leina MCP server can be registered into at
// USER (global) scope. Deliberately separate from HOSTS: that table drives
// skills/agents symlinking, and Cursor/Windsurf consume the MCP server without
// consuming the share. One server entry covers all projects (each tool takes
// `root`, defaulting to the cwd the host launches the server in).
// ---------------------------------------------------------------------------

export type McpHostId = "claude" | "cursor" | "windsurf";

export interface McpHostSpec {
  id: McpHostId;
  label: string;
  /**
   * How the user-scope registration is performed:
   *  - json-file: merge our entry into an `mcpServers` JSON config we can own safely.
   *  - claude-cli: delegate to `claude mcp add --scope user` — Claude Code's user-scope
   *    registry lives in `~/.claude.json`, a large host-owned state file with no stable
   *    contract; we never write it directly (read-only inspection only).
   */
  registration: { kind: "json-file"; configFile: () => string } | { kind: "claude-cli" };
}

/** Cursor's user-global MCP config (`~/.cursor/mcp.json`, `mcpServers` shape). */
export function cursorMcpConfigFile(): string {
  return join(userHome(), ".cursor", "mcp.json");
}

/** Windsurf's user-global MCP config (`~/.codeium/windsurf/mcp_config.json`, `mcpServers` shape). */
export function windsurfMcpConfigFile(): string {
  return join(userHome(), ".codeium", "windsurf", "mcp_config.json");
}

/** Claude Code user-scope state file — READ-ONLY for us (inspection); writes go via `claude mcp`. */
export function claudeUserStateFile(): string {
  return join(userHome(), ".claude.json");
}

/** Claude Code user settings (`~/.claude/settings.json`) — where the mcp__leina grant lives. */
export function claudeUserSettingsFile(): string {
  return join(userHome(), ".claude", "settings.json");
}

export const MCP_HOSTS: readonly McpHostSpec[] = [
  { id: "claude", label: "Claude Code", registration: { kind: "claude-cli" } },
  { id: "cursor", label: "Cursor", registration: { kind: "json-file", configFile: cursorMcpConfigFile } },
  { id: "windsurf", label: "Windsurf", registration: { kind: "json-file", configFile: windsurfMcpConfigFile } },
];

/** Single global memory DB shared across all repos. Honors $LEINA_HOME. */
export function globalMemoryPath(): string {
  return join(leinaHome(), "memory.db");
}

/**
 * Sentinel file that signals "blanket mode" is active on this machine.
 * When present: `isBlanketActive()` returns true and `init` takes the LIGHT path.
 * When absent: `init` takes the FULL (standalone) path.
 * Lives inside $LEINA_HOME so it is isolated by $LEINA_HOME in tests,
 * mirroring the pattern of shareVersionFile().
 */
export function blanketFile(): string {
  return join(leinaHome(), ".blanket");
}
