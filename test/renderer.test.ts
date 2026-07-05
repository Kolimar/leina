// test/renderer.test.ts — tests for Renderer<AuditPack> implementations (R2/R6a/R6b/R6c).
//
// R2: Renderer<T> interface — MarkdownRenderer/JsonRenderer path=""; HtmlRenderer path="audit-graph.html"
// R6a: --json ≡ --format json (JsonRenderer output byte-identical)
// R6b: --format md golden (audit-report.md)
// R6c: --format html → HtmlRenderer path is "audit-graph.html"
//
// All fixtures use builtAt:0, createdAt:0 for deterministic output (R8).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuditPack } from "../src/application/audit/pack.ts";
import { AUDIT_DISCLAIMER } from "../src/application/audit/pack.ts";
import { MarkdownRenderer } from "../src/application/render/markdown-renderer.ts";
import { JsonRenderer } from "../src/application/render/json-renderer.ts";
import { HtmlRenderer } from "../src/application/render/html-renderer.ts";
import { renderAuditHtml } from "../src/application/audit/audit-html-export.ts";
import { FAKE_VIS, assertGolden } from "./helpers/golden.ts";
import type { Finding } from "../src/domain/findings/model.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FIXED_FINDING: Finding = {
  id: "abcdef1234567890",
  type: "command-injection",
  severity: "HIGH",
  title: "command-injection: handleRequest → child_process.exec",
  description: "Potential command-injection vulnerability: tainted data flows from handleRequest to child_process.exec through 2 hop(s).",
  evidence: {
    sourceNodeId: "fn:handleReq",
    sinkNodeId: "__sink__exec",
    steps: [
      { from: "fn:handleReq", to: "fn:process", relation: "calls", confidence: "EXTRACTED" },
      { from: "fn:process", to: "__sink__exec", relation: "calls", confidence: "INFERRED" },
    ],
    reposTraversed: ["repo-a", "repo-b"],
  },
  relatedNodes: ["fn:process"],
  suggestedActions: [
    "Nunca interpolar input del usuario en comandos de shell.",
    "Usar APIs parametrizadas (execFile con array de args, sin shell: true).",
    "Aplicar validación de input y allowlist de comandos permitidos.",
  ],
  confidence: "INFERRED",
  source: "audit.run",
  createdAt: 0,
};

