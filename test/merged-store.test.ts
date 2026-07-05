// merged-store.test.ts — unit tests for importRepoIntoMerged
// Covers: SC-09 (no ID collision across repos), repo field populated,
// edge source/target rewritten correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { importRepoIntoMerged } from "../src/application/workspace/merged-store.ts";
import type { GraphNode, GraphEdge } from "../src/domain/graph/model.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "merged-store-"));
}

function makeNode(id: string, label: string, file: string): GraphNode {
  return { id, label, fileType: "code", kind: "function", sourceFile: file };
}

function makeEdge(source: string, target: string): GraphEdge {
  return { source, target, relation: "calls", confidence: "EXTRACTED", sourceFile: "auth.ts", weight: 1 };
}

// ---------------------------------------------------------------------------
// SC-09: no ID collision between repo-a and repo-b
// ---------------------------------------------------------------------------

test("(SC-09) two repos with same file+label get distinct namespaced IDs", () => {
  const dir = tmpDir();
  try {
    const storeA = new GraphStore(join(dir, "repo-a.db"));
    const storeB = new GraphStore(join(dir, "repo-b.db"));
    const merged = new GraphStore(join(dir, "merged.db"));
    try {
      // Both repos have src/auth.ts:buildToken
      storeA.addNodes([makeNode("src_auth_ts:buildtoken", "buildToken()", "src/auth.ts")]);
      storeB.addNodes([makeNode("src_auth_ts:buildtoken", "buildToken()", "src/auth.ts")]);

      importRepoIntoMerged(storeA, "repo-a", merged);
      importRepoIntoMerged(storeB, "repo-b", merged);

      const allNodes = merged.allNodes();
      const ids = allNodes.map((n) => n.id);

      // IDs must be namespaced and distinct
      assert.ok(ids.includes("repo-a::src_auth_ts:buildtoken"), `expected repo-a id; got: ${JSON.stringify(ids)}`);
      assert.ok(ids.includes("repo-b::src_auth_ts:buildtoken"), `expected repo-b id; got: ${JSON.stringify(ids)}`);
      assert.equal(ids.length, 2, "exactly 2 nodes — no collision");
    } finally {
      storeA.close(); storeB.close(); merged.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// repo field is populated
// ---------------------------------------------------------------------------

test("(merged-repo-field) imported nodes carry repo field", () => {
  const dir = tmpDir();
  try {
    const repo = new GraphStore(join(dir, "repo.db"));
    const merged = new GraphStore(join(dir, "merged.db"));
    try {
      repo.addNodes([makeNode("src_foo_ts:fn", "fn()", "src/foo.ts")]);
      importRepoIntoMerged(repo, "my-service", merged);

      const node = merged.getNode("my-service::src_foo_ts:fn");
      assert.ok(node, "namespaced node must exist");
      assert.equal(node.repo, "my-service");
    } finally {
      repo.close(); merged.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Edges are rewritten with namespaced source/target
// ---------------------------------------------------------------------------

test("(merged-edge-rewrite) edge source/target rewritten and repo field set", () => {
  const dir = tmpDir();
  try {
    const repo = new GraphStore(join(dir, "repo.db"));
    const merged = new GraphStore(join(dir, "merged.db"));
    try {
      repo.addNodes([
        makeNode("src_foo_ts:caller", "caller()", "src/foo.ts"),
        makeNode("src_bar_ts:callee", "callee()", "src/bar.ts"),
      ]);
      repo.addEdges([makeEdge("src_foo_ts:caller", "src_bar_ts:callee")]);
      importRepoIntoMerged(repo, "svc-x", merged);

      const edges = merged.outEdges("svc-x::src_foo_ts:caller");
      assert.equal(edges.length, 1);
      assert.equal(edges[0]!.source, "svc-x::src_foo_ts:caller");
      assert.equal(edges[0]!.target, "svc-x::src_bar_ts:callee");
      assert.equal(edges[0]!.repo, "svc-x");
    } finally {
      repo.close(); merged.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Empty repo import is a no-op
// ---------------------------------------------------------------------------

test("(merged-empty) empty repo import adds nothing to merged", () => {
  const dir = tmpDir();
  try {
    const repo = new GraphStore(join(dir, "empty.db"));
    const merged = new GraphStore(join(dir, "merged.db"));
    try {
      importRepoIntoMerged(repo, "empty-svc", merged);
      assert.equal(merged.allNodes().length, 0);
      assert.equal(merged.allEdges().length, 0);
    } finally {
      repo.close(); merged.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
