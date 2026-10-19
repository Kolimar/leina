// cli/handlers/graph.ts — graph build/read command handlers.
// Each handler receives the argv tail (everything after the top-level command).

import { join, resolve as resolvePath } from "node:path";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { isStale, readManifest } from "../../application/graph/manifest.ts";
import { acquireForegroundBuildLock, buildLockPath } from "../background-build.ts";
import { loadFreshnessConfig } from "../../infrastructure/config/freshness.ts";
import { affected, queryGraph, shortestPath } from "../../application/graph/query.ts";
import { ambiguityNote, noMatchMessage, resolveSeedQuery } from "../../application/graph/seed.ts";
import { displayLabel, nodeAt } from "../../application/graph/present.ts";
import { compactQuery, type CompactQuery } from "../../application/graph/payloads.ts";
import type { GraphNode } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";
import { openGraphRepo as openStore, openFreshStore, openEventSink, buildDefaultRegistry, buildRootProblem } from "../wiring.ts";
import { makeLeinaEvent } from "../../domain/events/model.ts";
import { emitEvent } from "../../application/events/emit.ts";
import { fail } from "../io.ts";
import { deriveProjectKey } from "../../application/project/detect-key.ts";
import { pruneRegistry } from "../../application/project/registry.ts";
import {
  projectRegistryPath,
  readProjectRegistry,
  recordProject,
  writeProjectRegistry,
} from "../../infrastructure/config/project-registry-store.ts";


// `build --profile` — stage timings for deciding where incremental work pays off.
function printBuildProfile(t: import("../../application/graph/build.ts").BuildTimings): void {
  console.log(`\nbuild profile (${t.totalMs}ms total):`);
  console.log(`  list sources     ${String(t.listMs).padStart(6)}ms`);
  for (const e of t.extractors) {
    console.log(`  extract:${e.id.padEnd(10)}${String(e.ms).padStart(4)}ms  (${e.files} files)`);
  }
  console.log(`  resolve          ${String(t.resolveMs).padStart(6)}ms`);
  console.log(`  dedup            ${String(t.dedupMs).padStart(6)}ms`);
  console.log(`  persist          ${String(t.persistMs).padStart(6)}ms`);
  console.log(`  communities      ${String(t.communitiesMs).padStart(6)}ms`);
  console.log(`  manifest         ${String(t.manifestMs).padStart(6)}ms`);
}

// The closing summary of an explicit build/refresh: counts on stdout, then each reduced-
// precision path ONCE on stderr (extractors no longer print their own nudges).
function printBuildDone(report: import("../../application/graph/build.ts").BuildReport): void {
  console.log(
    `Done. ${report.nodes} nodes, ${report.edges} edges from ` +
      `${report.filesExtracted}/${report.filesScanned} files.`,
  );
  for (const note of report.degraded) console.error(`  note: ${note}`);
}

// Opportunistic upsert into the global project registry (~/.leina/projects.json), the
// data source for the `graph serve` project selector. Fail-open: project-key ambiguity
// or a registry write failure must never fail the build/refresh command itself.
function recordProjectBuild(root: string): void {
  try {
    const resolved = resolvePath(root);
    const projectKey = deriveProjectKey(resolved).key;
    recordProject({ projectKey, root: resolved, lastBuild: Date.now() });
  } catch {
    // best-effort bookkeeping only
  }
}

// Shared by handleBuild/handleRefresh: refuse a root that is not an existing directory
// (before anything is created or registered), then wait for (or reclaim) the foreground
// build lock; exit(1) with an actionable message if a live foreign holder never releases it.
function acquireLockOrFail(root: string): void {
  const problem = buildRootProblem(root);
  if (problem) fail(`leina: cannot build the graph: ${problem}`);
  const result = acquireForegroundBuildLock(root);
  if ("timeout" in result) {
    const ageMs = Date.now() - result.holderStartedAt;
    const ageS = Math.max(0, Math.round(ageMs / 1000));
    fail(
      `another build is running (pid ${result.holderPid}, started ${ageS}s ago) — ` +
        `wait for it to finish, retry, or delete ${buildLockPath(root)} if it is stuck.`,
    );
  }
}

