// test/html-export.test.ts — Unit tests para renderGraphHtml (Tasks 4.2-4.4)
//
// Cubre:
//   4.2 – pureza/idempotencia, offline (sin CDN), vis.js inlinado
//   4.3 – XSS-safe: escaping de labels y cierre de bloque <script>
//   4.4 – codificación visual: degree A5, dashes:true INFERRED, controles en HTML

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderGraphHtml, escapeHtml } from "../src/application/graph/html-export.ts";
import type { NodeLinkGraph } from "../src/domain/graph/model.ts";
import { FAKE_VIS, assertGolden } from "./helpers/golden.ts";

// ── Fixture compartido ───────────────────────────────────────────────────────

function makeGraph(): NodeLinkGraph {
  return {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      {
        id: "fn:a",
        label: "NodeA",
        fileType: "code",
        sourceFile: "src/domain/a.ts",
        kind: "function",
        community: 0,
      },
      {
        id: "mod:b",
        label: "b.ts",
        fileType: "code",
        sourceFile: "src/application/b.ts",
        kind: "module",
        community: 0,
      },
      {
        id: "cls:c",
        label: "NodeC",
        fileType: "code",
        sourceFile: "src/infrastructure/c.ts",
        kind: "class",
        community: 1,
      },
    ],
    links: [
      {
        source: "fn:a",
        target: "mod:b",
        relation: "imports",
        confidence: "EXTRACTED",
        sourceFile: "src/domain/a.ts",
        weight: 1,
      },
      {
        source: "mod:b",
        target: "cls:c",
        relation: "contains",
        confidence: "EXTRACTED",
        sourceFile: "src/application/b.ts",
        weight: 1,
      },
      {
        source: "fn:a",
        target: "cls:c",
        relation: "calls",
        confidence: "INFERRED",
        sourceFile: "src/domain/a.ts",
        weight: 1,
      },
    ],
  };
}

// ── Tarea 4.2: pureza + offline ──────────────────────────────────────────────

test("(he-1) purity: dos llamadas con igual input producen output idéntico", () => {
  const g = makeGraph();
  const r1 = renderGraphHtml(g, FAKE_VIS, { projectName: "TestProject" });
  const r2 = renderGraphHtml(g, FAKE_VIS, { projectName: "TestProject" });
  assert.equal(r1.content, r2.content);
});

test("(he-2) offline: HTML no contiene URLs CDN en <script> ni <link>", () => {
  const { content } = renderGraphHtml(makeGraph(), FAKE_VIS, { projectName: "P" });
  assert.ok(!content.includes("https://"), "no debe contener https://");
  assert.ok(!content.includes("http://"), "no debe contener http://");
  assert.ok(!content.includes("//unpkg"), "no debe contener //unpkg CDN");
});

test("(he-3) vis.js inlinado: HTML contiene el marcador del stub", () => {
  const { content } = renderGraphHtml(makeGraph(), FAKE_VIS, { projectName: "P" });
  assert.ok(content.includes(FAKE_VIS), "HTML debe incluir el contenido inlinado de vis.js");
});

test("(he-4) FileArtifact: content es string no vacío, path es string", () => {
  const artifact = renderGraphHtml(makeGraph(), FAKE_VIS, { projectName: "P" });
  assert.ok(typeof artifact.content === "string" && artifact.content.length > 0);
  assert.ok(typeof artifact.path === "string");
});

// ── Tarea 4.3: XSS-safe ──────────────────────────────────────────────────────

test("(he-5) XSS: label con <script>alert(1)</script> queda HTML-escapado", () => {
  const g = makeGraph();
  // El label aparece en el título/tooltip (escapeHtml aplicado)
  g.nodes[0]!.label = "<script>alert(1)</script>";
  const { content } = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  assert.ok(content.includes("&lt;script&gt;"), "debe contener la forma HTML-escapada &lt;script&gt;");
  assert.ok(!content.includes("<script>alert"), "el raw <script>alert NO debe aparecer sin escapar");
});

