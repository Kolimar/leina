// application/context/active-context.ts — Active context injection for SessionStart / PostCompaction.
// Extracted from cli/active-context.ts to place the context-building
// use case in the application layer, where it belongs per the hexagonal architecture.
//
// cli/active-context.ts is now a shim that re-exports from this module, preserving
// the public surface used by cli/agent-gate.ts and existing tests.
//
// arch-rule-3: this file must not import node:sqlite, node:child_process,
//   web-tree-sitter, or ts-morph.  It imports infrastructure/sqlite/* which
//   wraps node:sqlite — that is explicitly allowed (the literal module name
//   "node:sqlite" does not appear here).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { SQLiteMemoryRepository as MemoryStore } from "../../infrastructure/sqlite/memory-repository.ts";
import type { Observation } from "../../domain/memory/model.ts";
import { globalMemoryPath } from "../../infrastructure/install/share-paths.ts";
import { deriveProjectKey } from "../project/detect-key.ts";
import { GraphStore } from "../../infrastructure/sqlite/graph-store.ts";
import { isStale } from "../graph/manifest.ts";

// Fallback text injected when active injection is unavailable.
export const SESSION_START_CONTEXT =
  "leina: context injection unavailable — run `leina memory context <dir>` to " +
  "load prior decisions, conventions and SDD artifacts. Prefer `leina query` / " +
  "`leina affected` over grepping for structural questions. This guidance is advisory only. " +
  "Before ending the session, run `leina memory session <dir>` to persist a summary.";

export interface ActiveContextDeps {
  memoryPath: string;
  graphDbPath: string;
  projectKey: string;
}

export interface ActiveContextResult {
  text: string;
  delivered: boolean;
}

export function buildActiveContext(cwd: string): ActiveContextResult {
  try {
    const start = Date.now();
    const BUDGET_MS = 2500;
    const MEMORY_CAP = 4000;
    const SNIPPET_MAX = 200;

    const key = deriveProjectKey(cwd).key;

    const parts: string[] = [];
    const { section, delivered } = readMemorySection(key, MEMORY_CAP, SNIPPET_MAX);
    parts.push(section);

    const graphDbPath = join(cwd, ".leina", "graph.db");
    let graphPart = "";
    if (Date.now() - start < BUDGET_MS) graphPart = readGraphStatsPart(graphDbPath);

    let freshnessPart = "";
    if (Date.now() - start < BUDGET_MS) {
      const note = computeFreshnessNote(cwd, graphDbPath, graphPart);
      graphPart = note.graphPart;
      freshnessPart = note.freshnessPart;
    } else if (graphPart) {
      freshnessPart = "freshness: skipped";
    }

    if (graphPart) parts.push(graphPart);
    if (freshnessPart) parts.push(freshnessPart);

    parts.push("Before ending the session, run `leina memory session <dir>` to persist a summary.");

    const text = parts.filter((p) => p.length > 0).join("\n\n");
    return { text: text.length > 0 ? text : SESSION_START_CONTEXT, delivered };
  } catch {
    return { text: SESSION_START_CONTEXT, delivered: false };
  }
}

function readMemorySection(
  key: string,
  memoryCap: number,
  snippetMax: number,
): { section: string; delivered: boolean } {
  let mem: InstanceType<typeof MemoryStore> | null = null;
  try {
    mem = new MemoryStore(globalMemoryPath(), key);
    const { observations } = mem.recentContext({ limit: 10 });
    if (observations.length === 0) {
      return { section: "## Project memory\n(no observations yet)", delivered: true };
    }
    return { section: formatMemorySection(observations, memoryCap, snippetMax), delivered: true };
  } finally {
    try {
      mem?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

function formatMemorySection(observations: Observation[], memoryCap: number, snippetMax: number): string {
  const lines: string[] = ["## Project memory"];
  let charCount = lines[0]!.length + 1;
  for (const obs of observations) {
    const entry = `- ${obs.title} [${obs.type}]\n  ${formatSnippet(obs.content ?? "", snippetMax)}`;
    if (charCount + entry.length + 1 > memoryCap) break;
    lines.push(entry);
    charCount += entry.length + 1;
  }
  return lines.join("\n");
}

function formatSnippet(rawContent: string, snippetMax: number): string {
  const firstLine = rawContent.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (firstLine.length > snippetMax) {
    const cut = firstLine.slice(0, snippetMax);
    const lastSpace = cut.lastIndexOf(" ");
    return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut  }…`;
  }
  return firstLine;
}

function readGraphStatsPart(graphDbPath: string): string {
  if (!existsSync(graphDbPath)) return "";
  try {
    const gs = new GraphStore(graphDbPath);
    try {
      const { nodes, edges } = gs.stats();
      return `graph: ${nodes} nodes, ${edges} edges`;
    } finally {
      try {
        gs.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return "";
  }
}

function computeFreshnessNote(
  cwd: string,
  graphDbPath: string,
  graphPart: string,
): { graphPart: string; freshnessPart: string } {
  if (!existsSync(graphDbPath)) {
    return { graphPart, freshnessPart: `run: leina build ${cwd}` };
  }
  if (graphPart) {
    try {
      const staleResult = isStale(cwd);
      if (staleResult.stale) {
        return { graphPart: `${graphPart} (stale)`, freshnessPart: `run: leina refresh ${cwd}` };
      }
      return { graphPart: `${graphPart} (fresh)`, freshnessPart: "" };
    } catch {
      /* fail open */
    }
  }
  return { graphPart, freshnessPart: "" };
}
