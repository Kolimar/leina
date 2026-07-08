// graph-ui-dom.test.ts — DOM/interaction coverage for the `graph serve` explorer UI.
//
// lib.js (pure data-shaping) is unit-tested in graph-ui-lib.test.ts. This file covers the
// OTHER half — app.js's real DOM+event wiring — under jsdom (a dev-only dependency, no
// browser binary). It loads the SHIPPED app.js verbatim into a jsdom document built from
// the shipped index.html, with only the two things a browser would otherwise provide
// stubbed: `vis` (a functional DataSet + a no-canvas Network that records its calls) and
// `fetch` (a canned JSON API). Then it drives the four FR-08..13 behaviours by real DOM
// events and asserts the click→toggle→redraw wiring, including that visibility toggles
// never re-fetch the canvas.
//
// jsdom ships no types and the project's tsconfig deliberately omits the DOM lib (this is
// a Node CLI), so jsdom + lib.js are loaded via computed dynamic import (same trick
// graph-ui-lib.test.ts uses for lib.js) and every DOM value is untyped `any`. That is why
// there are no HTMLElement annotations below.
// Run: node --no-warnings --experimental-strip-types --test test/graph-ui-dom.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_JS = join(REPO_ROOT, "assets", "graph-ui", "app.js");
const INDEX_HTML = join(REPO_ROOT, "assets", "graph-ui", "index.html");
const LIB_PATH = join(REPO_ROOT, "assets", "graph-ui", "lib.js");
// Non-literal specifier → tsc treats the import as `any` (no @types/jsdom, no DOM lib).
const JSDOM_SPEC = "jsdom";

// --- canned API ------------------------------------------------------------
// Two projects with DELIBERATELY different stats/graph, so a project switch is observable
// (different chips, different node counts) rather than a no-op re-render of the same data.
const API: Record<string, unknown> = {
  "/api/projects": {
    projects: [
      { projectKey: "proj-a", root: "/tmp/a", lastBuild: 1 },
      { projectKey: "proj-b", root: "/tmp/b", lastBuild: 2 },
    ],
  },
  "/api/projects/proj-a/stats": {
    byKind: [{ kind: "function", count: 3 }, { kind: "module", count: 2 }],
    byRelation: [{ relation: "calls", count: 5 }, { relation: "contains", count: 4 }],
  },
  "/api/projects/proj-a/tree": {
    tree: { path: "", children: [{ path: "src", children: [], files: ["src/a.ts"] }], files: [] },
  },
  "/api/projects/proj-a/graph": {
    nodes: [
      { id: "f1", label: "foo", kind: "function", file: "src/a.ts", degree: 2 },
      { id: "m1", label: "a.ts", kind: "module", file: "src/a.ts", degree: 1 },
    ],
    edges: [
      { from: "f1", to: "m1", relation: "contains" },
      { from: "f1", to: "m1", relation: "calls" },
    ],
  },
  "/api/projects/proj-a/search": { results: [{ id: "f1", label: "foo", kind: "function", file: "src/a.ts" }] },
  "/api/projects/proj-a/nodes/f1": {
    node: { label: "foo", kind: "function", layer: "app", file: "src/a.ts", degree: 2 },
    neighbors: [],
  },
  "/api/projects/proj-a/nodes/f1/memories": { memories: [] },
  "/api/projects/proj-b/stats": {
    byKind: [{ kind: "class", count: 7 }],
    byRelation: [{ relation: "extends", count: 1 }],
  },
  "/api/projects/proj-b/tree": { tree: { path: "", children: [], files: [] } },
  "/api/projects/proj-b/graph": {
    nodes: [{ id: "c1", label: "Widget", kind: "class", file: "src/w.ts", degree: 0 }],
    edges: [],
  },
};

