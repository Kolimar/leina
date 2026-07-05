// test/e2e-workspace-audit.test.ts
// E2E integration test for multi-repo workspace cross-linking and audit pack.
//
// Scenario: 2 repos in a temporary workspace.
//   repo-a: TypeScript library publishing "@acme/payments" that exports chargeCard().
//   repo-b: TypeScript service that imports "@acme/payments" and calls chargeCard().
//
// Assertions:
//   1. buildWorkspace creates ≥1 EXTRACTED cross-repo edge (source file scan).
//   2. buildAuditPack produces a pack with schemaVersion=2 and disclaimer.
//   3. Pack has ≥0 paths (source/sink catalog may or may not find matches in tiny fixture).
//   4. prunedPaths is a number (pruning infrastructure exists).
//   5. writeAuditPack writes audit-pack.json to disk with correct structure.
//
// The test deliberately does NOT assert on source→sink path count because the
// tiny fixture has no labels matching the built-in source/sink catalog.
// (The audit pipeline itself is integration-tested via unit tests in the catalog/
// reachability/pack test files.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { buildWorkspace } from "../src/application/workspace/build.ts";
import { buildAuditPack, writeAuditPack } from "../src/application/audit/pack.ts";
import { auditMNReachability, makeSyntheticSinkNodes, SyntheticSinkOverlay } from "../src/application/audit/reachability.ts";
import { buildSourceSinkCatalog } from "../src/application/audit/source-sink-catalog.ts";
import { deriveFindings } from "../src/application/audit/findings.ts";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { TsmorphExtractor } from "../src/infrastructure/extractors/semantic/tsmorph.ts";
import { TreesitterExtractor } from "../src/infrastructure/extractors/treesitter.ts";
import type { WorkspaceMember } from "../src/application/project/detect-key.ts";

