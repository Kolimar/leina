// Unit tests for `memory reanchor` — extraction heuristic + resolution/minting, using
// MockMemoryRepository (zero real SQLite; the SQLite-level addAnchorsIfMissing contract is
// covered separately in test/memory.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockMemoryRepository } from "../mocks/memory.ts";
import {
  extractCandidateLabels,
  extractCandidates,
  isTestPath,
  reanchorObservations,
} from "../../src/application/memory/reanchor.ts";
import type { AnchorResolver } from "../../src/infrastructure/sqlite/memory-repository.ts";

// ---------------------------------------------------------------------------
// extractCandidateLabels — extraction heuristic in isolation
// ---------------------------------------------------------------------------

test("extractCandidateLabels: `path:symbol()` yields both the path and the symbol (FR-02 example)", () => {
  const labels = extractCandidateLabels("See `src/foo.ts:bar()` for details.");
  assert.deepEqual(labels, ["src/foo.ts", "bar"]);
});

test("extractCandidateLabels: bare backticked path is a candidate", () => {
  const labels = extractCandidateLabels("Edit `src/application/project/registry.ts` first.");
  assert.deepEqual(labels, ["src/application/project/registry.ts"]);
});

test("extractCandidateLabels: bare identifier (with or without call parens) is a candidate", () => {
  assert.deepEqual(extractCandidateLabels("Calls `openFreshStore`."), ["openFreshStore"]);
  assert.deepEqual(extractCandidateLabels("Calls `openFreshStore()`."), ["openFreshStore"]);
});

test("extractCandidateLabels: dotted identifier is a candidate", () => {
  assert.deepEqual(extractCandidateLabels("See `Foo.bar` for the method."), ["Foo.bar"]);
});

test("extractCandidateLabels: free prose inside backticks is NOT a candidate (no fuzzy/NLP)", () => {
  assert.deepEqual(extractCandidateLabels("The plan is `not code, just prose`."), []);
});

test("extractCandidateLabels: text with no backticks yields no candidates", () => {
  assert.deepEqual(extractCandidateLabels("openFreshStore does the thing, no code span here."), []);
});

test("extractCandidateLabels: duplicate mentions are de-duplicated", () => {
  const labels = extractCandidateLabels("`computeTotal` is called by `computeTotal` again.");
  assert.deepEqual(labels, ["computeTotal"]);
});

// ---------------------------------------------------------------------------
// reanchorObservations — resolution + minting against a fake live-graph resolver
// ---------------------------------------------------------------------------

function makeResolver(table: Record<string, { nodeId: string; sourceFile: string }[]>): AnchorResolver {
  return (label: string) => table[label] ?? [];
}

test("reanchorObservations: mints an anchor for a candidate that resolves to exactly one node", () => {
  const repo = new MockMemoryRepository();
  const { observation } = repo.save({
    title: "Note",
    content: "See `openFreshStore` for the freshness gate.",
    type: "architecture",
  });
  const resolve = makeResolver({
    openFreshStore: [{ nodeId: "n1", sourceFile: "src/cli/wiring.ts" }],
  });

  const report = reanchorObservations(repo, resolve);

  assert.equal(report.processed, 1);
  assert.equal(report.minted, 1);
  assert.equal(report.rejected, 0);
  assert.equal(repo.anchorsForObservation(observation.id).length, 1);
  assert.equal(repo.anchorsForObservation(observation.id)[0]!.nodeId, "n1");
});

test("reanchorObservations: ambiguous candidate (2+ matches) is rejected, never guessed", () => {
  const repo = new MockMemoryRepository();
  const { observation } = repo.save({
    title: "Note",
    content: "Calls `computeTotal` somewhere.",
    type: "architecture",
  });
  const resolve = makeResolver({
    computeTotal: [
      { nodeId: "n1", sourceFile: "src/a.ts" },
      { nodeId: "n2", sourceFile: "src/b.ts" },
    ],
  });

  const report = reanchorObservations(repo, resolve);

  assert.equal(report.minted, 0);
  assert.equal(report.rejected, 1);
  assert.equal(report.items[0]!.rejected[0]!.reason, "ambiguous — resolves to 2 nodes");
  assert.equal(repo.anchorsForObservation(observation.id).length, 0);
});

