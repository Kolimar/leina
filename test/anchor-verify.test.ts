// anchor-verify.test.ts — unit tests for src/memory/anchor-verify.ts
// Run: node --no-warnings --experimental-strip-types --test test/anchor-verify.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import type { GraphNode } from "../src/domain/graph/model.ts";
import { writeManifest } from "../src/application/graph/manifest.ts";
import {
  makeResolveAnchor,
  makeVerifyNode,
  sha256File,
} from "../src/application/memory/anchor-verify.ts";

function node(id: string, label: string, sourceFile: string): GraphNode {
  return { id, label, fileType: "code", sourceFile, kind: "function" };
}

function hashOf(content: string): string {
  return createHash("sha256").update(Buffer.from(content)).digest("hex");
}

// ---------------------------------------------------------------------------
// sha256File
// ---------------------------------------------------------------------------

test("sha256File: returns hex hash of file content", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-"));
  try {
    const f = join(dir, "a.ts");
    writeFileSync(f, "hello");
    assert.equal(sha256File(f), hashOf("hello"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sha256File: returns null for a missing file", () => {
  assert.equal(sha256File(join(tmpdir(), "definitely-missing-xyz.ts")), null);
});

// ---------------------------------------------------------------------------
// makeResolveAnchor
// ---------------------------------------------------------------------------

test("resolveAnchor: maps a label to node ids and stamps the manifest hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-"));
  try {
    writeFileSync(join(dir, "a.ts"), "export function compute() {}\n");
    const store = new GraphStore(join(dir, "graph.db"));
    store.addNodes([node("a:compute", "compute", "a.ts")]);
    // Stamp a manifest so the resolver can read the build-time hash for a.ts.
    writeManifest(dir, [join(dir, "a.ts")]);

    const resolve = makeResolveAnchor({ getStore: () => store, root: dir });
    const anchors = resolve("compute");
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.nodeId, "a:compute");
    assert.equal(anchors[0]!.sourceFile, "a.ts");
    assert.equal(typeof anchors[0]!.fileHash, "string");
    assert.equal(anchors[0]!.fileHash!.length, 64);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAnchor: only functional-exact matches are kept (no fuzzy substring)", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-"));
  try {
    const store = new GraphStore(join(dir, "graph.db"));
    store.addNodes([
      node("a:compute", "compute", "a.ts"),
      node("b:computeTotal", "computeTotal", "b.ts"),
    ]);
    const resolve = makeResolveAnchor({ getStore: () => store, root: dir });
    const anchors = resolve("compute");
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.nodeId, "a:compute");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAnchor: no manifest → anchor omits fileHash", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-"));
  try {
    const store = new GraphStore(join(dir, "graph.db"));
    store.addNodes([node("a:compute", "compute", "a.ts")]);
    const resolve = makeResolveAnchor({ getStore: () => store, root: dir });
    const anchors = resolve("compute");
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.fileHash, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAnchor: getStore throwing → returns [] (fail-open)", () => {
  const resolve = makeResolveAnchor({
    getStore: () => {
      throw new Error("no graph yet");
    },
    root: tmpdir(),
  });
  assert.deepEqual(resolve("anything"), []);
});

// ---------------------------------------------------------------------------
// makeVerifyNode
// ---------------------------------------------------------------------------

test("verifyNode: existing node → exists with current working-tree hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-"));
  try {
    writeFileSync(join(dir, "a.ts"), "current content");
    const store = new GraphStore(join(dir, "graph.db"));
    store.addNodes([node("a:compute", "compute", "a.ts")]);
    const verify = makeVerifyNode({ getStore: () => store, root: dir });
    const r = verify("a:compute");
    assert.equal(r.exists, true);
    assert.equal(r.currentHash, hashOf("current content"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyNode: missing node → exists false, null hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-"));
  try {
    const store = new GraphStore(join(dir, "graph.db"));
    const verify = makeVerifyNode({ getStore: () => store, root: dir });
    const r = verify("nope");
    assert.equal(r.exists, false);
    assert.equal(r.currentHash, null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyNode: node exists but source file missing → null hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-"));
  try {
    const store = new GraphStore(join(dir, "graph.db"));
    store.addNodes([node("a:gone", "gone", "gone.ts")]); // file never written
    const verify = makeVerifyNode({ getStore: () => store, root: dir });
    const r = verify("a:gone");
    assert.equal(r.exists, true);
    assert.equal(r.currentHash, null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyNode: getStore throwing → surfaces error, exists false", () => {
  const verify = makeVerifyNode({
    getStore: () => {
      throw new Error("db boom");
    },
    root: tmpdir(),
  });
  const r = verify("x");
  assert.equal(r.exists, false);
  assert.equal(r.currentHash, null);
  assert.match(r.error ?? "", /db boom/);
});
