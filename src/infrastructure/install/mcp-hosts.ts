// mcp-hosts.ts — user-global (per-machine) registration of the leina MCP server.
//
// One registration per host covers ALL projects: every MCP tool takes an optional `root`
// that defaults to the cwd the host launches the server in, so nothing here is per-repo.
// The per-repo `.mcp.json` (init --mcp) remains as the committable, team-shared variant.
//
// Conservative by contract:
//  - json-file hosts (Cursor, Windsurf): we only write if the host's config DIRECTORY
//    already exists — a present ~/.cursor means "Cursor is installed here"; we never
//    create a host's tree for it. Malformed JSON is never clobbered (writer returns null).
//  - Claude Code: user-scope servers live in ~/.claude.json, a large host-owned state
//    file with no stable contract — NEVER written directly. We inspect it read-only and
//    delegate writes to `claude mcp add/remove --scope user`, skipping with the manual
//    command in `detail` when the binary is not on PATH. The mcp__leina permission grant
//    goes to ~/.claude/settings.json, which IS a documented settings file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  addMcpRegistration,
  hasMcpRegistration,
  removeMcpRegistration,
} from "../../application/install/mcp-config.ts";
import { grantMcpPermission, revokeMcpPermission } from "../../application/install/permissions.ts";
import {
  MCP_HOSTS,
  claudeUserSettingsFile,
  claudeUserStateFile,
  type McpHostId,
  type McpHostSpec,
} from "./share-paths.ts";

export interface McpHostResult {
  host: McpHostId;
  label: string;
  action: "written" | "unchanged" | "skipped" | "failed";
  detail: string;
}

export interface McpRegState {
  host: McpHostId;
  label: string;
  state: "registered" | "absent" | "not-installed" | "unknown";
  detail: string;
}

const MANUAL_ADD = "claude mcp add --scope user leina leina mcp";
const MANUAL_REMOVE = "claude mcp remove --scope user leina";

/** Scan $PATH for a binary (plus Windows launcher extensions). Returns its path or null. */
export function findOnPath(bin: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* unreadable PATH entry — keep scanning */
      }
    }
  }
  return null;
}