// Minimal vis.DataSet: the id-keyed subset app.js uses (add / update-merge / get all /
// get-by-id / clear). Returns copies so callers can't mutate our backing store.
class FakeDataSet {
  private map = new Map<string, Record<string, unknown>>();
  constructor(initial: Record<string, unknown>[] = []) {
    this.add(initial);
  }
  add(items: Record<string, unknown> | Record<string, unknown>[]): void {
    for (const it of ([] as Record<string, unknown>[]).concat(items)) this.map.set(it.id as string, { ...it });
  }
  update(items: Record<string, unknown> | Record<string, unknown>[]): void {
    for (const it of ([] as Record<string, unknown>[]).concat(items)) {
      this.map.set(it.id as string, { ...(this.map.get(it.id as string) ?? {}), ...it });
    }
  }
  get(id?: string): unknown {
    if (id === undefined) return [...this.map.values()].map((v) => ({ ...v }));
    const one = this.map.get(id);
    return one ? { ...one } : null;
  }
  clear(): void {
    this.map.clear();
  }
}

// Non-visual vis.Network: records the calls app.js makes (setOptions/fit/focus/…) so the
// tests can assert "the canvas was navigated" without a real WebGL/canvas backend.
class FakeNetwork {
  calls: unknown[][] = [];
  on(): void {}
  setOptions(o: unknown): void {
    this.calls.push(["setOptions", o]);
  }
  stabilize(): void {
    this.calls.push(["stabilize"]);
  }
  fit(o: unknown): void {
    this.calls.push(["fit", o]);
  }
  focus(id: string, o: unknown): void {
    this.calls.push(["focus", id, o]);
  }
  selectNodes(ids: string[]): void {
    this.calls.push(["selectNodes", ids]);
  }
}

interface Harness {
  win: any;
  doc: any;
  fetchLog: string[];
  datasets: FakeDataSet[];
  network: () => FakeNetwork | null;
}

/** Build a jsdom document from the shipped index.html and load the shipped app.js into it
 * with vis + fetch stubbed. Returns after `init()` has fully loaded the first project. */
async function boot(): Promise<Harness> {
  const { JSDOM } = await import(JSDOM_SPEC);
  const lib = await import(pathToFileURL(LIB_PATH).href);

  const html = readFileSync(INDEX_HTML, "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only" });
  const win = dom.window;
  const fetchLog: string[] = [];
  const datasets: FakeDataSet[] = [];
  const networks: FakeNetwork[] = [];

  // Every DataSet/Network app.js constructs registers itself (datasets in order: nodesDs
  // then edgesDs; app.js builds exactly one Network).
  const DataSet = class extends FakeDataSet {
    constructor(initial: Record<string, unknown>[] = []) {
      super(initial);
      datasets.push(this);
    }
  };
  const Network = class extends FakeNetwork {
    constructor() {
      super();
      networks.push(this);
    }
  };

  win.__lib = lib;
  win.vis = { DataSet, Network };
  win.fetch = (input: string): Promise<unknown> => {
    const url = new URL(input);
    fetchLog.push(url.pathname);
    const body = API[url.pathname];
    return Promise.resolve({
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      json: () => Promise.resolve(body ?? { error: { message: "not found" } }),
    });
  };

  // Ship app.js verbatim, minus the two lines that assume a real browser module loader:
  // the lib import (we inject lib as a global) and the auto-boot call (we call init()
  // ourselves so the test controls timing and can await the load).
  let src = readFileSync(APP_JS, "utf8");
  src = src.replace('import * as lib from "./lib.js";', "const lib = window.__lib;");
  src = src.replace("init().catch((err) => setHint(err.message));", "window.__init = init;");
  win.eval(src);

  await win.__init();
  return { win, doc: win.document, fetchLog, datasets, network: () => networks[networks.length - 1] ?? null };
}

/** Flush the microtask + macrotask queues so an event handler's async chain settles. */
function flush(win: any): Promise<void> {
  return new Promise((resolve) => win.setTimeout(resolve, 0));
}

