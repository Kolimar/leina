// cli/handlers/workspace.ts — workspace-level command handlers
// Commands:
//   leina workspace build [dir] [--json]
//   leina workspace status [dir]
//   leina workspace detect [dir]
//   leina workspace memory context [dir]    (CRIT-2: federated memory)
//   leina workspace memory search [dir] <query>

import { resolve as resolvePath, join } from "node:path";
import { writeFileSync } from "node:fs";
import { detectWorkspaceMode } from "../../application/project/detect-key.ts";
import { isStaleWorkspace } from "../../application/workspace/manifest.ts";
import { openWorkspaceFreshStore, openWorkspaceMemoryRepo } from "../wiring.ts";

/**
 * `leina workspace build [dir] [--json]`
 * Build all member repos and the merged store.
 */
export async function handleWorkspaceBuild(rest: string[]): Promise<void> {
  const dir = rest.find((a) => !a.startsWith("--")) ?? ".";
  const wantJson = rest.includes("--json");
  const resolved = resolvePath(dir);

  console.log(`leina workspace: building workspace at ${resolved} …`);

  const mergedStore = await openWorkspaceFreshStore(resolved, {});
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
  const dir = rest.find((a) => !a.startsWith("--")) ?? ".";
  const resolved = resolvePath(dir);

  const detection = detectWorkspaceMode(resolved, {});

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
  const dir = rest.find((a) => !a.startsWith("--")) ?? ".";
  const resolved = resolvePath(dir);

  const detection = detectWorkspaceMode(resolved, {
    single: rest.includes("--single"),
    workspace: rest.includes("--workspace"),
  });

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
function runWorkspaceMemorySearch(store: WorkspaceMemoryStore, dir: string, memRest: string[]): void {
  const query = memRest.filter((a) => a !== dir && !a.startsWith("--")).join(" ");
  if (!query) {
    process.stderr.write("Usage: leina workspace memory search [dir] <query>\n");
    process.exit(1);
  }
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

export function handleWorkspaceMemory(rest: string[]): void {
  const [memorySub, ...memRest] = rest;

  if (memorySub !== "context" && memorySub !== "search") {
    process.stderr.write(
      "Usage: leina workspace memory <context|search> [dir] [query]\n",
    );
    process.exit(1);
  }

  const dir = memRest.find((a) => !a.startsWith("--") && !a.startsWith("-")) ?? ".";
  const resolved = resolvePath(dir);
  const { store, close } = openWorkspaceMemoryRepo(resolved);
  try {
    if (memorySub === "search") {
      runWorkspaceMemorySearch(store, dir, memRest);
    } else {
      runWorkspaceMemoryContext(store);
    }
  } finally {
    close();
  }
}
