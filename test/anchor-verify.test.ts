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
  makeUpgradeAnchor,
  makeVerifyNode,
  sha256File,
  symbolFingerprint,
} from "../src/application/memory/anchor-verify.ts";
import { isSymbolFingerprint } from "../src/domain/memory/symbol-span.ts";

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

test("resolveAnchor: maps a label to node ids and stamps the working-tree file hash (no span)", () => {
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
    // The node has no start line → file-level baseline, from the working tree (what the
    // verifier compares against), not the manifest.
    assert.equal(anchors[0]!.anchorHash, hashOf("export function compute() {}\n"));

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

test("resolveAnchor: unreadable file and no manifest → anchor omits anchorHash", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-"));
  try {
    const store = new GraphStore(join(dir, "graph.db"));
    store.addNodes([node("a:compute", "compute", "a.ts")]);
    const resolve = makeResolveAnchor({ getStore: () => store, root: dir });
    const anchors = resolve("compute");
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0]!.anchorHash, undefined);
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

// ---------------------------------------------------------------------------
// Symbol-level fingerprints (3.0): drift is the anchored symbol's own lines
// ---------------------------------------------------------------------------

const TWO_FNS = [
  "export function alpha(): number {", // L1
  "  return 1;",
  "}",
  "",
  "export function beta(): number {", // L5
  "  return 2;",
  "}",
  "",
].join("\n");

function located(id: string, label: string, sourceFile: string, line: number): GraphNode {
  return { id, label, fileType: "code", sourceFile, sourceLocation: `L${line}`, kind: "function" };
}

function withTwoFns(fn: (ctx: { dir: string; store: GraphStore }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anchor-sym-"));
  const store = new GraphStore(join(dir, "graph.db"));
  try {
    writeFileSync(join(dir, "a.ts"), TWO_FNS);
    store.addNodes([located("a:alpha", "alpha()", "a.ts", 1), located("a:beta", "beta()", "a.ts", 5)]);
    fn({ dir, store });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(av-sym-1) resolveAnchor stamps a sym1 fingerprint the verifier reproduces", () => {
  withTwoFns(({ dir, store }) => {
    const [anchor] = makeResolveAnchor({ getStore: () => store, root: dir })("alpha");
    assert.ok(anchor?.anchorHash !== undefined && isSymbolFingerprint(anchor.anchorHash));
    assert.equal(anchor.anchorHash, symbolFingerprint(TWO_FNS, located("a:alpha", "alpha()", "a.ts", 1)));
    const v = makeVerifyNode({ getStore: () => store, root: dir })("a:alpha");
    assert.equal(v.symbolHash, anchor.anchorHash);
    assert.equal(v.currentHash, hashOf(TWO_FNS));
  });
});

test("(av-sym-2) an edit to another symbol of the file keeps the fingerprint; an edit to it changes it", () => {
  withTwoFns(({ dir, store }) => {
    const verify = makeVerifyNode({ getStore: () => store, root: dir });
    const before = verify("a:alpha").symbolHash;
    writeFileSync(join(dir, "a.ts"), TWO_FNS.replace("return 2;", "return 22;"));
    const otherEdited = verify("a:alpha");
    assert.equal(otherEdited.symbolHash, before, "beta changed, alpha did not");
    assert.notEqual(otherEdited.currentHash, hashOf(TWO_FNS), "the whole-file hash did change");
    writeFileSync(join(dir, "a.ts"), TWO_FNS.replace("return 1;", "return 11;"));
    assert.notEqual(verify("a:alpha").symbolHash, before);
    // Lines inserted above shift the symbol; the fingerprint follows it (graph not rebuilt).
    writeFileSync(join(dir, "a.ts"), `// header\n// more\n${TWO_FNS}`);
    assert.equal(verify("a:alpha").symbolHash, before);
  });
});

test("(av-sym-3) symbolHash is null when the symbol can no longer be found in its file", () => {
  withTwoFns(({ dir, store }) => {
    writeFileSync(join(dir, "a.ts"), "export const unrelated = 1;\n");
    const v = makeVerifyNode({ getStore: () => store, root: dir })("a:alpha");
    assert.equal(v.exists, true);
    assert.equal(v.symbolHash, null);
  });
});

test("(av-sym-4) unreadable file → the build manifest hash is the fallback baseline", () => {
  const dir = mkdtempSync(join(tmpdir(), "anchor-sym-"));
  const store = new GraphStore(join(dir, "graph.db"));
  try {
    writeFileSync(join(dir, "a.ts"), TWO_FNS);
    writeManifest(dir, [join(dir, "a.ts")]);
    rmSync(join(dir, "a.ts"));
    store.addNodes([located("a:alpha", "alpha()", "a.ts", 1)]);
    const [anchor] = makeResolveAnchor({ getStore: () => store, root: dir })("alpha");
    assert.equal(anchor?.anchorHash, hashOf(TWO_FNS));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(av-up-1) upgrade: an unchanged file upgrades to the current fingerprint", () => {
  withTwoFns(({ dir, store }) => {
    const upgrade = makeUpgradeAnchor({ getStore: () => store, root: dir });
    const current = makeVerifyNode({ getStore: () => store, root: dir })("a:alpha").symbolHash;
    assert.equal(upgrade({ nodeId: "a:alpha", anchorHash: hashOf(TWO_FNS) }), current);
  });
});

test("(av-up-2) upgrade: a changed file is fingerprinted in the SAVED version, found via history", () => {
  withTwoFns(({ dir, store }) => {
    const saved = TWO_FNS;
    const asked: string[] = [];
    const history = (rel: string, sha: string): string | null => {
      asked.push(rel);
      return sha === hashOf(saved) ? saved : null;
    };
    const upgrade = makeUpgradeAnchor({ getStore: () => store, root: dir, history });
    const verify = makeVerifyNode({ getStore: () => store, root: dir });

    // Only beta changed since the save: alpha's upgraded anchor verifies as unchanged.
    writeFileSync(join(dir, "a.ts"), saved.replace("return 2;", "return 22;"));
    assert.equal(upgrade({ nodeId: "a:alpha", anchorHash: hashOf(saved) }), verify("a:alpha").symbolHash);
    assert.deepEqual(asked, ["a.ts"]);

    // alpha itself changed: the upgraded baseline stays the saved one, so it reads as drift.
    writeFileSync(join(dir, "a.ts"), saved.replace("return 1;", "return 11;"));
    const fp = upgrade({ nodeId: "a:alpha", anchorHash: hashOf(saved) });
    assert.ok(fp !== null && isSymbolFingerprint(fp));
    assert.notEqual(fp, verify("a:alpha").symbolHash);
  });
});

test("(av-up-3) upgrade: no saved version, not file-level, gone node or no span → null", () => {
  withTwoFns(({ dir, store }) => {
    store.addNodes([{ id: "a_ts", label: "a.ts", fileType: "code", sourceFile: "a.ts", kind: "module" }]);
    const upgrade = makeUpgradeAnchor({ getStore: () => store, root: dir, history: () => null });
    assert.equal(upgrade({ nodeId: "a:alpha", anchorHash: hashOf("some older content") }), null);
    assert.equal(upgrade({ nodeId: "a:alpha", anchorHash: `sym1:${"0".repeat(64)}` }), null);
    assert.equal(upgrade({ nodeId: "a:alpha" }), null);
    assert.equal(upgrade({ nodeId: "a:gone", anchorHash: hashOf(TWO_FNS) }), null);
    assert.equal(upgrade({ nodeId: "a_ts", anchorHash: hashOf(TWO_FNS) }), null, "a module anchor stays file-level");
  });
});
