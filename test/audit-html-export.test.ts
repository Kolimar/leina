// test/audit-html-export.test.ts — Unit tests para renderAuditHtml.
//
// Cubre:
//   - pureza / idempotencia, offline (vis.js inlinado, sin CDN)
//   - disclaimer obligatorio (NFR-08) embebido + banner
//   - clasificación de roles (source/sink/synthetic/waypoint)
//   - edges con id = step key (para highlight de rutas)
//   - XSS-safe: escaping de labels + cierre de <script>
//   - caso vacío (sin rutas)

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAuditHtml } from "../src/application/audit/audit-html-export.ts";
import type { AuditPack } from "../src/application/audit/pack.ts";
import { AUDIT_DISCLAIMER } from "../src/application/audit/pack.ts";
import { FAKE_VIS, assertGolden } from "./helpers/golden.ts";

function makePack(overrides?: Partial<AuditPack>): AuditPack {
  return {
    schemaVersion: 3,
    disclaimer: AUDIT_DISCLAIMER,
    builtAt: 0,
    reposInvolved: ["repo-a", "repo-b"],
    prunedPaths: 0,
    findings: [],
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
      { id: "fn:process", label: "process", fileType: "code", sourceFile: "src/b.ts", kind: "function", repo: "repo-b" },
      { id: "__sink__exec", label: "child_process.exec", fileType: "concept", sourceFile: "__synthetic__", kind: "concept" },
    ],
    edges: [
      { source: "fn:handleReq", target: "fn:process", relation: "calls", confidence: "EXTRACTED", sourceFile: "src/a.ts", weight: 1 },
      { source: "fn:process", target: "__sink__exec", relation: "calls", confidence: "INFERRED", sourceFile: "src/b.ts", weight: 1 },
    ],
    ...overrides,
  };
}

test("renderAuditHtml: vis.js inlinado y sin CDN (offline)", () => {
  const { content } = renderAuditHtml(makePack(), FAKE_VIS, { projectName: "demo" });
  assert.ok(content.includes(FAKE_VIS), "debe inlinar la lib vis");
  assert.ok(!content.includes("http://") && !content.includes("https://"), "sin URLs externas");
  assert.ok(content.startsWith("<!doctype html>"));
});

test("renderAuditHtml: disclaimer obligatorio (NFR-08) en banner + payload", () => {
  const { content } = renderAuditHtml(makePack(), FAKE_VIS, { projectName: "demo" });
  assert.ok(content.includes("NOTICE"), "banner con NOTICE");
  assert.ok(content.includes(AUDIT_DISCLAIMER.slice(0, 30)) || content.includes("rutas CANDIDATAS"));
});

test("renderAuditHtml: pureza / idempotencia", () => {
  const pack = makePack();
  const a = renderAuditHtml(pack, FAKE_VIS, { projectName: "demo" });
  const b = renderAuditHtml(pack, FAKE_VIS, { projectName: "demo" });
  assert.equal(a.content, b.content);
  assert.equal(a.path, "");
});

test("renderAuditHtml: roles y synthetic sink (diamond)", () => {
  const { content } = renderAuditHtml(makePack(), FAKE_VIS, { projectName: "demo" });
  const payloadMatch = /const DATA = (\{.*?\});\n/s.exec(content);
  assert.ok(payloadMatch, "DATA presente");
  const data = JSON.parse(payloadMatch[1]!.replaceAll(String.raw`<\/`, "</"));
  const byId = Object.fromEntries(data.nodes.map((n: any) => [n.id, n]));
  assert.equal(byId["fn:handleReq"].group, "source");
  assert.equal(byId.__sink__exec.group, "synthetic");
  assert.equal(byId.__sink__exec.shape, "diamond");
  assert.equal(byId["fn:process"].group, "waypoint");
});

test("renderAuditHtml: edge id = step key (para highlight de rutas)", () => {
  const { content } = renderAuditHtml(makePack(), FAKE_VIS, { projectName: "demo" });
  const payloadMatch = /const DATA = (\{.*?\});\n/s.exec(content);
  const data = JSON.parse(payloadMatch![1]!.replaceAll(String.raw`<\/`, "</"));
  const ids = data.edges.map((e: any) => e.id);
  assert.ok(ids.includes("fn:handleReq::fn:process::calls"));
  assert.ok(ids.includes("fn:process::__sink__exec::calls"));
});

test("renderAuditHtml: XSS-safe en labels", () => {
  const pack = makePack();
  pack.nodes[0]!.label = '<img src=x onerror=alert(1)>';
  const { content } = renderAuditHtml(pack, FAKE_VIS, { projectName: "demo" });
  assert.ok(!content.includes("<img src=x onerror=alert(1)>"), "label peligroso debe escaparse");
  assert.ok(content.includes("&lt;img"), "debe contener la versión escapada");
});

test("renderAuditHtml: no cierra el bloque <script> con datos", () => {
  const pack = makePack();
  pack.nodes[0]!.label = "</script><script>evil()";
  const { content } = renderAuditHtml(pack, FAKE_VIS, { projectName: "demo" });
  assert.ok(!content.includes("</script><script>evil"), "no debe romper el script");
});

test("renderAuditHtml: caso vacío (sin rutas) renderiza sin crash", () => {
  const empty: AuditPack = {
    schemaVersion: 3, disclaimer: AUDIT_DISCLAIMER, builtAt: 0,
    reposInvolved: [], prunedPaths: 0, findings: [], paths: [], nodes: [], edges: [],
  };
  const { content } = renderAuditHtml(empty, FAKE_VIS, { projectName: "demo" });
  assert.ok(content.includes("No se encontraron rutas") || content.includes("DATA.nodes.length === 0"));
});

// ── GH-02/GH-03: Golden tests ─────────────────────────────────────────────────

test("(audit-golden-html) golden audit.html (GH-02)", () => {
  const { content } = renderAuditHtml(makePack(), FAKE_VIS, { projectName: "demo" });
  assertGolden("audit.html", content);
});

test("(audit-golden-json) golden audit-pack.json (GH-03)", () => {
  // Usar builtAt:0 para byte-determinismo (buildAuditPack() llama Date.now())
  const pack = makePack({ builtAt: 0 });
  assertGolden("audit-pack.json", JSON.stringify(pack, null, 2));
});
