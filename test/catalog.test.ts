// catalog.test.ts — the asset catalog and pure selection resolution
// (src/application/install/catalog.ts + assets/catalog.json contents).
// Run: node --no-warnings --experimental-strip-types --test test/catalog.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deserializeSelection,
  parseCatalog,
  resolveSelection,
  sameSelection,
  serializeSelection,
} from "../src/application/install/catalog.ts";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const catalog = parseCatalog(readFileSync(`${ASSETS}catalog.json`, "utf8"));

// ---------------------------------------------------------------------------
// (cat-a) The catalog matches what actually ships in assets/
// ---------------------------------------------------------------------------

test("(cat-a1) every skill dir in assets/skills is cataloged, and vice versa", () => {
  const onDisk = readdirSync(`${ASSETS}skills`, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const cataloged = catalog.assets.filter((a) => a.kind === "skill").map((a) => a.id).sort();
  assert.deepEqual(cataloged, onDisk);
});

test("(cat-a2) every agent .md in assets/agents is cataloged, and vice versa", () => {
  const onDisk = readdirSync(`${ASSETS}agents`)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  const cataloged = catalog.assets.filter((a) => a.kind === "agent").map((a) => a.id).sort();
  assert.deepEqual(cataloged, onDisk);
});

test("(cat-a3) every requires edge points at a cataloged asset", () => {
  const keys = new Set(catalog.assets.map((a) => `${a.kind}:${a.id}`));
  for (const a of catalog.assets) {
    for (const dep of a.requires ?? []) {
      assert.ok(keys.has(dep), `${a.kind}:${a.id} requires unknown ${dep}`);
    }
  }
});

// ---------------------------------------------------------------------------
// (cat-b) Preset resolution
// ---------------------------------------------------------------------------

test("(cat-b1) preset full → no filtering (null selection)", () => {
  const r = resolveSelection(catalog, { preset: "full" });
  assert.deepEqual(r.selection, { skills: null, agents: null });
});

test("(cat-b2) preset minimal → only the core group", () => {
  const r = resolveSelection(catalog, { preset: "minimal" });
  assert.deepEqual(r.selection.skills, ["_shared", "leina-setup"]);
  assert.deepEqual(r.selection.agents, []);
});

test("(cat-b3) preset sdd → core + all sdd skills and agents", () => {
  const r = resolveSelection(catalog, { preset: "sdd" });
  assert.ok(r.selection.skills!.includes("leina-sdd"));
  assert.ok(r.selection.skills!.includes("sdd-explore"));
  assert.ok(r.selection.skills!.includes("leina-setup"));
  assert.ok(!r.selection.skills!.includes("github-pr"));
  assert.equal(r.selection.agents!.length, 8);
  assert.ok(r.selection.agents!.every((a) => a.startsWith("sdd-")));
});

test("(cat-b4) unknown preset throws with the known preset names", () => {
  assert.throws(() => resolveSelection(catalog, { preset: "nope" }), /unknown --preset "nope".*minimal/);
});

// ---------------------------------------------------------------------------
// (cat-c) Explicit selection: closure, required assets, sentinels, validation
// ---------------------------------------------------------------------------

test("(cat-c1) selecting a delegator skill pulls in its agent (dependency closure)", () => {
  const r = resolveSelection(catalog, { skills: ["sdd-explore"], agents: ["none"] });
  assert.deepEqual(r.selection.agents, ["sdd-explore"]);
  assert.ok(r.autoAdded.includes("agent:sdd-explore"));
});

test("(cat-c2) leina-sdd pulls the whole phase chain transitively", () => {
  const r = resolveSelection(catalog, { skills: ["leina-sdd"], agents: ["none"] });
  for (const phase of ["sdd-explore", "sdd-spec", "sdd-archive"]) {
    assert.ok(r.selection.skills!.includes(phase), `skill ${phase}`);
    assert.ok(r.selection.agents!.includes(phase), `agent ${phase}`);
  }
});

test("(cat-c3) required core assets are always included", () => {
  const r = resolveSelection(catalog, { skills: ["graph-viz"], agents: ["none"] });
  assert.ok(r.selection.skills!.includes("leina-setup"));
  assert.ok(r.selection.skills!.includes("_shared"));
});

test("(cat-c4) sentinels: all → null, none → only required", () => {
  const r = resolveSelection(catalog, { skills: ["none"], agents: ["all"] });
  assert.deepEqual(r.selection.skills, ["_shared", "leina-setup"]);
  assert.equal(r.selection.agents, null);
});

test("(cat-c5) unknown skill/agent names are hard errors", () => {
  assert.throws(() => resolveSelection(catalog, { skills: ["grph-viz"] }), /unknown skill "grph-viz"/);
  assert.throws(() => resolveSelection(catalog, { agents: ["sdd-explor"] }), /unknown agent "sdd-explor"/);
});

test("(cat-c6) preset combined with explicit lists is rejected", () => {
  assert.throws(() => resolveSelection(catalog, { preset: "sdd", skills: ["graph-viz"] }), /not both/);
});

test("(cat-c7) no input at all → everything (back-compat)", () => {
  assert.deepEqual(resolveSelection(catalog, {}).selection, { skills: null, agents: null });
});

// ---------------------------------------------------------------------------
// (cat-d) Persistence round-trip
// ---------------------------------------------------------------------------

test("(cat-d1) serialize/deserialize round-trips and sameSelection compares by set", () => {
  const sel = { skills: ["b", "a"], agents: null };
  const back = deserializeSelection(serializeSelection(sel))!;
  assert.ok(sameSelection(sel, back));
  assert.ok(sameSelection({ skills: ["a", "b"], agents: null }, back));
  assert.ok(!sameSelection({ skills: ["a"], agents: null }, back));
  assert.ok(!sameSelection({ skills: null, agents: null }, back));
  assert.equal(deserializeSelection("not json"), null);
  assert.equal(deserializeSelection(null), null);
});
