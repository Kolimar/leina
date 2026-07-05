// test/findings.test.ts — tests for Finding domain model (R1) and deriveFindings (R3).
//
// R1: arch-rule — domain/findings/model.ts has no imports from app/cli/infra.
// R3: deriveFindings maps AuditPath[] to Finding[] (1:1) with correct type/severity/id/etc.
//
// All fixtures use clock: () => 0 for deterministic createdAt (R8).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { AuditPath } from "../src/application/audit/reachability.ts";
import type { SourceSinkCatalogResult } from "../src/application/audit/source-sink-catalog.ts";
import type { GraphNode } from "../src/domain/graph/model.ts";
import { deriveFindings } from "../src/application/audit/findings.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FIXED_CLOCK = () => 0;

function makeNode(id: string, label: string, repo?: string): GraphNode {
  return {
    id,
    label,
    fileType: "code",
    kind: "function",
    sourceFile: "src/x.ts",
    ...(repo ? { repo } : {}),
  };
}

function makeStep(from: string, to: string) {
  return { from, to, relation: "calls" as const, confidence: "INFERRED" as const };
}

function makePath(
  source: string,
  sink: string,
  steps = [makeStep(source, sink)],
  repos = ["repo-a"],
): AuditPath {
  return {
    source,
    sink,
    steps,
    minConfidence: "INFERRED",
    reposTraversed: repos,
  };
}

/** Minimal catalog with one sink matched by a given category */
function makeCatalog(sinkId: string, category: string): SourceSinkCatalogResult {
  return {
    catalogVersion: "1.0.0",
    sources: [],
    sinks: [
      {
        node: makeNode(sinkId, sinkId),
        pattern: {
          id: `test-sink-${category}`,
          role: "sink",
          category: category as any,
          languages: ["typescript"],
          description: `Test ${category} sink`,
          labelPatterns: [sinkId],
        },
        matchedOn: "label",
      },
    ],
  };
}

const EMPTY_CATALOG: SourceSinkCatalogResult = {
  catalogVersion: "1.0.0",
  sources: [],
  sinks: [],
};

// ---------------------------------------------------------------------------
// R1: arch-rule — domain module imports only from domain/
// ---------------------------------------------------------------------------

test("(findings-arch) domain/findings/model.ts has no imports from app/cli/infra", async () => {
  const { readFileSync } = await import("node:fs");
  // fileURLToPath, NOT URL.pathname — pathname yields "/D:/…" on Windows (ENOENT).
  const src = readFileSync(
    fileURLToPath(new URL("../src/domain/findings/model.ts", import.meta.url)),
    "utf8",
  );
  const importLines = src.split("\n").filter((l) => l.trim().startsWith("import"));
  for (const line of importLines) {
    assert.ok(
      !line.includes("application/") && !line.includes("cli/") && !line.includes("infra/"),
      `Forbidden import in domain/findings/model.ts: ${line}`,
    );
  }
});

// ---------------------------------------------------------------------------
// R3: mapeo eval → code-injection / HIGH
// ---------------------------------------------------------------------------

test("(findings-1) eval sink → type=code-injection, severity=HIGH", () => {
  const path = makePath("src-node", "sink-eval");
  const catalog = makeCatalog("sink-eval", "eval");
  const nodes = [makeNode("src-node", "handleRequest"), makeNode("sink-eval", "evalCode")];

  const findings = deriveFindings([path], catalog, nodes, FIXED_CLOCK);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.type, "code-injection");
  assert.equal(findings[0]!.severity, "HIGH");
});

// ---------------------------------------------------------------------------
// R3: mapeo exec → command-injection / HIGH
// ---------------------------------------------------------------------------

test("(findings-2) exec sink → type=command-injection, severity=HIGH", () => {
  const path = makePath("src-node", "__sink__exec");
  // synthetic sink — not in catalog
  const findings = deriveFindings([path], EMPTY_CATALOG, [
    makeNode("src-node", "handleRequest"),
  ], FIXED_CLOCK);

  assert.equal(findings[0]!.type, "command-injection");
  assert.equal(findings[0]!.severity, "HIGH");
});

// ---------------------------------------------------------------------------
// R3: mapeo sql → sql-injection / HIGH
// ---------------------------------------------------------------------------

test("(findings-3) sql sink → type=sql-injection, severity=HIGH", () => {
  const path = makePath("src-node", "sink-sql");
  const catalog = makeCatalog("sink-sql", "sql");
  const nodes = [makeNode("src-node", "handleRequest"), makeNode("sink-sql", "rawQuery")];
  const findings = deriveFindings([path], catalog, nodes, FIXED_CLOCK);
  assert.equal(findings[0]!.type, "sql-injection");
  assert.equal(findings[0]!.severity, "HIGH");
});