function readIfExists(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

function selected(hosts?: McpHostId[]): readonly McpHostSpec[] {
  return hosts === undefined ? MCP_HOSTS : MCP_HOSTS.filter((h) => hosts.includes(h.id));
}

// ---------------------------------------------------------------------------
// Inspect (read-only — safe for doctor)
// ---------------------------------------------------------------------------

export function inspectMcpGlobal(): McpRegState[] {
  return MCP_HOSTS.map((h) => {
    if (h.registration.kind === "json-file") {
      const file = h.registration.configFile();
      if (!existsSync(dirname(file))) {
        return { host: h.id, label: h.label, state: "not-installed", detail: `${dirname(file)} absent` };
      }
      return hasMcpRegistration(readIfExists(file))
        ? { host: h.id, label: h.label, state: "registered", detail: file }
        : { host: h.id, label: h.label, state: "absent", detail: file };
    }
    // claude-cli: read-only inspection of the host state file.
    const state = readIfExists(claudeUserStateFile());
    if (state !== null && hasMcpRegistration(state)) {
      return { host: h.id, label: h.label, state: "registered", detail: `${claudeUserStateFile()} (user scope)` };
    }
    if (findOnPath("claude") === null && state === null) {
      return { host: h.id, label: h.label, state: "not-installed", detail: "claude binary not on PATH" };
    }
    return { host: h.id, label: h.label, state: "absent", detail: `register with: ${MANUAL_ADD}` };
  });
}

// ---------------------------------------------------------------------------
// Register / unregister
// ---------------------------------------------------------------------------

export function registerMcpGlobal(hosts?: McpHostId[]): McpHostResult[] {
  return selected(hosts).map((h) =>
    h.registration.kind === "json-file"
      ? registerJsonFile(h, h.registration.configFile())
      : registerClaude(h),
  );
}

export function unregisterMcpGlobal(hosts?: McpHostId[]): McpHostResult[] {
  return selected(hosts).map((h) =>
    h.registration.kind === "json-file"
      ? unregisterJsonFile(h, h.registration.configFile())
      : unregisterClaude(h),
  );
}

function registerJsonFile(h: McpHostSpec, file: string): McpHostResult {
  const dir = dirname(file);
  if (!existsSync(dir)) {
    return { host: h.id, label: h.label, action: "skipped", detail: `${dir} absent — ${h.label} not installed on this machine` };
  }
  const existing = readIfExists(file);
  const merged = addMcpRegistration(existing);
  if (merged === null) {
    return hasMcpRegistration(existing)
      ? { host: h.id, label: h.label, action: "unchanged", detail: `already registered in ${file}` }
      : { host: h.id, label: h.label, action: "failed", detail: `${file} is not valid JSON — not touched (fix or remove it, then retry)` };
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, merged);
    return { host: h.id, label: h.label, action: "written", detail: file };
  } catch (err) {
    return { host: h.id, label: h.label, action: "failed", detail: `${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function unregisterJsonFile(h: McpHostSpec, file: string): McpHostResult {
  const stripped = removeMcpRegistration(readIfExists(file));
  if (stripped === null) {
    return { host: h.id, label: h.label, action: "unchanged", detail: `no leina entry in ${file}` };
  }
  try {
    writeFileSync(file, stripped);
    return { host: h.id, label: h.label, action: "written", detail: `leina entry removed from ${file}` };
  } catch (err) {
    return { host: h.id, label: h.label, action: "failed", detail: `${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function registerClaude(h: McpHostSpec): McpHostResult {
  // Already registered? (read-only check — never write ~/.claude.json ourselves)
  if (hasMcpRegistration(readIfExists(claudeUserStateFile()))) {
    applyClaudeGrant(); // grant is idempotent; ensure it even when the server entry pre-exists
    return { host: h.id, label: h.label, action: "unchanged", detail: "already registered (user scope)" };
  }
  const bin = findOnPath("claude");
  if (bin === null) {
    return { host: h.id, label: h.label, action: "skipped", detail: `claude binary not on PATH — run manually: ${MANUAL_ADD}` };
  }
  const res = spawnSync(bin, ["mcp", "add", "--scope", "user", "leina", "leina", "mcp"], { encoding: "utf8" });
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || `exit ${res.status}`).trim();
    return { host: h.id, label: h.label, action: "failed", detail: `${MANUAL_ADD} → ${msg}` };
  }
  applyClaudeGrant();
  return { host: h.id, label: h.label, action: "written", detail: "registered via claude mcp add (user scope)" };
}

function unregisterClaude(h: McpHostSpec): McpHostResult {
  revokeClaudeGrant();
  if (!hasMcpRegistration(readIfExists(claudeUserStateFile()))) {
    return { host: h.id, label: h.label, action: "unchanged", detail: "not registered (user scope)" };
  }
  const bin = findOnPath("claude");
  if (bin === null) {
    return { host: h.id, label: h.label, action: "skipped", detail: `claude binary not on PATH — run manually: ${MANUAL_REMOVE}` };
  }
  const res = spawnSync(bin, ["mcp", "remove", "--scope", "user", "leina"], { encoding: "utf8" });
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || `exit ${res.status}`).trim();
    return { host: h.id, label: h.label, action: "failed", detail: `${MANUAL_REMOVE} → ${msg}` };
  }
  return { host: h.id, label: h.label, action: "written", detail: "removed via claude mcp remove (user scope)" };
}

// mcp__leina server-level grant in ~/.claude/settings.json (documented settings file, unlike
// ~/.claude.json). Both helpers are merge-safe/idempotent; failures are silent by design —
// the grant only saves a permission prompt, it never gates the registration itself.
function applyClaudeGrant(): void {
  try {
    const file = claudeUserSettingsFile();
    const granted = grantMcpPermission(readIfExists(file));
    if (granted !== null) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, granted);
    }
  } catch {
    /* advisory only */
  }
}

function revokeClaudeGrant(): void {
  try {
    const file = claudeUserSettingsFile();
    const revoked = revokeMcpPermission(readIfExists(file));
    if (revoked !== null) writeFileSync(file, revoked);
  } catch {
    /* advisory only */
  }
}
