// infrastructure/config/project-registry-store.ts — read/write the global project
// registry (`~/.leina/projects.json`), the driven adapter for
// application/project/registry.ts.
//
// Pattern cloned from freshness.ts: fail-open. An absent, unreadable or corrupt file
// never throws — callers get an empty list back and the calling command (build/refresh/
// serve/init) proceeds unaffected. This registry is best-effort bookkeeping for the
// `graph serve` project selector, not a source of truth.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leinaHome } from "../install/share-paths.ts";
import { upsertProject, type ProjectEntry } from "../../application/project/registry.ts";

/** `~/.leina/projects.json` (honours $LEINA_HOME, same as globalMemoryPath()). */
export function projectRegistryPath(): string {
  return join(leinaHome(), "projects.json");
}

function isProjectEntry(value: unknown): value is ProjectEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.projectKey === "string" &&
    typeof v.root === "string" &&
    typeof v.lastBuild === "number"
  );
}

/** Read the registry. Absent/corrupt/malformed file → empty list, never throws. */
export function readProjectRegistry(): ProjectEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(projectRegistryPath(), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProjectEntry);
  } catch {
    return [];
  }
}

/** Overwrite the registry file. Best-effort: write failures are swallowed (fail-open). */
export function writeProjectRegistry(list: ProjectEntry[]): void {
  try {
    const home = leinaHome();
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    writeFileSync(projectRegistryPath(), JSON.stringify(list, null, 2), "utf8");
  } catch {
    // Registry bookkeeping must never block the caller's actual command.
  }
}

/**
 * Read-merge-write `entry` into the global registry in one call — the opportunistic
 * upsert used by `build`/`refresh`/`serve`/`init`. Fail-open end to end.
 */
export function recordProject(entry: ProjectEntry): void {
  writeProjectRegistry(upsertProject(readProjectRegistry(), entry));
}