// ---------------------------------------------------------------------------
// R3: mapeo ssrf → ssrf / HIGH
// ---------------------------------------------------------------------------

test("(findings-4) ssrf sink → type=ssrf, severity=HIGH", () => {
  const path = makePath("src-node", "__sink__fetch_user");
  const findings = deriveFindings([path], EMPTY_CATALOG, [makeNode("src-node", "req")], FIXED_CLOCK);
  assert.equal(findings[0]!.type, "ssrf");
  assert.equal(findings[0]!.severity, "HIGH");
});

// ---------------------------------------------------------------------------
// R3: mapeo path-traversal → path-traversal / MEDIUM
// ---------------------------------------------------------------------------

test("(findings-5) path-traversal sink → type=path-traversal, severity=MEDIUM", () => {
  const path = makePath("src-node", "__sink__path_write");
  const findings = deriveFindings([path], EMPTY_CATALOG, [makeNode("src-node", "upload")], FIXED_CLOCK);
  assert.equal(findings[0]!.type, "path-traversal");
  assert.equal(findings[0]!.severity, "MEDIUM");
});

// ---------------------------------------------------------------------------
// R3: mapeo template-render → template-injection / MEDIUM
// ---------------------------------------------------------------------------

test("(findings-6) template-render sink → type=template-injection, severity=MEDIUM", () => {
  const path = makePath("src-node", "__sink__render_template");
  const findings = deriveFindings([path], EMPTY_CATALOG, [makeNode("src-node", "render")], FIXED_CLOCK);
  assert.equal(findings[0]!.type, "template-injection");
  assert.equal(findings[0]!.severity, "MEDIUM");
});

// ---------------------------------------------------------------------------
// R3: mapeo weak-crypto → weak-crypto / MEDIUM
// ---------------------------------------------------------------------------

test("(findings-7) weak-crypto sink → type=weak-crypto, severity=MEDIUM", () => {
  const path = makePath("src-node", "__sink__weak_hash");
  const findings = deriveFindings([path], EMPTY_CATALOG, [makeNode("src-node", "hash")], FIXED_CLOCK);
  assert.equal(findings[0]!.type, "weak-crypto");
  assert.equal(findings[0]!.severity, "MEDIUM");
});

// ---------------------------------------------------------------------------
// R3: sink sin categoría → taint-flow / LOW
// ---------------------------------------------------------------------------

test("(findings-8) unknown sink → type=taint-flow, severity=LOW", () => {
  const path = makePath("src-node", "unknown-sink");
  const findings = deriveFindings([path], EMPTY_CATALOG, [
    makeNode("src-node", "fn"),
    makeNode("unknown-sink", "weirdSink"),
  ], FIXED_CLOCK);
  assert.equal(findings[0]!.type, "taint-flow");
  assert.equal(findings[0]!.severity, "LOW");
});

// ---------------------------------------------------------------------------
// R3: id es estable entre runs (determinismo)
// ---------------------------------------------------------------------------

test("(findings-9) id is stable between runs", () => {
  const path = makePath("src-node", "__sink__exec");
  const nodes = [makeNode("src-node", "handleRequest")];

  const a = deriveFindings([path], EMPTY_CATALOG, nodes, FIXED_CLOCK);
  const b = deriveFindings([path], EMPTY_CATALOG, nodes, FIXED_CLOCK);

  assert.equal(a[0]!.id, b[0]!.id);
  assert.equal(a[0]!.id.length, 16, "id must be 16 hex chars");
});

// ---------------------------------------------------------------------------
// R3: title sigue el patrón "<type>: <sourceLabel> → <sinkLabel>"
// ---------------------------------------------------------------------------

test("(findings-10) title pattern '<type>: <sourceLabel> → <sinkLabel>'", () => {
  const path = makePath("src-node", "__sink__exec");
  const nodes = [
    makeNode("src-node", "handleRequest"),
    makeNode("__sink__exec", "child_process.exec"),
  ];
  const findings = deriveFindings([path], EMPTY_CATALOG, nodes, FIXED_CLOCK);
  assert.equal(findings[0]!.title, "command-injection: handleRequest → child_process.exec");
});

// ---------------------------------------------------------------------------
// R3: evidence contiene todos los campos
// ---------------------------------------------------------------------------