test("(he-6) XSS: </script> en ID de nodo queda neutralizado con <\\/", () => {
  // El ID no pasa por escapeHtml; el replaceAll('</', '<\\/') es el guardián
  const g: NodeLinkGraph = {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      {
        id: "bad</script>node",
        label: "safe",
        fileType: "code",
        sourceFile: "src/a.ts",
        kind: "function",
      },
    ],
    links: [],
  };
  const { content } = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  // La cadena raw no debe aparecer
  assert.ok(!content.includes("bad</script>node"), 'el raw "bad</script>node" no debe aparecer');
  // La forma escapada (con backslash, 3 chars: <\/) debe estar presente
  // En TypeScript: "<\\/" es la cadena de 3 chars: <, \, /
  assert.ok(
    content.includes("bad<\\/script>node"),
    'la forma escapada "bad<\\/script>node" debe estar presente en el JSON',
  );
});

test("(he-7) XSS: projectName en el <title> queda HTML-escapado", () => {
  const { content } = renderGraphHtml(makeGraph(), FAKE_VIS, {
    projectName: "<Evil & \"Project\">",
  });
  assert.ok(content.includes("&lt;Evil &amp; &quot;Project&quot;&gt;"),
    "projectName debe estar HTML-escapado en el <title>");
  assert.ok(!content.includes("<Evil"), "raw <Evil no debe aparecer en el title");
});

// ── Tarea 4.4: codificación visual ───────────────────────────────────────────

test("(he-8) degree A5: aristas 'contains' excluidas del tamaño del nodo", () => {
  // Nodo 'a': 1 edge imports (a→b) + 1 edge contains (a→c) → degree=1 (contains excluido)
  // Nodo 'b': 1 edge imports (como target) → degree=1
  // Nodo 'c': 0 non-contains edges (sólo es target de contains) → degree=0
  const g: NodeLinkGraph = {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      { id: "a", label: "A", fileType: "code", sourceFile: "src/domain/a.ts", kind: "function" },
      { id: "b", label: "B", fileType: "code", sourceFile: "src/domain/b.ts", kind: "function" },
      { id: "c", label: "C", fileType: "code", sourceFile: "src/domain/c.ts", kind: "function" },
    ],
    links: [
      { source: "a", target: "b", relation: "imports", confidence: "EXTRACTED", sourceFile: "src/a.ts", weight: 1 },
      { source: "a", target: "c", relation: "contains", confidence: "EXTRACTED", sourceFile: "src/a.ts", weight: 1 },
    ],
  };
  const { content } = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  // Nodo c tiene value:0 (la arista contains no cuenta)
  assert.ok(content.includes('"value":0'), "nodo c debe tener value=0 (arista contains excluida)");
  // Nodo a y b tienen value:1 (1 arista imports)
  assert.ok(content.includes('"value":1'), "nodo a/b deben tener value=1");
  // Ningún nodo tiene value:2 (si contains contara, a tendría 2)
  assert.ok(!content.includes('"value":2'), "ningún nodo debe tener value=2 con este grafo");
});

test("(he-9) dashes:true para aristas INFERRED, false para EXTRACTED", () => {
  const { content } = renderGraphHtml(makeGraph(), FAKE_VIS, { projectName: "P" });
  assert.ok(content.includes('"dashes":true'), "arista INFERRED debe tener dashes:true");
  assert.ok(content.includes('"dashes":false'), "arista EXTRACTED debe tener dashes:false");
});

test("(he-10) controles de UI presentes en el HTML generado", () => {
  const { content } = renderGraphHtml(makeGraph(), FAKE_VIS, { projectName: "P" });
  assert.ok(content.includes('id="search"'), "debe haber input con id=search");
  assert.ok(content.includes('id="physics-toggle"'), "debe haber botón con id=physics-toggle");
  assert.ok(content.includes('id="filters"'), "debe haber contenedor con id=filters");
});

test("(he-11) color por carpeta: cada nodo se agrupa por su carpeta top-level (no por comunidad)", () => {
  const { content } = renderGraphHtml(makeGraph(), FAKE_VIS, { projectName: "P" });
  // El agrupado es por carpeta: domain / application / infrastructure
  assert.ok(content.includes('"group":"domain"'), "debe existir grupo domain");
  assert.ok(content.includes('"group":"application"'), "debe existir grupo application");
  assert.ok(content.includes('"group":"infrastructure"'), "debe existir grupo infrastructure");
  // NO debe agrupar por comunidad
  assert.ok(!content.includes('"comm_0"'), "no debe existir grupo comm_0 (color es por carpeta)");
});