test("reanchorObservations: unresolved candidate (no match) is rejected", () => {
  const repo = new MockMemoryRepository();
  repo.save({ title: "Note", content: "Uses `ghostFn` maybe.", type: "architecture" });
  const resolve = makeResolver({});

  const report = reanchorObservations(repo, resolve);

  assert.equal(report.minted, 0);
  assert.equal(report.rejected, 1);
  assert.equal(report.items[0]!.rejected[0]!.reason, "no match found in the live graph");
});

test("reanchorObservations: idempotent — re-running after a successful mint mints nothing new", () => {
  const repo = new MockMemoryRepository();
  repo.save({ title: "Note", content: "See `openFreshStore` here.", type: "architecture" });
  const resolve = makeResolver({
    openFreshStore: [{ nodeId: "n1", sourceFile: "src/cli/wiring.ts" }],
  });

  const first = reanchorObservations(repo, resolve);
  assert.equal(first.minted, 1);

  const second = reanchorObservations(repo, resolve);
  assert.equal(second.minted, 0, "re-running must not duplicate the anchor");
  assert.equal(second.rejected, 1, "the candidate is now rejected as already-anchored");
  assert.equal(second.items[0]!.rejected[0]!.reason, "already anchored to this node");
});

test("reanchorObservations: --dry-run reports what would happen but writes nothing", () => {
  const repo = new MockMemoryRepository();
  const { observation } = repo.save({
    title: "Note",
    content: "See `openFreshStore` here.",
    type: "architecture",
  });
  const resolve = makeResolver({
    openFreshStore: [{ nodeId: "n1", sourceFile: "src/cli/wiring.ts" }],
  });

  const report = reanchorObservations(repo, resolve, { dryRun: true });

  assert.equal(report.minted, 1, "dry-run still reports the prediction");
  assert.equal(repo.anchorsForObservation(observation.id).length, 0, "dry-run must not write");

  // Running it again (still dry-run) predicts the SAME mint, since nothing was written.
  const again = reanchorObservations(repo, resolve, { dryRun: true });
  assert.equal(again.minted, 1);
});

test("reanchorObservations: an observation already anchored to a node is not re-anchored to it", () => {
  const repo = new MockMemoryRepository();
  const { observation } = repo.save({
    title: "Note",
    content: "See `openFreshStore` here.",
    type: "architecture",
  });
  repo.addAnchorsIfMissing(observation.id, [{ nodeId: "n1", anchorLabel: "manual" }]);
  const resolve = makeResolver({
    openFreshStore: [{ nodeId: "n1", sourceFile: "src/cli/wiring.ts" }],
  });

  const report = reanchorObservations(repo, resolve);

  assert.equal(report.minted, 0);
  assert.equal(report.rejected, 1);
  assert.equal(repo.anchorsForObservation(observation.id).length, 1, "no duplicate anchor row");
});

test("reanchorObservations: processed/minted/rejected counters always square up", () => {
  const repo = new MockMemoryRepository();
  repo.save({
    title: "Mixed note",
    content: "Uses `openFreshStore`, calls `computeTotal`, and references `ghostFn`.",
    type: "architecture",
  });
  const resolve = makeResolver({
    openFreshStore: [{ nodeId: "n1", sourceFile: "src/cli/wiring.ts" }],
    computeTotal: [
      { nodeId: "n2", sourceFile: "src/a.ts" },
      { nodeId: "n3", sourceFile: "src/b.ts" },
    ],
  });

  const report = reanchorObservations(repo, resolve);

  assert.equal(report.processed, 3);
  assert.equal(report.minted + report.rejected, report.processed);
  assert.equal(report.minted, 1);
  assert.equal(report.rejected, 2);
});

test("reanchorObservations: observations with no candidates are skipped without noise", () => {
  const repo = new MockMemoryRepository();
  repo.save({ title: "Plain note", content: "Nothing code-like here at all.", type: "architecture" });
  const resolve = makeResolver({});

  const report = reanchorObservations(repo, resolve);

  assert.equal(report.processed, 0);
  assert.equal(report.minted, 0);
  assert.equal(report.rejected, 0);
  assert.equal(report.items.length, 0);
});

// ---------------------------------------------------------------------------
// 3.0: no junk anchors, production code first, file-level → symbol upgrades
// ---------------------------------------------------------------------------

test("(reanchor-junk-1) short and generic identifiers are not candidates", () => {
  assert.deepEqual(
    extractCandidateLabels("Uses `fn`, `p`, `id`, `get`, `query`, `npm`, `Foo` and `foo` around `computeTotal`."),
    ["computeTotal"],
  );
  // A dotted identifier is qualified already: kept even when its last segment is generic.
  assert.deepEqual(extractCandidateLabels("See `GraphStore.close`."), ["GraphStore.close"]);
});