function makePack(overrides?: Partial<AuditPack>): AuditPack {
  return {
    schemaVersion: 3,
    disclaimer: AUDIT_DISCLAIMER,
    builtAt: 0,
    reposInvolved: ["repo-a", "repo-b"],
    prunedPaths: 0,
    findings: [FIXED_FINDING],
    paths: [
      {
        source: "fn:handleReq",
        sink: "__sink__exec",
        minConfidence: "INFERRED",
        reposTraversed: ["repo-a", "repo-b"],
        steps: [
          { from: "fn:handleReq", to: "fn:process", relation: "calls", confidence: "EXTRACTED" },
          { from: "fn:process", to: "__sink__exec", relation: "calls", confidence: "INFERRED" },
        ],
      },
    ],
    nodes: [
      { id: "fn:handleReq", label: "handleRequest", fileType: "code", sourceFile: "src/a.ts", kind: "function", repo: "repo-a" },
      { id: "fn:process",   label: "process",       fileType: "code", sourceFile: "src/b.ts", kind: "function", repo: "repo-b" },
      { id: "__sink__exec", label: "child_process.exec", fileType: "concept", sourceFile: "__synthetic__", kind: "concept" },
    ],
    edges: [
      { source: "fn:handleReq", target: "fn:process",   relation: "calls", confidence: "EXTRACTED", sourceFile: "src/a.ts", weight: 1 },
      { source: "fn:process",   target: "__sink__exec",  relation: "calls", confidence: "INFERRED",  sourceFile: "src/b.ts", weight: 1 },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// R2: MarkdownRenderer path === ""
// ---------------------------------------------------------------------------

test("(rend-1) MarkdownRenderer.render: path is empty string", () => {
  const renderer = new MarkdownRenderer({ projectName: "demo" });
  const result = renderer.render(makePack());
  assert.equal(result.path, "");
  assert.ok(result.content.length > 0);
});

// ---------------------------------------------------------------------------
// R2: JsonRenderer path === ""
// ---------------------------------------------------------------------------

test("(rend-2) JsonRenderer.render: path is empty string", () => {
  const renderer = new JsonRenderer();
  const result = renderer.render(makePack());
  assert.equal(result.path, "");
  assert.ok(result.content.length > 0);
});

// ---------------------------------------------------------------------------
// R2: HtmlRenderer path === "audit-graph.html"
// ---------------------------------------------------------------------------

test("(rend-3) HtmlRenderer.render: path is 'audit-graph.html'", () => {
  const renderer = new HtmlRenderer(FAKE_VIS, { projectName: "demo" });
  const result = renderer.render(makePack());
  assert.equal(result.path, "audit-graph.html");
  assert.ok(result.content.startsWith("<!doctype html>"));
});

// ---------------------------------------------------------------------------
// R2: MarkdownRenderer content non-empty + starts with # Audit Report
// ---------------------------------------------------------------------------

test("(rend-4) MarkdownRenderer: content starts with '# Audit Report'", () => {
  const renderer = new MarkdownRenderer({ projectName: "demo" });
  const { content } = renderer.render(makePack());
  assert.ok(content.startsWith("# Audit Report"), `got: ${content.slice(0, 50)}`);
});

// ---------------------------------------------------------------------------
// R2: JsonRenderer content is valid JSON
// ---------------------------------------------------------------------------

test("(rend-5) JsonRenderer: content is valid JSON matching the pack", () => {
  const pack = makePack();
  const renderer = new JsonRenderer();
  const { content } = renderer.render(pack);
  const parsed = JSON.parse(content) as typeof pack;
  assert.equal(parsed.schemaVersion, 3);
  assert.ok(Array.isArray(parsed.findings));
});

// ---------------------------------------------------------------------------
// R6a: --json ≡ --format json (byte-identical output)
// ---------------------------------------------------------------------------

test("(rend-6a) JsonRenderer output is identical to JSON.stringify(pack, null, 2)", () => {
  const pack = makePack();
  const renderer = new JsonRenderer();
  const { content } = renderer.render(pack);
  assert.equal(content, JSON.stringify(pack, null, 2));
});

// ---------------------------------------------------------------------------
// R6b: --format md golden (audit-report.md)
// ---------------------------------------------------------------------------

test("(rend-6b) MarkdownRenderer golden: audit-report.md", () => {
  const renderer = new MarkdownRenderer({ projectName: "demo" });
  const { content } = renderer.render(makePack());
  assertGolden("audit-report.md", content);
});

// ---------------------------------------------------------------------------
// R6b: markdown contains HIGH section
// ---------------------------------------------------------------------------

test("(rend-6b-content) markdown contains [HIGH] section", () => {
  const renderer = new MarkdownRenderer({ projectName: "demo" });
  const { content } = renderer.render(makePack());
  assert.ok(content.includes("### [HIGH]"), "Expected ### [HIGH] section");
});

// ---------------------------------------------------------------------------
// R6c: HtmlRenderer content starts with <!doctype html>
// ---------------------------------------------------------------------------

test("(rend-6c) HtmlRenderer: content starts with '<!doctype html>'", () => {
  const renderer = new HtmlRenderer(FAKE_VIS, { projectName: "demo" });
  const { content } = renderer.render(makePack());
  assert.ok(content.startsWith("<!doctype html>"));
});

// ---------------------------------------------------------------------------
// R7: HtmlRenderer byte-identical to renderAuditHtml
// ---------------------------------------------------------------------------

test("(rend-7) HtmlRenderer output is byte-identical to renderAuditHtml", () => {
  const pack = makePack();
  const renderer = new HtmlRenderer(FAKE_VIS, { projectName: "demo" });
  const fromRenderer = renderer.render(pack).content;
  const direct = renderAuditHtml(pack, FAKE_VIS, { projectName: "demo" }).content;
  assert.equal(fromRenderer, direct, "HtmlRenderer must delegate 100% to renderAuditHtml");
});

// ---------------------------------------------------------------------------
// R2: MarkdownRenderer with no findings shows empty state
// ---------------------------------------------------------------------------

test("(rend-8) MarkdownRenderer with no findings: valid header + Resumen table", () => {
  const pack = makePack({ findings: [] });
  const renderer = new MarkdownRenderer({ projectName: "empty-project" });
  const { content } = renderer.render(pack);
  assert.ok(content.startsWith("# Audit Report — empty-project"));
  assert.ok(content.includes("| HIGH     |"), "should have HIGH row in Resumen");
  assert.ok(content.includes("## Resumen"), "should have Resumen section");
});

// ---------------------------------------------------------------------------
// R2: JsonRenderer preserves findings array
// ---------------------------------------------------------------------------

test("(rend-9) JsonRenderer preserves findings in output", () => {
  const pack = makePack();
  const renderer = new JsonRenderer();
  const { content } = renderer.render(pack);
  const parsed = JSON.parse(content) as typeof pack;
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]!.type, "command-injection");
});

// ---------------------------------------------------------------------------
// Trailing newline in markdown
// ---------------------------------------------------------------------------

test("(rend-10) MarkdownRenderer output ends with newline", () => {
  const renderer = new MarkdownRenderer({ projectName: "demo" });
  const { content } = renderer.render(makePack());
  assert.ok(content.endsWith("\n"), "markdown must end with trailing newline");
});