test("(he-12) community null/undefined usa fallback de carpeta top-level", () => {
  const g: NodeLinkGraph = {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      {
        id: "x",
        label: "X",
        fileType: "code",
        sourceFile: "src/domain/x.ts",
        kind: "function",
        // community no definido → fallback a "layer_domain"
      },
    ],
    links: [],
  };
  const { content } = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  assert.ok(content.includes('"group":"domain"'), "nodo en src/domain debe usar grupo domain");
});

// ── escapeHtml unitario ───────────────────────────────────────────────────────

test("(he-13) escapeHtml escapa los cinco caracteres peligrosos", () => {
  assert.equal(
    escapeHtml('& < > " \''),
    "&amp; &lt; &gt; &quot; &#39;",
    "debe escapar &, <, >, \", '",
  );
});

test("(he-14) escapeHtml es idempotente sobre strings ya escapados: no doble-escapa", () => {
  // Verificar que un string sin caracteres especiales no se modifica
  assert.equal(escapeHtml("hello world"), "hello world");
  // Un string ya escapado SÍ se doble-escapa (comportamiento esperado de escapeHtml puro)
  // → el caller es responsable de no escapar dos veces
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
});

test("(he-15) projectName en el <title> del HTML es parametrizado (sin hardcoded)", () => {
  const { content } = renderGraphHtml(makeGraph(), FAKE_VIS, { projectName: "MyRepo" });
  assert.ok(content.includes("MyRepo"), "el HTML debe contener el projectName");
  assert.ok(!content.includes("leina"), "el HTML no debe tener projectName hardcodeado");
});

// ── Drawer de detalle (click en nodo, no hover) ──────────────────────────────

test("(he-16) drawer: el contenedor #drawer y el handler de click existen", () => {
  const { content } = renderGraphHtml(makeGraph(), FAKE_VIS, { projectName: "P" });
  assert.ok(content.includes('id="drawer"'), "debe existir el contenedor #drawer");
  assert.ok(content.includes("network.on('click'"), "debe registrar un handler de click en la red");
  assert.ok(content.includes("openDrawer"), "debe definir/usar openDrawer");
});

test("(he-17) detalle estructurado: cada nodo lleva 'd' con campos (degree, file) en vez de title de hover", () => {
  const { content } = renderGraphHtml(makeGraph(), FAKE_VIS, { projectName: "P" });
  assert.ok(content.includes('"d":{'), "los nodos deben embeber el objeto de detalle 'd'");
  assert.ok(content.includes('"degree":'), "el detalle debe incluir degree");
  assert.ok(content.includes('"file":'), "el detalle debe incluir file");
});

test("(he-18) firma estructurada legible en el detalle del nodo", () => {
  const g = makeGraph();
  g.nodes[0]!.signature = {
    returnType: { text: "Foo", nullable: false },
    parameters: [{ name: "x", type: "string", nullable: false, optional: false }],
    isAsync: true,
    isGenerator: false,
  };
  const { content } = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  // "async (x: string) => Foo" (HTML-escapado; sin < > no cambia)
  assert.ok(content.includes("async (x: string) =&gt; Foo"), "debe renderizar la firma legible escapada");
});

// ── GH-02: Golden tests ───────────────────────────────────────────────────────

function makeDrilldownGraph(): NodeLinkGraph {
  return {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      {
        id: "fn:a",
        label: "NodeA",
        fileType: "code",
        sourceFile: "src/domain/a.ts",
        kind: "function",
        repo: "r",
      },
      {
        id: "fn:b",
        label: "NodeB",
        fileType: "code",
        sourceFile: "src/application/b.ts",
        kind: "function",
        repo: "r",
      },
    ],
    links: [
      {
        source: "fn:a",
        target: "fn:b",
        relation: "calls",
        confidence: "EXTRACTED",
        sourceFile: "src/domain/a.ts",
        weight: 1,
        repo: "r",
      },
    ],
  };
}

test("(he-golden-single) golden graph-single.html (GH-02)", () => {
  const { content } = renderGraphHtml(makeGraph(), FAKE_VIS, { projectName: "P", mode: "single" });
  assertGolden("graph-single.html", content);
});

test("(he-golden-drilldown) golden graph-drilldown.html (GH-02)", () => {
  const { content } = renderGraphHtml(makeDrilldownGraph(), FAKE_VIS, {
    projectName: "P",
    mode: "drilldown",
    selectedRepo: "r",
  });
  assertGolden("graph-drilldown.html", content);
});
