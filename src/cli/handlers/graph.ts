// cli/handlers/graph.ts — graph build/read command handlers.
// Each handler receives the argv tail (everything after the top-level command).

import { join, resolve as resolvePath } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { isStale, readManifest } from "../../application/graph/manifest.ts";
import { acquireForegroundBuildLock, buildLockPath } from "../background-build.ts";
import { loadFreshnessConfig } from "../../infrastructure/config/freshness.ts";
import { affected, queryGraph, resolveSeed, shortestPath } from "../../application/graph/query.ts";
import { openGraphRepo as openStore, openFreshStore, openEventSink, buildDefaultRegistry } from "../wiring.ts";
import { makeLeinaEvent } from "../../domain/events/model.ts";
import { emitEvent } from "../../application/events/emit.ts";
import { fail } from "../io.ts";
import { deriveProjectKey } from "../../application/project/detect-key.ts";
import { recordProject } from "../../infrastructure/config/project-registry-store.ts";


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

// Shared by handleBuild/handleRefresh: wait for (or reclaim) the foreground build lock;
// exit(1) with an actionable message if a live foreign holder never releases it in time.
function acquireLockOrFail(root: string): void {
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
    console.log(
      `Done. ${report.nodes} nodes, ${report.edges} edges from ` +
        `${report.filesExtracted}/${report.filesScanned} files.${ 
        report.semanticViaTreesitter
          ? `  (${report.semanticViaTreesitter} C#/Java files via tree-sitter; configure a sidecar for compiler-grade precision)`
          : ""}`,
    );
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
    console.log(
      `Done. ${report.nodes} nodes, ${report.edges} edges from ` +
        `${report.filesExtracted}/${report.filesScanned} files.`,
    );
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
  const root = rest[0] ?? ".";
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
  const store = openStore(rest[0] ?? ".");
  const s = store.stats();
  store.close();
  console.log(`nodes: ${s.nodes}`);
  console.log(`edges: ${s.edges}`);
  const total = s.edges || 1;
  for (const [k, v] of Object.entries(s.byConfidence)) {
    console.log(`  ${k}: ${v} (${Math.round((v / total) * 100)}%)`);
  }
}

export async function handleAffected(rest: string[]): Promise<void> {
  const root = rest[0] ?? fail("usage: affected <dir> <symbol|file> [depth]");
  const label = rest[1] ?? fail("usage: affected <dir> <symbol|file> [depth]");
  const depth = rest[2] ? Number(rest[2]) : 3;
  const store = await openFreshStore(root);
  const seed = resolveSeed(store, label);
  if (!seed) fail(`no node matches "${label}"`);
  const hits = affected(store, seed.id, depth);
  store.close();
  console.log(`Blast radius of ${seed.label} (${seed.sourceFile}):`);
  if (hits.length === 0) console.log("  (nothing depends on it)");
  for (const h of hits) {
    console.log(
      `  ${"  ".repeat(h.depth - 1)}${h.node.label}  [${h.viaRelation}]  ${h.node.sourceFile}:${h.node.sourceLocation ?? "?"}`,
    );
  }
}

export async function handlePath(rest: string[]): Promise<void> {
  const root = rest[0] ?? fail("usage: path <dir> <from> <to>");
  const store = await openFreshStore(root);
  const a = resolveSeed(store, rest[1] ?? fail("missing <from>"));
  const b = resolveSeed(store, rest[2] ?? fail("missing <to>"));
  if (!a || !b) fail("could not resolve endpoints");
  const steps = shortestPath(store, a.id, b.id);
  store.close();
  if (!steps) {
    console.log(`No path between ${a.label} and ${b.label}.`);
    return;
  }
  console.log(`${a.label}`);
  for (const s of steps) {
    console.log(`  --${s.relation}(${s.confidence})--> ${s.to.label}`);
  }
}

export async function handleQuery(rest: string[]): Promise<void> {
  const root = rest[0] ?? fail("usage: query <dir> <question>");
  const question = rest.slice(1).join(" ");
  const store = await openFreshStore(root);
  const res = queryGraph(store, question);
  store.close();
  console.log(`Seeds: ${res.seeds.map((s) => s.label).join(", ") || "(none)"}`);
  console.log(`Subgraph: ${res.nodes.length} nodes, ${res.edges.length} edges`);
  for (const e of res.edges) {
    const s = res.nodes.find((n) => n.id === e.source);
    const t = res.nodes.find((n) => n.id === e.target);
    if (s && t) console.log(`  ${s.label} --${e.relation}--> ${t.label}`);
  }
}
