// cli/handlers/audit.ts — audit command handlers
// Commands:
//   leina audit [dir] [--from <id,...>] [--json] [--format md|json|html] [--max-pack-kb <N>]
//     → Full audit: source/sink catalog + M:N reachability + pack written to disk
//     → --format md|json  → write to stdout; --format html → write audit-graph.html
//     → --json is an alias for --format json (backward compat)
//
//   leina audit catalog [dir] [--json]
//   leina audit reachability [dir] --from <id,...> [--backward] [--json]
//   leina audit pack [dir] [--from <id,...>] [--json] [--max-pack-kb <N>]
//   leina audit visualize [dir] [--from <id,...>] [--out <path>] [--max-pack-kb <N>]
//     → Render the audit subgraph (source→sink candidate paths) as an offline HTML viewer
//
// NFR-08: All audit output includes the disclaimer.
// CRIT-6: pack subcommand writes audit-pack.json to disk.
// WARN-1/2: `audit [dir]` is the top-level command (FR-17); disclaimer on all output.

import { resolve as resolvePath, join, dirname, basename } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { graphDbPath, openGraphRepo, openEventSink } from "../wiring.ts";
import { makeLeinaEvent } from "../../domain/events/model.ts";
import { emitEvent } from "../../application/events/emit.ts";
import { buildCatalog } from "../../application/audit/catalog.ts";
import { auditReachability, makeSyntheticSinkNodes } from "../../application/audit/reachability.ts";
import { buildPack, writeAuditPack, AUDIT_DISCLAIMER } from "../../application/audit/pack.ts";
import { buildSourceSinkCatalog } from "../../application/audit/source-sink-catalog.ts";
import { runAudit } from "../../application/audit/run.ts";
import { renderAuditHtml } from "../../application/audit/audit-html-export.ts";
import { MarkdownRenderer } from "../../application/render/markdown-renderer.ts";
import { JsonRenderer } from "../../application/render/json-renderer.ts";
import { HtmlRenderer } from "../../application/render/html-renderer.ts";
import { entryAssetsRootFrom } from "../../infrastructure/install/global.ts";
import { fail } from "../io.ts";

// ---------------------------------------------------------------------------
// --format parser
// ---------------------------------------------------------------------------

type AuditFormat = "md" | "json" | "html";

function parseFormat(rest: string[]): AuditFormat | undefined {
  // --json is an alias for --format json (backward compat)
  if (rest.includes("--json")) return "json";
  const idx = rest.indexOf("--format");
  if (idx >= 0 && idx + 1 < rest.length) {
    const val = rest[idx + 1];
    if (val === "md" || val === "json" || val === "html") return val;
  }
  return undefined;
}