test("(findings-11) evidence has all fields", () => {
  const steps = [
    makeStep("src-node", "mid"),
    makeStep("mid", "__sink__exec"),
  ];
  const path: AuditPath = {
    source: "src-node",
    sink: "__sink__exec",
    steps,
    minConfidence: "INFERRED",
    reposTraversed: ["repo-a"],
  };
  const findings = deriveFindings([path], EMPTY_CATALOG, [
    makeNode("src-node", "fn"),
    makeNode("mid", "mid"),
    makeNode("__sink__exec", "exec"),
  ], FIXED_CLOCK);

  const ev = findings[0]!.evidence;
  assert.equal(ev.sourceNodeId, "src-node");
  assert.equal(ev.sinkNodeId, "__sink__exec");
  assert.equal(ev.steps.length, 2);
  assert.ok(ev.reposTraversed.includes("repo-a"));
});

// ---------------------------------------------------------------------------
// R3: suggestedActions corresponde al catálogo (sql → consultas parametrizadas)
// ---------------------------------------------------------------------------

test("(findings-12) suggestedActions matches catalog for sql", () => {
  const path = makePath("src-node", "sink-sql");
  const catalog = makeCatalog("sink-sql", "sql");
  const findings = deriveFindings([path], catalog, [
    makeNode("src-node", "fn"),
    makeNode("sink-sql", "rawQuery"),
  ], FIXED_CLOCK);

  assert.ok(
    findings[0]!.suggestedActions[0]!.includes("consultas parametrizadas"),
    `Expected 'consultas parametrizadas' in: ${findings[0]!.suggestedActions[0]}`,
  );
});

// ---------------------------------------------------------------------------
// R3: relatedNodes excludes source and sink
// ---------------------------------------------------------------------------

test("(findings-13) relatedNodes excludes source and sink", () => {
  const steps = [
    makeStep("src-node", "mid"),
    makeStep("mid", "__sink__exec"),
  ];
  const path: AuditPath = {
    source: "src-node",
    sink: "__sink__exec",
    steps,
    minConfidence: "INFERRED",
    reposTraversed: [],
  };
  const findings = deriveFindings([path], EMPTY_CATALOG, [], FIXED_CLOCK);
  assert.ok(findings[0]!.relatedNodes.includes("mid"), "mid should be in relatedNodes");
  assert.ok(!findings[0]!.relatedNodes.includes("src-node"), "src-node should NOT be in relatedNodes");
  assert.ok(!findings[0]!.relatedNodes.includes("__sink__exec"), "sink should NOT be in relatedNodes");
});

// ---------------------------------------------------------------------------
// R3: createdAt uses the injected clock (R8)
// ---------------------------------------------------------------------------

test("(findings-14) createdAt is from clock", () => {
  const path = makePath("s", "t");
  const findings = deriveFindings([path], EMPTY_CATALOG, [], () => 42);
  assert.equal(findings[0]!.createdAt, 42);
});

// ---------------------------------------------------------------------------
// R3: source is always "audit.run"
// ---------------------------------------------------------------------------

test("(findings-15) source is always 'audit.run'", () => {
  const path = makePath("s", "t");
  const findings = deriveFindings([path], EMPTY_CATALOG, [], FIXED_CLOCK);
  assert.equal(findings[0]!.source, "audit.run");
});

// ---------------------------------------------------------------------------
// R3: 1 finding per path (order preserved)
// ---------------------------------------------------------------------------

test("(findings-16) 1 finding per path, same order", () => {
  const paths = [
    makePath("s1", "__sink__exec"),
    makePath("s2", "__sink__eval"),
    makePath("s3", "unknown-sink"),
  ];
  const findings = deriveFindings(paths, EMPTY_CATALOG, [], FIXED_CLOCK);
  assert.equal(findings.length, 3);
  assert.equal(findings[0]!.type, "command-injection");
  assert.equal(findings[1]!.type, "code-injection");
  assert.equal(findings[2]!.type, "taint-flow");
});

// ---------------------------------------------------------------------------
// R3: suggestedActions for eval catalog
// ---------------------------------------------------------------------------

test("(findings-17) suggestedActions for eval contains eval advisory", () => {
  const path = makePath("src-node", "__sink__eval");
  const findings = deriveFindings([path], EMPTY_CATALOG, [], FIXED_CLOCK);
  assert.ok(
    findings[0]!.suggestedActions[0]!.includes("eval()"),
    `Expected 'eval()' in first suggested action`,
  );
});

// ---------------------------------------------------------------------------
// R3: suggestedActions default for unknown category
// ---------------------------------------------------------------------------

test("(findings-18) default suggestedActions for taint-flow", () => {
  const path = makePath("s", "unknown-sink");
  const findings = deriveFindings([path], EMPTY_CATALOG, [], FIXED_CLOCK);
  assert.ok(
    findings[0]!.suggestedActions[0]!.includes("taint"),
    `Expected 'taint' in default action: ${findings[0]!.suggestedActions[0]}`,
  );
});
