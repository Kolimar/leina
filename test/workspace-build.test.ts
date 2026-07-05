// workspace-build.test.ts — integration tests for buildWorkspace
// SC-08: fresh repo reused; stale repo rebuilt.
// Uses tmpdir with minimal synthetic repos (no real extractor needed for the
// reuse/rebuild logic — we just check whether the merged store contains the
// expected namespaced nodes).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { buildWorkspace } from "../src/application/workspace/build.ts";
import { writeManifest } from "../src/application/graph/manifest.ts";
import { listSourceFiles } from "../src/application/graph/sources.ts";
import { TreesitterExtractor } from "../src/infrastructure/extractors/treesitter.ts";
import type { WorkspaceMember } from "../src/application/project/detect-key.ts";
import type { GraphNode } from "../src/domain/graph/model.ts";

// Registry mínimo para tests de orquestación (sin tsmorph ni sidecars pesados)
const minimalRegistry = [new TreesitterExtractor("test")];

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ws-build-"));
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
}

function writeSourceFile(dir: string, filename: string, content: string): void {
  const fullPath = join(dir, filename);
  mkdirSync(join(dir, filename.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

// Build a fake per-repo graph.db pre-populated with nodes so buildWorkspace
// can import them without running the real extractor.
function makeFakePerRepoStore(repoDir: string, nodes: GraphNode[]): void {
  const dbDir = join(repoDir, ".leina");
  mkdirSync(dbDir, { recursive: true });
  const store = new GraphStore(join(dbDir, "graph.db"));
  try {
    store.addNodes(nodes);
  } finally {
    store.close();
  }
  // Write a manifest that captures all current source files so the repo is treated as fresh.
  const currentFiles = listSourceFiles(repoDir);
  writeManifest(repoDir, currentFiles);
}

// ---------------------------------------------------------------------------
// SC-08: fresh repo reused, stale repo triggers build
// ---------------------------------------------------------------------------

test("(SC-08) fresh member reused; stale member rebuilt — merged graph reflects both", async () => {
  const root = tmpDir();
  try {
    const repoA = join(root, "service-a");
    const repoB = join(root, "service-b");
    initGitRepo(repoA);
    initGitRepo(repoB);

    // repo-a: has a pre-built graph.db with a fresh manifest → should be reused
    writeSourceFile(repoA, "src/foo.ts", "export function foo() {}");
    makeFakePerRepoStore(repoA, [
      { id: "src_foo_ts:foo", label: "foo()", fileType: "code", kind: "function", sourceFile: "src/foo.ts" },
    ]);

    // repo-b: has no graph.db → isStale returns stale → will be rebuilt
    // We write a .ts file so the extractor has something to process.
    writeSourceFile(repoB, "src/bar.ts", "export function bar() {}");

    const mergedDbPath = join(root, ".leina", "graph.db");
    mkdirSync(join(root, ".leina"), { recursive: true });
    const mergedStore = new GraphStore(mergedDbPath);

    const members: WorkspaceMember[] = [
      { dir: repoA, repoKey: "service-a" },
      { dir: repoB, repoKey: "service-b" },
    ];

    try {
      const report = await buildWorkspace(root, members, mergedStore, minimalRegistry);

      // repo-a was fresh → reused
      assert.equal(report.membersReused, 1, "service-a should be reused");
      // repo-b was stale → rebuilt
      assert.equal(report.membersRebuilt, 1, "service-b should be rebuilt");
      assert.equal(report.membersTotal, 2);

      // The merged store must contain the namespaced node from repo-a
      const nodeA = mergedStore.getNode("service-a::src_foo_ts:foo");
      assert.ok(nodeA, "repo-a's node must appear in merged store with namespace");
      assert.equal(nodeA.repo, "service-a");

      // repo-b's graph must also exist in merged (was built + imported)
      const allNodes = mergedStore.allNodes();
      const serviceB = allNodes.filter((n) => n.repo === "service-b");
      assert.ok(serviceB.length > 0, "repo-b must have nodes in merged store");

    } finally {
      mergedStore.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Empty members list
// ---------------------------------------------------------------------------

test("(ws-build-empty) empty members list → empty merged graph, no errors", async () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, ".leina"), { recursive: true });
    const mergedStore = new GraphStore(join(root, ".leina", "graph.db"));
    try {
      const report = await buildWorkspace(root, [], mergedStore, minimalRegistry);
      assert.equal(report.membersTotal, 0);
      assert.equal(report.membersReused, 0);
      assert.equal(report.membersRebuilt, 0);
      assert.deepEqual(report.errors, {});
      assert.equal(mergedStore.allNodes().length, 0);
    } finally {
      mergedStore.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