test("(dom-1) project selector swaps the whole view (chips + graph) via /api on change", async () => {
  const h = await boot();
  const select = h.doc.getElementById("project-select");

  // init loaded proj-a: two projects listed, first selected, its chips + graph rendered.
  assert.deepEqual([...select.options].map((o: any) => o.value), ["proj-a", "proj-b"]);
  assert.equal(select.value, "proj-a");
  assert.equal(h.doc.getElementById("kind-chips").children.length, 2, "proj-a has 2 kind chips");
  assert.match(h.doc.getElementById("status").textContent ?? "", /2 nodos/);

  // Switch to proj-b: change event → selectProject re-fetches and re-renders everything.
  h.fetchLog.length = 0;
  select.value = "proj-b";
  select.dispatchEvent(new h.win.Event("change"));
  await flush(h.win);

  assert.ok(h.fetchLog.includes("/api/projects/proj-b/stats"), "switching fetched proj-b stats");
  assert.ok(h.fetchLog.includes("/api/projects/proj-b/graph"), "switching fetched proj-b graph");
  assert.equal(h.doc.getElementById("kind-chips").children.length, 1, "proj-b re-renders to its single chip");
  assert.match(h.doc.getElementById("status").textContent ?? "", /1 nodos/);
});

test("(dom-2) unchecking a kind chip hides those nodes and does NOT re-fetch", async () => {
  const h = await boot();
  const nodesDs = h.datasets[0]!; // module order: nodesDs first, edgesDs second

  const before = h.fetchLog.length;
  // The first chip is "function" (stats order). Uncheck its checkbox.
  const chip = h.doc.getElementById("kind-chips").querySelector("input[type=checkbox]");
  chip.checked = false;
  chip.dispatchEvent(new h.win.Event("change"));
  await flush(h.win);

  const nodes = nodesDs.get() as { id: string; _kind: string; hidden?: boolean }[];
  const fn = nodes.find((n) => n._kind === "function")!;
  const mod = nodes.find((n) => n._kind === "module")!;
  assert.equal(fn.hidden, true, "function node hidden after unchecking its chip");
  assert.equal(mod.hidden, false, "other kinds stay visible");
  assert.equal(h.fetchLog.length, before, "a visibility toggle must not hit the network");
});

test("(dom-3) label toggle flips the button + retints via setOptions, no re-fetch", async () => {
  const h = await boot();
  const btn = h.doc.getElementById("labels-toggle");
  assert.equal(btn.textContent, "ocultar etiquetas");

  const before = h.fetchLog.length;
  btn.click();
  await flush(h.win);

  assert.equal(btn.textContent, "mostrar etiquetas", "button label reflects the new state");
  const lastSetOptions = [...h.network()!.calls].reverse().find((c) => c[0] === "setOptions");
  assert.ok(lastSetOptions, "toggling labels calls network.setOptions");
  assert.match(JSON.stringify(lastSetOptions), /rgba\(0,0,0,0\)/, "labels off => transparent font");
  assert.equal(h.fetchLog.length, before, "label toggle is a local option flip, not a fetch");

  btn.click();
  await flush(h.win);
  assert.equal(btn.textContent, "ocultar etiquetas", "toggling again restores the label");
});

test("(dom-4) search submit fetches, focuses the first hit and opens its drawer", async () => {
  const h = await boot();
  const input = h.doc.getElementById("search-input");
  const form = h.doc.getElementById("search-form");

  input.value = "foo";
  form.dispatchEvent(new h.win.Event("submit", { cancelable: true, bubbles: true }));
  await flush(h.win);
  await flush(h.win); // selectNode chains a second round of fetches (detail + memories)

  assert.ok(h.fetchLog.some((p) => p === "/api/projects/proj-a/search"), "submit ran the search query");
  // Assert field-by-field, not deepEqual: the options object is created inside the jsdom
  // realm, so its prototype differs from this realm's and deepStrictEqual would reject it.
  const focused = h.network()!.calls.find((c) => c[0] === "focus");
  assert.ok(focused, "a node was focused on the canvas");
  assert.equal(focused[1], "f1", "the first search hit is the focused node");
  assert.ok(h.network()!.calls.some((c) => c[0] === "selectNodes"), "the focused node is selected");
  assert.ok(h.doc.getElementById("drawer").classList.contains("open"), "selecting the hit opens its detail drawer");
  assert.equal(h.doc.getElementById("drawer-title").textContent, "foo");
});
