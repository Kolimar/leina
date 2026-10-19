// html-export-dom.test.ts — the offline graph viewer's CLIENT code under jsdom (XSS).
//
// html-export.test.ts checks the server-side escaping of the embedded payload; this file
// runs the generated graph.html's own inline script, because the remaining sinks were on
// the client: the group-filter rows were built with innerHTML from META.layers keys
// (top-level folder names, or repo keys in the constellation view), and the detail
// drawer fell back to the raw node id for nodes without a pre-escaped `d` blob
// (drilldown + constellation). A repo dir named `<img src=x onerror=...>` executed on
// opening graph.html. jsdom fetches no resources, so instead of waiting for onerror the
// tests assert that no <img> element was ever created and the text renders verbatim.
//
// jsdom ships no types (dev-only dependency) — loaded via computed dynamic import, DOM
// values are untyped `any` (same approach as graph-ui-dom.test.ts).
// Run: node --no-warnings --experimental-strip-types --test test/html-export-dom.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderConstellationHtml, renderGraphHtml } from "../src/application/graph/html-export.ts";
import type { NodeLinkGraph } from "../src/domain/graph/model.ts";

const JSDOM_SPEC = "jsdom";
const EVIL = "<img src=x onerror=alert(1)>";

// Recording vis stub, shipped as the "inlined vis-network" so the viewer script runs
// unmodified: Network keeps its event handlers so a test can fire a node click.
const VIS_STUB = `
window.__nets = [];
window.vis = {
  DataSet: function (items) { this.items = items; this.update = function () {}; },
  Network: function () {
    var h = {}; this.handlers = h;
    this.on = function (ev, fn) { h[ev] = fn; };
    this.once = function () {};
    this.setOptions = function () {}; this.focus = function () {};
    this.selectNodes = function () {}; this.fit = function () {};
    window.__nets.push(this);
  }
};`;

async function load(html: string): Promise<any> {
  const { JSDOM } = await import(JSDOM_SPEC);
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  return dom.window;
}

function evilGraph(): NodeLinkGraph {
  return {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      { id: `fn:${EVIL}/a.ts#run`, label: "run", fileType: "code", sourceFile: `${EVIL}/a.ts`, kind: "function", repo: EVIL },
      { id: "fn:src/b.ts#ok", label: "ok", fileType: "code", sourceFile: "src/b.ts", kind: "function", repo: "r" },
    ],
    links: [
      { source: `fn:${EVIL}/a.ts#run`, target: "fn:src/b.ts#ok", relation: "calls", confidence: "EXTRACTED", sourceFile: `${EVIL}/a.ts`, weight: 1 },
    ],
  };
}

function filterLabels(win: any): string[] {
  return [...win.document.querySelectorAll("#filters label")].map((l: any) => l.textContent as string);
}

test("(hedom-1) group filters render folder names as text, never as markup", async () => {
  const { content } = renderGraphHtml(evilGraph(), VIS_STUB, { projectName: "P" });
  const win = await load(content);
  assert.equal(win.document.querySelectorAll("img").length, 0, "no element injected anywhere");
  assert.ok(filterLabels(win).some((t) => t.startsWith(EVIL)), "folder name shown verbatim");
  // The checkbox still carries the RAW group key, so filtering keeps working.
  const keys = [...win.document.querySelectorAll("#filters input")].map((i: any) => i.dataset.g);
  assert.ok(keys.includes(EVIL), "data-g is the raw group key");
});

test("(hedom-2) drilldown: clicking a node without a detail blob shows its id as text", async () => {
  const { content } = renderGraphHtml(evilGraph(), VIS_STUB, { projectName: "P", mode: "drilldown" });
  const win = await load(content);
  win.__nets[0].handlers.click({ nodes: [`fn:${EVIL}/a.ts#run`] });
  assert.equal(win.document.querySelectorAll("#drawer img").length, 0, "drawer injected no element");
  assert.equal(win.document.querySelector("#drawer h2").textContent, `fn:${EVIL}/a.ts#run`);
});

test("(hedom-3) constellation: repo keys are text in the filters and the drawer", async () => {
  const repoStats = new Map([
    [EVIL, { nodeCount: 3, edgeCount: 1 }],
    ["api", { nodeCount: 2, edgeCount: 0 }],
  ]);
  const { content } = renderConstellationHtml(repoStats, [{ source: EVIL, target: "api" }], VIS_STUB, {
    projectName: "W",
  });
  const win = await load(content);
  assert.equal(win.document.querySelectorAll("img").length, 0, "no element injected by the filters");
  assert.ok(filterLabels(win).some((t) => t.startsWith(EVIL)), "repo key shown verbatim");
  win.__nets[0].handlers.click({ nodes: [EVIL] });
  assert.equal(win.document.querySelectorAll("#drawer img").length, 0, "drawer injected no element");
  assert.equal(win.document.querySelector("#drawer h2").textContent, EVIL);
});
