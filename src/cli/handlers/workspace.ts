// cli/handlers/workspace.ts — workspace-level command handlers
// Commands:
//   leina workspace build [dir] [--json] [--single|--workspace]
//   leina workspace status [dir] [--single|--workspace]
//   leina workspace detect [dir] [--single|--workspace]
//   leina workspace memory context [dir]    (CRIT-2: federated memory)
//   leina workspace memory search [dir] <query>
// <dir> is the workspace root as given (default: the current directory) — never resolved
// upwards like a project <dir> — and must be an existing directory.

import { join } from "node:path";
import { statSync, writeFileSync } from "node:fs";
import { detectWorkspaceMode } from "../../application/project/detect-key.ts";
import { isStaleWorkspace } from "../../application/workspace/manifest.ts";
import { openWorkspaceFreshStore, openWorkspaceMemoryRepo } from "../wiring.ts";
import { usageError } from "../io.ts";
import { commandWords, existingDir, looksLikePath, optionalDir } from "../project-args.ts";

/** `--single` / `--workspace`: override the workspace auto-detection. */
function modeFlags(rest: string[]): { single: boolean; workspace: boolean } {
  return { single: rest.includes("--single"), workspace: rest.includes("--workspace") };
}

/** The workspace root of `workspace <sub> [<dir>]`, as given. */
function workspaceRoot(path: string, rest: string[]): string {
  return existingDir(optionalDir(path, rest) ?? ".");
}

/**
 * `leina workspace build [dir] [--json]`
 * Build all member repos and the merged store.
 */
export async function handleWorkspaceBuild(rest: string[]): Promise<void> {
  const resolved = workspaceRoot("workspace build", rest);
  const wantJson = rest.includes("--json");

  console.log(`leina workspace: building workspace at ${resolved} …`);

  const mergedStore = await openWorkspaceFreshStore(resolved, modeFlags(rest));
  try {
    const stats = mergedStore.stats();
    console.log(`  merged graph: ${stats.nodes} nodes, ${stats.edges} edges`);

    if (wantJson) {
      const outPath = join(resolved, ".leina", "workspace-graph.json");
      writeFileSync(outPath, JSON.stringify(mergedStore.toNodeLink(), null, 2), "utf8");
      console.log(`  exported ${outPath}`);
    }
  } finally {
    mergedStore.close();
  }
}

/**
 * `leina workspace status [dir]`
 * Detect mode and report which members are fresh/stale.
 */
export function handleWorkspaceStatus(rest: string[]): void {
  const resolved = workspaceRoot("workspace status", rest);

  const detection = detectWorkspaceMode(resolved, modeFlags(rest));

  if (detection.mode === "single") {
    console.log(`mode: single-repo (no workspace detected at ${resolved})`);
    return;
  }

  console.log(`mode: workspace (${detection.members.length} members, source: ${detection.source})`);
  for (const m of detection.members) {
    const stale = isStaleWorkspace([m]);
    const status = stale ? "STALE" : "fresh";
    console.log(`  [${status}] ${m.repoKey}  (${m.dir})`);
  }
}

/**
 * `leina workspace detect [dir]`
 * Print the detected workspace structure as JSON.
 */
export function handleWorkspaceDetect(rest: string[]): void {
  const resolved = workspaceRoot("workspace detect", rest);

  const detection = detectWorkspaceMode(resolved, modeFlags(rest));

  const output = {
    mode: detection.mode,
    source: detection.source,
    members: detection.members.map((m) => ({ repoKey: m.repoKey, dir: m.dir })),
  };

  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// `leina workspace memory context [dir]` (CRIT-2: federated memory)
// `leina workspace memory search [dir] <query>`
// ---------------------------------------------------------------------------

/**
 * `leina workspace memory context [dir]`
 * Shows recent observations across all member repos (federated via WorkspaceMemoryFederator).
 *
 * `leina workspace memory search [dir] <query>`
 * Searches memory across all member repos (federated search).
 */
type WorkspaceMemoryStore = ReturnType<typeof openWorkspaceMemoryRepo>["store"];

// `workspace memory search [dir] <query>` — federated full-text search across members.
function runWorkspaceMemorySearch(store: WorkspaceMemoryStore, query: string): void {
  const hits = store.search(query, { limit: 20 });
  if (hits.length === 0) {
    console.log("(no results)");
    return;
  }
  for (const h of hits) {
    console.log(`  #${h.id} [score ${h.score.toFixed(2)}] ${h.title}`);
    if (h.snippet) console.log(`    ${h.snippet.slice(0, 120)}`);
  }
}

// `workspace memory context [dir]` — recent observations + sessions across members.
function runWorkspaceMemoryContext(store: WorkspaceMemoryStore): void {
  const ctx = store.recentContext({ limit: 10, sessionLimit: 3 });
  if (ctx.observations.length === 0 && ctx.sessions.length === 0) {
    console.log("(no observations yet)");
    return;
  }
  if (ctx.sessions.length > 0) {
    console.log("Recent sessions:");
    for (const s of ctx.sessions) {
      console.log(`  [${new Date(s.startedAt).toISOString()}] ${s.title ?? "(untitled)"}`);
    }
  }
  if (ctx.observations.length > 0) {
    console.log("Recent observations:");
    for (const o of ctx.observations) {
      console.log(`  #${o.id} ${o.title} (${o.type})`);
    }
  }
}

/** `[<dir>] <query...>` — the same rule as `memory search`, with the root taken as given. */
function workspaceDirThenQuery(args: string[]): { root: string; query: string } {
  const words = commandWords("workspace memory search", args);
  if (words.length === 0) usageError("missing <query>", "workspace memory search");
  const first = words[0]!;
  let isDir = false;
  try {
    isDir = statSync(first).isDirectory();
  } catch {
    // not a directory → part of the query (unless path-shaped, checked below)
  }
  if (words.length >= 2 && (isDir || looksLikePath(first))) {
    return { root: existingDir(first), query: words.slice(1).join(" ") };
  }
  return { root: existingDir("."), query: words.join(" ") };
}

export function handleWorkspaceMemory(rest: string[]): void {
  const [memorySub, ...memRest] = rest;

  // The dispatcher only routes `context` / `search` here.
  if (memorySub !== "context" && memorySub !== "search") {
    usageError(`unknown sub-command '${memorySub ?? ""}'`, "workspace memory");
  }

  const { root, query } =
    memorySub === "search"
      ? workspaceDirThenQuery(memRest)
      : { root: workspaceRoot("workspace memory context", memRest), query: "" };
  const { store, close } = openWorkspaceMemoryRepo(root);
  try {
    if (memorySub === "search") {
      runWorkspaceMemorySearch(store, query);
    } else {
      runWorkspaceMemoryContext(store);
    }
  } finally {
    close();
  }
}
