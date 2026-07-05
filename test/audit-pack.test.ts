// audit-pack.test.ts — unit tests for buildPack (legacy) and buildAuditPack (v3, R4).
// Covers: no-entry baseline, with entryIds, per-repo reachability, cross edges,
//         R4: schemaVersion=3, findings length, pruned findings excluded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { buildPack, buildAuditPack } from "../src/application/audit/pack.ts";
import { SyntheticSinkOverlay } from "../src/application/audit/reachability.ts";
import type { AuditPath } from "../src/application/audit/reachability.ts";
import type { Finding } from "../src/domain/findings/model.ts";
import type { GraphNode, GraphEdge } from "../src/domain/graph/model.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "audit-pack-"));
}

function node(id: string, repo?: string): GraphNode {
  return { id, label: id, fileType: "code", kind: "function", sourceFile: "src/x.ts", ...(repo ? { repo } : {}) };
}

function edge(source: string, target: string, repo?: string): GraphEdge {
  return { source, target, relation: "calls", confidence: "EXTRACTED", sourceFile: "src/x.ts", weight: 1, ...(repo ? { repo } : {}) };
}

// ---------------------------------------------------------------------------
// No entry points → reachability is null
// ---------------------------------------------------------------------------

test("(pack-1) no entryIds → overall reachability null", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([node("a"), node("b")]);
      store.addEdges([edge("a", "b")]);
      const pack = buildPack(store);
      assert.equal(pack.overallReachability, null);
      assert.ok(pack.builtAt > 0);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// With entryIds → overall reachability populated
// ---------------------------------------------------------------------------

test("(pack-2) with entryIds → overall reachability populated", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([node("a"), node("b"), node("c")]);
      store.addEdges([edge("a", "b")]);
      const pack = buildPack(store, { entryIds: ["a"] });
      assert.ok(pack.overallReachability !== null);
      assert.ok(pack.overallReachability.reachable.has("a"));
      assert.ok(pack.overallReachability.reachable.has("b"));
      assert.ok(pack.overallReachability.unreachable.has("c"));
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Per-repo reachability
// ---------------------------------------------------------------------------

test("(pack-3) per-repo reachability populated via repoEntryIds", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([
        node("svc-a::fn1", "svc-a"),
        node("svc-a::fn2", "svc-a"),
        node("svc-a::fn3", "svc-a"),
      ]);
      store.addEdges([edge("svc-a::fn1", "svc-a::fn2", "svc-a")]);
      const pack = buildPack(store, {
        repoEntryIds: { "svc-a": ["svc-a::fn1"] },
      });
      const repoReport = pack.repos.find((r) => r.repoKey === "svc-a")!;
      assert.ok(repoReport, "svc-a repo report must exist");
      assert.ok(repoReport.reachability !== null, "reachability must be populated");
      assert.ok(repoReport.reachability.reachable.has("svc-a::fn1"));
      assert.ok(repoReport.reachability.reachable.has("svc-a::fn2"));
      assert.ok(repoReport.reachability.unreachable.has("svc-a::fn3"));
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Cross-repo edges counted
// ---------------------------------------------------------------------------

test("(pack-4) crossEdgeCount reflects cross-repo edges", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([node("svc-a::fn1", "svc-a"), node("svc-b::fn2", "svc-b")]);
      store.addEdges([edge("svc-a::fn1", "svc-b::fn2", "svc-a")]);
      const pack = buildPack(store);
      assert.equal(pack.crossEdgeCount, 1);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Empty graph
// ---------------------------------------------------------------------------

test("(pack-5) empty graph → sensible zero counts", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      const pack = buildPack(store);
      assert.equal(pack.catalog.totalNodes, 0);
      assert.equal(pack.catalog.totalEdges, 0);
      assert.equal(pack.crossEdgeCount, 0);
      assert.equal(pack.overallReachability, null);
      assert.equal(pack.repos.length, 0);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// R4: buildAuditPack returns schemaVersion 3 + findings
// ---------------------------------------------------------------------------

function makeFinding(id: string): Finding {
  return {
    id,
    type: "taint-flow",
    severity: "LOW",
    title: `taint-flow: src → sink`,
    description: "test",
    evidence: {
      sourceNodeId: "src",
      sinkNodeId: "sink",
      steps: [{ from: "src", to: "sink", relation: "calls", confidence: "INFERRED" }],
      reposTraversed: [],
    },
    relatedNodes: [],
    suggestedActions: ["Review the flow."],
    confidence: "INFERRED",
    source: "audit.run",
    createdAt: 0,
  };
}

function makeAuditPath(source: string, sink: string): AuditPath {
  return {
    source,
    sink,
    steps: [{ from: source, to: sink, relation: "calls", confidence: "INFERRED" }],
    minConfidence: "INFERRED",
    reposTraversed: [],
  };
}

test("(pack-r4-1) buildAuditPack schemaVersion is 3", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([
        { id: "src", label: "src", fileType: "code", kind: "function", sourceFile: "src/x.ts" },
        { id: "sink", label: "sink", fileType: "code", kind: "function", sourceFile: "src/x.ts" },
      ]);
      const overlay = new SyntheticSinkOverlay(store, []);
      const paths = [makeAuditPath("src", "sink")];
      const findings = [makeFinding("id1")];
      const pack = buildAuditPack(paths, overlay, findings);
      assert.equal(pack.schemaVersion, 3, "schemaVersion must be 3");
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(pack-r4-2) buildAuditPack findings.length equals included paths count", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      store.addNodes([
        { id: "s1", label: "s1", fileType: "code", kind: "function", sourceFile: "x.ts" },
        { id: "s2", label: "s2", fileType: "code", kind: "function", sourceFile: "x.ts" },
        { id: "s3", label: "s3", fileType: "code", kind: "function", sourceFile: "x.ts" },
        { id: "t",  label: "t",  fileType: "code", kind: "function", sourceFile: "x.ts" },
      ]);
      const overlay = new SyntheticSinkOverlay(store, []);
      const paths = [
        makeAuditPath("s1", "t"),
        makeAuditPath("s2", "t"),
        makeAuditPath("s3", "t"),
      ];
      const findings = [makeFinding("f1"), makeFinding("f2"), makeFinding("f3")];
      const pack = buildAuditPack(paths, overlay, findings);
      assert.equal(pack.paths.length, 3, "3 paths must be included");
      assert.equal(pack.findings.length, 3, "3 findings (one per included path)");
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(pack-r4-3) pruned path finding is excluded from pack.findings", () => {
  const dir = tmpDir();
  try {
    const store = new GraphStore(join(dir, "g.db"));
    try {
      // Use a very tiny maxBytes so the second path gets pruned
      store.addNodes([
        { id: "s1", label: "s1".repeat(100), fileType: "code", kind: "function", sourceFile: "x.ts" },
        { id: "s2", label: "s2".repeat(100), fileType: "code", kind: "function", sourceFile: "x.ts" },
        { id: "t",  label: "t",              fileType: "code", kind: "function", sourceFile: "x.ts" },
      ]);
      const overlay = new SyntheticSinkOverlay(store, []);
      const paths = [makeAuditPath("s1", "t"), makeAuditPath("s2", "t")];
      const findings = [makeFinding("f1"), makeFinding("f2")];
      // Use a very small limit to force pruning
      const pack = buildAuditPack(paths, overlay, findings, 100);
      // At least one path must be pruned
      assert.ok(pack.prunedPaths > 0, "at least 1 path must be pruned");
      assert.equal(pack.paths.length + pack.prunedPaths, 2, "total paths = included + pruned");
      assert.equal(pack.findings.length, pack.paths.length, "findings count must equal included paths");
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