// Registry para e2e: tsmorph (TypeScript semántico) + treesitter (fallback)
const e2eRegistry = [new TsmorphExtractor("test"), new TreesitterExtractor("test")];

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function createTmpWorkspace(): { wsRoot: string; cleanup: () => void } {
  const wsRoot = mkdtempSync(join(tmpdir(), "leina-e2e-ws-"));
  return {
    wsRoot,
    cleanup: () => {
      try { rmSync(wsRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

function initGitRepo(dir: string): void {
  try {
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  } catch {
    // git may not be available in all CI environments — silently skip
  }
}

// ---------------------------------------------------------------------------
// Test: workspace cross-repo linking (CRIT-1 e2e)
// ---------------------------------------------------------------------------

test("(e2e-ws-1) buildWorkspace creates cross-repo edges for file-scanned imports", async () => {
  const { wsRoot, cleanup } = createTmpWorkspace();
  try {
    // Create repo-a (the "payments" library)
    const repoADir = join(wsRoot, "repo-a");
    mkdirSync(join(repoADir, "src"), { recursive: true });
    initGitRepo(repoADir);

    // package.json: name = "@acme/payments"
    writeFileSync(join(repoADir, "package.json"), JSON.stringify({ name: "@acme/payments", version: "1.0.0" }), "utf8");

    // TypeScript source: export function chargeCard
    writeFileSync(join(repoADir, "src", "pay.ts"), [
      "export function chargeCard(amount: number): boolean {",
      "  return amount > 0;",
      "}",
    ].join("\n"), "utf8");

    // Create repo-b (the "gateway" service that imports @acme/payments)
    const repoBDir = join(wsRoot, "repo-b");
    mkdirSync(join(repoBDir, "src"), { recursive: true });
    initGitRepo(repoBDir);

    writeFileSync(join(repoBDir, "package.json"), JSON.stringify({ name: "@acme/gateway", version: "1.0.0" }), "utf8");

    writeFileSync(join(repoBDir, "src", "handler.ts"), [
      'import { chargeCard } from "@acme/payments";',
      "export function handler(amount: number): boolean {",
      "  return chargeCard(amount);",
      "}",
    ].join("\n"), "utf8");

    // workspace.json to tell leina this is a workspace
    writeFileSync(join(wsRoot, "workspace.json"), JSON.stringify({}), "utf8");

    // --- Prepare members (repoKey = normalized dir basename) ---
    const members: WorkspaceMember[] = [
      { dir: repoADir, repoKey: "repo-a" },
      { dir: repoBDir, repoKey: "repo-b" },
    ];

    // Ensure merged store dir
    const mergedDir = join(wsRoot, ".leina");
    mkdirSync(mergedDir, { recursive: true });
    const mergedDbPath = join(mergedDir, "graph.db");

    // --- Run buildWorkspace ---
    const mergedStore = new GraphStore(mergedDbPath);
    try {
      const report = await buildWorkspace(wsRoot, members, mergedStore, e2eRegistry);

      // Should have processed 2 members
      assert.equal(report.membersTotal, 2, "should process 2 member repos");

      // Cross edges: source file scan should detect the import of @acme/payments in repo-b
      assert.ok(
        report.crossEdges >= 1,
        `expected ≥1 cross-repo edge from source file scan, got ${report.crossEdges}`,
      );

      // Cross edges should be in the merged store
      const crossEdgesInStore = mergedStore.allEdges().filter(
        (e) => e.confidence === "EXTRACTED" || e.confidence === "INFERRED",
      );
      assert.ok(
        crossEdgesInStore.length >= 1,
        `expected ≥1 EXTRACTED/INFERRED edge in merged store, got ${crossEdgesInStore.length}`,
      );

      // The cross edge relation should be imports_from
      const importEdge = crossEdgesInStore.find((e) => e.relation === "imports_from");
      assert.ok(importEdge !== undefined, "expected an imports_from cross-repo edge");
    } finally {
      mergedStore.close();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test: audit pack with schemaVersion, disclaimer, paths structure (CRIT-6 e2e)
// ---------------------------------------------------------------------------

test("(e2e-audit-1) buildAuditPack produces schemaVersion=3 pack with disclaimer", async () => {
  const { wsRoot, cleanup } = createTmpWorkspace();
  try {
    // Minimal 2-repo workspace (same as above)
    const repoADir = join(wsRoot, "repo-a");
    const repoBDir = join(wsRoot, "repo-b");
    mkdirSync(join(repoADir, "src"), { recursive: true });
    mkdirSync(join(repoBDir, "src"), { recursive: true });
    initGitRepo(repoADir);
    initGitRepo(repoBDir);

    writeFileSync(join(repoADir, "package.json"), JSON.stringify({ name: "@acme/payments" }), "utf8");
    writeFileSync(join(repoADir, "src", "pay.ts"),
      "export function chargeCard(): boolean { return true; }\n", "utf8");

    writeFileSync(join(repoBDir, "package.json"), JSON.stringify({ name: "@acme/gateway" }), "utf8");
    writeFileSync(join(repoBDir, "src", "handler.ts"), [
      'import { chargeCard } from "@acme/payments";',
      "export function consumeMessage(payload: string): boolean {",
      "  return chargeCard();",
      "}",
    ].join("\n"), "utf8");

    const mergedDir = join(wsRoot, ".leina");
    mkdirSync(mergedDir, { recursive: true });

    const members: WorkspaceMember[] = [
      { dir: repoADir, repoKey: "repo-a" },
      { dir: repoBDir, repoKey: "repo-b" },
    ];

    const mergedStore = new GraphStore(join(mergedDir, "graph.db"));
    try {
      await buildWorkspace(wsRoot, members, mergedStore, e2eRegistry);

      // Source/sink catalog (may be empty for this tiny fixture)
      const ssCatalog = buildSourceSinkCatalog(mergedStore);

      // Create synthetic sink overlay
      const syntheticSinks = makeSyntheticSinkNodes();
      const overlay = new SyntheticSinkOverlay(mergedStore, syntheticSinks);

      const sourceIds = ssCatalog.sources.map((m) => m.node.id);
      const allSinkIds = [
        ...ssCatalog.sinks.map((m) => m.node.id),
        ...syntheticSinks.map((n) => n.id),
      ];

      // M:N reachability
      const paths = auditMNReachability(overlay, sourceIds, allSinkIds);

      // Derive findings before building pack (new pipeline step)
      const nodes = overlay.allNodes();
      const findings = deriveFindings(paths, ssCatalog, nodes);

      // Build pack
      const pack = buildAuditPack(paths, overlay, findings, 128 * 1024);

      // --- Assertions ---
      assert.equal(pack.schemaVersion, 3, "schemaVersion must be 3");
      assert.ok(typeof pack.disclaimer === "string", "disclaimer must be a string");
      assert.ok(pack.disclaimer.length > 0, "disclaimer must not be empty");
      assert.ok(pack.disclaimer.includes("CANDIDATE PATHS"), "disclaimer must mention CANDIDATE PATHS");
      assert.ok(typeof pack.builtAt === "number", "builtAt must be a number");
      assert.ok(Array.isArray(pack.paths), "paths must be an array");
      assert.ok(Array.isArray(pack.nodes), "nodes must be an array");
      assert.ok(Array.isArray(pack.edges), "edges must be an array");
      assert.ok(Array.isArray(pack.reposInvolved), "reposInvolved must be an array");
      assert.ok(typeof pack.prunedPaths === "number", "prunedPaths must be a number");
      assert.ok(Array.isArray(pack.findings), "findings must be an array");

      // --- Write to disk (CRIT-6) ---
      const outPath = writeAuditPack(wsRoot, pack);
      assert.ok(existsSync(outPath), `audit-pack.json should exist at ${outPath}`);

      const onDisk = JSON.parse(readFileSync(outPath, "utf8")) as typeof pack;
      assert.equal(onDisk.schemaVersion, 3, "on-disk schemaVersion must be 3");
      assert.ok(typeof onDisk.disclaimer === "string", "on-disk disclaimer must be a string");
    } finally {
      mergedStore.close();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test: synthetic sinks are present in overlay (CRIT-4 unit-like integration)
// ---------------------------------------------------------------------------

test("(e2e-synth-1) SyntheticSinkOverlay exposes synthetic sink nodes without persisting", async () => {
  const { wsRoot, cleanup } = createTmpWorkspace();
  try {
    const mergedDir = join(wsRoot, ".leina");
    mkdirSync(mergedDir, { recursive: true });

    const store = new GraphStore(join(mergedDir, "graph.db"));
    try {
      // Base store starts empty
      const baseNodeCount = store.allNodes().length;

      const syntheticSinks = makeSyntheticSinkNodes();
      assert.ok(syntheticSinks.length >= 1, "makeSyntheticSinkNodes must return ≥1 node");

      const overlay = new SyntheticSinkOverlay(store, syntheticSinks);

      // Overlay should expose synthetic nodes
      const overlayNodes = overlay.allNodes();
      assert.equal(
        overlayNodes.length,
        baseNodeCount + syntheticSinks.length,
        "overlay should expose base nodes + synthetic nodes",
      );

      // Verify: base store NOT modified
      const baseStoreNodeCount = store.allNodes().length;
      assert.equal(
        baseStoreNodeCount,
        baseNodeCount,
        "base store must NOT be modified by synthetic overlay",
      );

      // Read-only check
      assert.throws(
        () => overlay.clear(),
        /read-only/,
        "overlay.clear() must throw",
      );
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});