test("(reanchor-junk-2) `path:symbol` resolves the symbol within that file only", () => {
  assert.deepEqual(extractCandidates("See `src/foo.ts:get()`."), [
    { label: "src/foo.ts" },
    { label: "get", file: "src/foo.ts" },
  ]);
  const repo = new MockMemoryRepository();
  const { observation } = repo.save({ title: "Note", content: "See `src/foo.ts:get()`.", type: "architecture" });
  const resolve = makeResolver({
    "src/foo.ts": [{ nodeId: "foo_module", sourceFile: "src/foo.ts" }],
    get: [
      { nodeId: "foo:get", sourceFile: "src/foo.ts" },
      { nodeId: "bar:get", sourceFile: "src/bar.ts" },
    ],
  });
  const report = reanchorObservations(repo, resolve);
  assert.equal(report.minted, 2);
  assert.deepEqual(
    repo.anchorsForObservation(observation.id).map((a) => a.nodeId).sort(),
    ["foo:get", "foo_module"],
  );
});

test("(reanchor-junk-3) a bare identifier prefers production code and is never anchored to test code alone", () => {
  const repo = new MockMemoryRepository();
  const { observation } = repo.save({
    title: "Note",
    content: "`computeTotal` sums; `withTempHome` isolates.",
    type: "architecture",
  });
  const resolve = makeResolver({
    computeTotal: [
      { nodeId: "src:computeTotal", sourceFile: "src/total.ts" },
      { nodeId: "test:computeTotal", sourceFile: "test/total.test.ts" },
    ],
    withTempHome: [{ nodeId: "test:withTempHome", sourceFile: "test/helpers/home.ts" }],
  });
  const report = reanchorObservations(repo, resolve);
  assert.equal(report.minted, 1);
  assert.deepEqual(repo.anchorsForObservation(observation.id).map((a) => a.nodeId), ["src:computeTotal"]);
  assert.match(report.items[0]!.rejected[0]!.reason, /only test code/);
  assert.equal(isTestPath("test/x.ts"), true);
  assert.equal(isTestPath("src/a.spec.ts"), true);
  assert.equal(isTestPath("src/contest.ts"), false);
});

test("(reanchor-up-1) file-level anchors are upgraded in place; dry-run and re-runs write nothing new", () => {
  const repo = new MockMemoryRepository();
  const { observation } = repo.save({ title: "Plain", content: "no code spans", type: "architecture" });
  const FILE_HASH = "f".repeat(64);
  repo.addAnchorsIfMissing(observation.id, [
    { nodeId: "n1", anchorLabel: "alpha", anchorFile: "src/a.ts", anchorHash: FILE_HASH },
    { nodeId: "n2", anchorLabel: "src/a.ts", anchorFile: "src/a.ts", anchorHash: FILE_HASH },
    { nodeId: "n3", anchorLabel: "beta", anchorFile: "src/b.ts", anchorHash: `sym1:${"0".repeat(64)}` },
  ]);
  const seen: string[] = [];
  const upgradeAnchor = (a: { nodeId: string; anchorHash?: string }): string | null => {
    seen.push(a.nodeId);
    return a.nodeId === "n1" ? `sym1:${"1".repeat(64)}` : null; // n2 is a module: stays file-level
  };

  const dry = reanchorObservations(repo, makeResolver({}), { dryRun: true, upgradeAnchor });
  assert.equal(dry.upgraded, 1);
  assert.deepEqual(dry.items[0]!.upgraded, [{ nodeId: "n1", label: "alpha" }]);
  assert.deepEqual(seen, ["n1", "n2"], "only file-level anchors are offered to the upgrader");
  assert.equal(repo.anchorsForObservation(observation.id).find((a) => a.nodeId === "n1")!.anchorHash, FILE_HASH);

  const real = reanchorObservations(repo, makeResolver({}), { upgradeAnchor });
  assert.equal(real.upgraded, 1);
  assert.equal(repo.anchorsForObservation(observation.id).find((a) => a.nodeId === "n1")!.anchorHash, `sym1:${"1".repeat(64)}`);

  const again = reanchorObservations(repo, makeResolver({}), { upgradeAnchor });
  assert.equal(again.upgraded, 0, "an upgraded anchor is no longer file-level");
  assert.deepEqual(again.items, []);
});
