// application/project/workspace-config.ts
// Parser for the optional `workspace.json` marker file at the workspace root.
//
// Schema v1:
//   {}                             — valid (forces workspace mode with all repos)
//   { "exclude": ["legacy-repo"] } — exclude listed repo directory names
//   { unknown fields ... }        — silently ignored (extensibility, FR-02/A1)
//
// readWorkspaceConfig returns null when the file is absent or cannot be read/parsed.
// A malformed JSON file (or one with unexpected types) returns null (fail-open).

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceConfig {
  /** Directory names to exclude from auto-discovery. Default []. */
  exclude: string[];
}

/**
 * Read and parse `<wsRoot>/workspace.json`.
 * Returns null if the file is absent, unreadable, or not a JSON object.
 * Unknown fields are silently ignored (forward-compatible schema).
 */
export function readWorkspaceConfig(wsRoot: string): WorkspaceConfig | null {
  const cfgPath = join(wsRoot, "workspace.json");
  let raw: string;
  try {
    raw = readFileSync(cfgPath, "utf8");
  } catch {
    return null; // file absent or unreadable
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed JSON
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null; // not a plain object
  }

  const obj = parsed as Record<string, unknown>;

  // Parse `exclude` — must be an array of strings if present; otherwise default to [].
  let exclude: string[] = [];
  if ("exclude" in obj) {
    const raw = obj.exclude;
    if (Array.isArray(raw)) {
      exclude = raw.filter((item): item is string => typeof item === "string");
    }
    // if not an array, silently ignore it (forward-compat)
  }

  return { exclude };
}