export async function handleBuild(rest: string[]): Promise<void> {
  const root = rest[0] && !rest[0].startsWith("--") ? rest[0] : ".";
  const lockPath = buildLockPath(root);
  acquireLockOrFail(root);
  try {
    const { buildGraph } = await import("../../application/graph/build.ts");
    const store = openStore(root);
    const registry = await buildDefaultRegistry();
    console.log(`Building graph for ${resolvePath(root)} ...`);
    const report = await buildGraph(root, store, registry);
    if (rest.includes("--profile")) printBuildProfile(report.timings);
    if (rest.includes("--json")) {
      const out = join(resolvePath(root), ".leina", "graph.json");
      writeFileSync(out, JSON.stringify(store.toNodeLink(), null, 2));
      console.log(`  exported ${out}`);
    }
    store.close();
    printBuildDone(report);
    await emitEvent(
      openEventSink(),
      makeLeinaEvent("graph.built", {
        root: resolvePath(root),
        nodes: report.nodes,
        edges: report.edges,
        filesScanned: report.filesScanned,
        filesExtracted: report.filesExtracted,
      }),
    );
    recordProjectBuild(root);
  } finally {
    try { rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
  }
}

export async function handleRefresh(rest: string[]): Promise<void> {
  const root = rest[0] && !rest[0].startsWith("--") ? rest[0] : ".";
  const lockPath = buildLockPath(root);
  acquireLockOrFail(root);
  try {
    const { buildGraph } = await import("../../application/graph/build.ts");
    const registry = await buildDefaultRegistry();
    const store = openStore(root);
    console.log(`Rebuilding graph for ${resolvePath(root)} ...`);
    const report = await buildGraph(root, store, registry);
    store.close();
    printBuildDone(report);
    await emitEvent(
      openEventSink(),
      makeLeinaEvent("graph.built", {
        root: resolvePath(root),
        nodes: report.nodes,
        edges: report.edges,
        filesScanned: report.filesScanned,
        filesExtracted: report.filesExtracted,
      }),
    );
    recordProjectBuild(root);
  } finally {
    try { rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
  }
}

export function handleStatus(rest: string[]): void {
  const root = rest[0] && !rest[0].startsWith("--") ? rest[0] : ".";
  const s = isStale(root);
  const manifest = readManifest(root);
  const posture = loadFreshnessConfig(root);
  const built = manifest ? new Date(manifest.builtAt).toISOString() : "never";
  console.log(`status: ${s.stale ? "STALE" : "fresh"} (${s.reason})`);
  console.log(`posture: ${posture}`);
  console.log(`built: ${built}`);
  if (manifest) console.log(`tracked files: ${manifest.fileCount}`);
}

export function handleStats(rest: string[]): void {
  const root = rest[0] && !rest[0].startsWith("--") ? rest[0] : ".";
  const store = openStore(root);
  const s = store.stats();
  store.close();
  console.log(`nodes: ${s.nodes}`);
  console.log(`edges: ${s.edges}`);
  const total = s.edges || 1;
  for (const [k, v] of Object.entries(s.byConfidence)) {
    console.log(`  ${k}: ${v} (${Math.round((v / total) * 100)}%)`);
  }
}

// Resolve one CLI selector to its seed: no exact match → the did-you-mean message on
// stderr + exit 1; several exact matches → the ambiguity note on stderr, best one used.
function resolveOrFail(store: GraphRepository, selector: string): GraphNode {
  const res = resolveSeedQuery(store, selector);
  if (!res.seed) {
    store.close();
    fail(noMatchMessage(res));
  }
  const note = ambiguityNote(res);
  if (note) console.error(note);
  return res.seed;
}

export async function handleAffected(rest: string[]): Promise<void> {
  const root = rest[0] && !rest[0].startsWith("--") ? rest[0] : fail("usage: affected <dir> <symbol|file> [depth]");
  const label = rest[1] ?? fail("usage: affected <dir> <symbol|file> [depth]");
  const depth = rest[2] ? Number(rest[2]) : 3;
  const store = await openFreshStore(root);
  const seed = resolveOrFail(store, label);
  const hits = affected(store, seed.id, depth);
  // One line per dependent: its (owner-qualified) label, the relation, and WHERE the
  // dependency happens — the edge's call site, not the dependent's definition line.
  const lines = hits.map(
    (h) =>
      `  ${"  ".repeat(h.depth - 1)}${displayLabel(store, h.node)}  ` +
      `[${h.viaRelation}${h.via ? ` via ${displayLabel(store, h.via)}` : ""}]  ${h.site}`,
  );
  const title = `Blast radius of ${displayLabel(store, seed)} (${nodeAt(seed)}):`;
  store.close();
  console.log(title);
  if (hits.length === 0) console.log("  (nothing depends on it)");
  for (const line of lines) console.log(line);
}

export async function handlePath(rest: string[]): Promise<void> {
  const root = rest[0] && !rest[0].startsWith("--") ? rest[0] : fail("usage: path <dir> <from> <to>");
  const from = rest[1] ?? fail("usage: path <dir> <from> <to>");
  const to = rest[2] ?? fail("usage: path <dir> <from> <to>");
  const store = await openFreshStore(root);
  const a = resolveOrFail(store, from);
  const b = resolveOrFail(store, to);
  const steps = shortestPath(store, a.id, b.id);
  // The search is undirected, the arrows are not: `X <--calls-- Y` means Y calls X.
  const lines = (steps ?? []).map((st) => {
    const arrow = st.forward ? `--${st.relation}(${st.confidence})-->` : `<--${st.relation}(${st.confidence})--`;
    return `  ${arrow} ${displayLabel(store, st.to)}  ${st.site}`;
  });
  const [aLabel, bLabel] = [displayLabel(store, a), displayLabel(store, b)];
  store.close();
  if (!steps) {
    console.log(`No path between ${aLabel} and ${bLabel}.`);
    return;
  }
  console.log(`${aLabel}  (${nodeAt(a)})`);
  for (const line of lines) console.log(line);
}

// `graph gc` — housekeeping for the global project registry (~/.leina/projects.json).
// Reads normally filter out roots that have vanished (a deleted /tmp checkout, a moved
// repo), so stale entries are harmless — but they accumulate forever. This drops them for
// good. `--dry-run` reports what would be removed without rewriting; `--json` emits the
// same result as machine-readable output. Fail-open like every other registry operation.
export function handleGraphGc(rest: string[]): void {
  const dryRun = rest.includes("--dry-run");
  const asJson = rest.includes("--json");
  const { kept, removed } = pruneRegistry(readProjectRegistry(), existsSync);
  if (!dryRun && removed.length > 0) writeProjectRegistry(kept);

  if (asJson) {
    console.log(
      JSON.stringify(
        { path: projectRegistryPath(), dryRun, kept: kept.length, removed: removed.map((e) => e.root) },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`registry: ${projectRegistryPath()}`);
  if (removed.length === 0) {
    console.log(`Nothing to prune — all ${kept.length} registered root(s) still exist.`);
    return;
  }
  console.log(`${dryRun ? "Would remove" : "Removed"} ${removed.length} stale root(s), kept ${kept.length}:`);
  for (const e of removed) console.log(`  - ${e.root} (${e.projectKey})`);
  if (dryRun) console.log("(dry run — registry left unchanged)");
}

const QUERY_FLAGS = new Set(["--json", "--include-tests"]);

export async function handleQuery(rest: string[]): Promise<void> {
  const root = rest[0] && !rest[0].startsWith("--") ? rest[0] : fail("usage: query <dir> <question> [--json] [--include-tests]");
  // Flags are flags wherever they sit after <dir>, never part of the question.
  const asJson = rest.includes("--json");
  const includeTests = rest.includes("--include-tests");
  const question = rest.slice(1).filter((a) => !QUERY_FLAGS.has(a)).join(" ");
  const store = await openFreshStore(root);
  // The compact shape (payloads.ts) is both the --json contract (graphQueryOutputSchema,
  // identical to the MCP graph_query answer) and what the text output prints.
  const res = compactQuery(store, queryGraph(store, question, { includeTests }));
  store.close();
  if (asJson) process.stdout.write(`${JSON.stringify(res)}\n`);
  else printQueryText(res);
}

// Seeds, then every node with its kind and file:line, then the semantic edges with the
// file:line where each happens — enough to open the right file without a second query.
function printQueryText(res: CompactQuery): void {
  const byId = new Map(res.nodes.map((n) => [n.id, n]));
  const name = (id: string): string => byId.get(id)?.label ?? id;
  const seedIds = new Set(res.seeds);
  console.log(`Seeds: ${res.seeds.map((id) => `${name(id)} (${byId.get(id)?.at ?? "?"})`).join(", ") || "(none)"}`);
  const hint = res.testsExcluded ? " (test/mock/fixture nodes left out; --include-tests to add them)" : "";
  console.log(`Subgraph: ${res.nodes.length} nodes, ${res.edges.length} edges${hint}`);
  if (res.nodes.length === 0) return;
  console.log("Nodes:");
  for (const n of res.nodes) console.log(`  ${seedIds.has(n.id) ? "*" : " "} ${n.label}  ${n.kind}  ${n.at}`);
  if (res.edges.length === 0) return;
  console.log("Edges:");
  for (const e of res.edges) console.log(`  ${name(e.source)} --${e.relation}--> ${name(e.target)}  ${e.at}`);
}