function optFlagValue(rest: string[], flag: string): string | undefined {
  const idx = rest.indexOf(flag);
  return idx >= 0 && idx + 1 < rest.length ? rest[idx + 1] : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseEntryIds(rest: string[]): string[] {
  const fromIdx = rest.indexOf("--from");
  if (fromIdx < 0 || fromIdx + 1 >= rest.length) return [];
  return (rest[fromIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function parseMaxPackKb(rest: string[]): number {
  const idx = rest.indexOf("--max-pack-kb");
  if (idx >= 0 && idx + 1 < rest.length) {
    const val = Number(rest[idx + 1]);
    if (Number.isFinite(val) && val > 0) return val * 1024;
  }
  return 128 * 1024; // default 128 KB
}

function requireGraph(root: string): void {
  const p = graphDbPath(root);
  if (!existsSync(p)) {
    fail(`No graph at ${p}. Run: leina workspace build ${root} (or leina build ${root})`);
  }
}

function printDisclaimer(): void {
  process.stderr.write(`\n⚠  ${AUDIT_DISCLAIMER}\n\n`);
}

// ---------------------------------------------------------------------------
// `leina audit [dir]` — full audit run (WARN-2/FR-17)
// ---------------------------------------------------------------------------

/**
 * Full audit: build source/sink catalog → inject synthetic sinks → run M:N
 * reachability → build pack → write to disk. Prints disclaimer on every run.
 *
 * --format md|json|html  (--json is an alias for --format json)
 *   md/json → stdout; html → writes audit-graph.html to cwd
 *   (no --format → original UX text output)
 */
export async function handleAudit(rest: string[]): Promise<void> {
  const dir = rest.find((a) => !a.startsWith("--")) ?? ".";
  const format = parseFormat(rest);
  const resolved = resolvePath(dir);
  const maxBytes = parseMaxPackKb(rest);
  const explicitFromIds = parseEntryIds(rest);

  requireGraph(resolved);
  printDisclaimer();

  // Build a catalog for UX stats before delegating to runAudit.
  const store = openGraphRepo(resolved);
  try {
    const ssCatalog = buildSourceSinkCatalog(store);
    const syntheticSinks = makeSyntheticSinkNodes();

    // Delegate to the application use case (D3: store already open, injected).
    const pack = await runAudit(store, {
      fromIds: explicitFromIds.length > 0 ? explicitFromIds : undefined,
      maxBytes,
    });

    // Write pack to disk (CRIT-6).
    const outPath = writeAuditPack(resolved, pack);

    // Emit audit.completed event (AFTER writeAuditPack, BEFORE format branches — R6, task 3.4).
    await emitEvent(
      openEventSink(),
      makeLeinaEvent("audit.completed", {
        pathsFound: pack.paths.length,
        prunedPaths: pack.prunedPaths,
        findingsCount: pack.findings.length,
        reposInvolved: pack.reposInvolved,
        packVersion: 3,
      }),
    );

    if (format === "json") {
      const renderer = new JsonRenderer();
      const { content } = renderer.render(pack);
      console.log(content);
    } else if (format === "md") {
      const renderer = new MarkdownRenderer({ projectName: basename(resolved) });
      const { content } = renderer.render(pack);
      process.stdout.write(content);
    } else if (format === "html") {
      const assetsRoot = entryAssetsRootFrom(process.argv[1] ?? ".");
      const visPath = join(assetsRoot, "vis-network", "vis-network.min.js");
      if (!existsSync(visPath)) {
        fail(`vis-network not found at ${visPath}.\nRun: leina activate`);
      }
      const visJs = readFileSync(visPath, "utf8");
      const projectName = basename(resolved);
      const renderer = new HtmlRenderer(visJs, { projectName });
      const { path: htmlFile, content } = renderer.render(pack);
      const htmlOutPath = join(resolved, htmlFile);
      writeFileSync(htmlOutPath, content, "utf8");
      console.log(`Audit HTML written: ${htmlOutPath}`);
    } else {
      // Original UX text output (no --format)
      console.log(`Audit complete:`);
      console.log(`  sources found: ${ssCatalog.sources.length}`);
      console.log(`  sinks found:   ${ssCatalog.sinks.length} (+ ${syntheticSinks.length} synthetic)`);
      console.log(`  paths found:   ${pack.paths.length}`);
      if (pack.prunedPaths > 0) {
        console.log(`  paths pruned:  ${pack.prunedPaths} (size limit ${Math.round(maxBytes / 1024)} KB)`);
      }
      console.log(`  repos in pack: ${pack.reposInvolved.join(", ") || "(single-repo)"}`);
      console.log(`  pack written:  ${outPath}`);
      console.log(`  catalog version: ${ssCatalog.catalogVersion}`);
    }
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// `leina audit catalog [dir] [--json]`
// ---------------------------------------------------------------------------

export function handleAuditCatalog(rest: string[]): void {
  const dir = rest.find((a) => !a.startsWith("--")) ?? ".";
  const wantJson = rest.includes("--json");
  const resolved = resolvePath(dir);
  requireGraph(resolved);

  const store = openGraphRepo(resolved);
  try {
    const catalog = buildCatalog(store);
    // Also compute source/sink catalog (CRIT-3)
    const ssCatalog = buildSourceSinkCatalog(store);

    if (wantJson) {
      console.log(JSON.stringify({ ...catalog, sourceSinkCatalog: ssCatalog }, null, 2));
      return;
    }
    process.stderr.write(`⚠  ${AUDIT_DISCLAIMER}\n\n`);
    console.log(`Audit catalog (catalogVersion: ${ssCatalog.catalogVersion}):`);
    console.log(`  ${catalog.totalNodes} nodes, ${catalog.totalEdges} edges`);
    for (const r of catalog.repos) {
      const key = r.repoKey || "(single-repo)";
      console.log(`  [${key}]  ${r.nodes.length} nodes, ${r.edges.length} edges`);
    }
    if (catalog.crossEdges.length > 0) {
      console.log(`  cross-repo edges: ${catalog.crossEdges.length}`);
    }
    console.log(`  sources matched: ${ssCatalog.sources.length}`);
    console.log(`  sinks matched:   ${ssCatalog.sinks.length}`);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// `leina audit reachability [dir] --from <id,...> [--backward] [--json]`
// ---------------------------------------------------------------------------

export function handleAuditReachability(rest: string[]): void {
  const dir = rest.find((a) => !a.startsWith("--")) ?? ".";
  const wantJson = rest.includes("--json");
  const backward = rest.includes("--backward");
  const resolved = resolvePath(dir);
  const entryIds = parseEntryIds(rest);

  if (entryIds.length === 0) {
    fail("audit reachability requires --from <node-id,...>");
  }

  requireGraph(resolved);
  const store = openGraphRepo(resolved);
  try {
    const result = auditReachability(store, entryIds, backward ? "backward" : "forward");
    if (wantJson) {
      console.log(JSON.stringify({
        reachable: [...result.reachable],
        unreachable: [...result.unreachable],
        totalNodes: result.totalNodes,
        coveragePct: result.coveragePct,
      }, null, 2));
      return;
    }
    process.stderr.write(`⚠  ${AUDIT_DISCLAIMER}\n\n`);
    console.log(`Reachability from: ${entryIds.join(", ")}`);
    console.log(`  reachable: ${result.reachable.size}/${result.totalNodes} (${result.coveragePct}%)`);
    console.log(`  unreachable: ${result.unreachable.size}`);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// `leina audit pack [dir] [--from <id,...>] [--json] [--max-pack-kb <N>]`
// ---------------------------------------------------------------------------

export async function handleAuditPack(rest: string[]): Promise<void> {
  const dir = rest.find((a) => !a.startsWith("--")) ?? ".";
  const wantJson = rest.includes("--json");
  const resolved = resolvePath(dir);
  const maxBytes = parseMaxPackKb(rest);
  const explicitFromIds = parseEntryIds(rest);

  requireGraph(resolved);
  printDisclaimer();

  const store = openGraphRepo(resolved);
  try {
    // Delegate to the application use case (D3: store injected).
    const pack = await runAudit(store, {
      fromIds: explicitFromIds.length > 0 ? explicitFromIds : undefined,
      maxBytes,
    });

    // Write to disk
    const outPath = writeAuditPack(resolved, pack);

    if (wantJson) {
      console.log(JSON.stringify(pack, null, 2));
      return;
    }

    console.log(`Audit pack: ${pack.nodes.length} nodes, ${pack.edges.length} edges`);
    console.log(`  paths: ${pack.paths.length}${pack.prunedPaths > 0 ? ` (${pack.prunedPaths} pruned)` : ""}`);
    console.log(`  cross-repo repos: ${pack.reposInvolved.join(", ") || "(single-repo)"}`);
    console.log(`  written: ${outPath}`);

    // Also run legacy pack for the non-JSON summary display
    if (explicitFromIds.length > 0) {
      const legacyPack = buildPack(store, { entryIds: explicitFromIds });
      if (legacyPack.overallReachability) {
        console.log(`  overall coverage: ${legacyPack.overallReachability.coveragePct}%`);
      }
    }
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// `leina audit visualize [dir] [--from <id,...>] [--out <path>] [--max-pack-kb <N>]`
// ---------------------------------------------------------------------------

/**
 * Build the audit pack (same pipeline as `audit pack`) and render it as a
 * self-contained, offline HTML viewer focused on source→sink candidate paths.
 * Reads the current (possibly merged) graph.db — run `workspace build` first for
 * a fresh workspace-level graph. Prints the disclaimer on every run (NFR-08).
 */
export async function handleAuditVisualize(rest: string[]): Promise<void> {
  const dir = rest.find((a) => !a.startsWith("--")) ?? ".";
  const resolved = resolvePath(dir);
  const maxBytes = parseMaxPackKb(rest);
  const explicitFromIds = parseEntryIds(rest);

  const defaultOut = join(resolved, ".leina", "audit-graph.html");
  const outPath = resolvePath(optFlagValue(rest, "--out") ?? defaultOut);

  // Resolve vis-network asset (same anchor as the graph visualizer).
  const assetsRoot = entryAssetsRootFrom(process.argv[1] ?? ".");
  const visPath = join(assetsRoot, "vis-network", "vis-network.min.js");
  if (!existsSync(visPath)) {
    fail(`vis-network not found at ${visPath}.\nRun: leina activate`);
  }

  requireGraph(resolved);
  printDisclaimer();

  const store = openGraphRepo(resolved);
  try {
    // Delegate to the application use case (D3: store injected).
    const pack = await runAudit(store, {
      fromIds: explicitFromIds.length > 0 ? explicitFromIds : undefined,
      maxBytes,
    });

    const visJs = readFileSync(visPath, "utf8");
    const projectName = basename(resolved);
    const artifact = renderAuditHtml(pack, visJs, { projectName });

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, artifact.content, "utf8");

    console.log(
      `Exported audit-graph.html (${pack.paths.length} paths, ${pack.nodes.length} nodes, ${pack.edges.length} edges) -> ${outPath}`,
    );
    if (pack.paths.length === 0) {
      console.log(`  (no source→sink paths found — try --from <id> or rebuild the graph)`);
    }
  } finally {
    store.close();
  }
}
