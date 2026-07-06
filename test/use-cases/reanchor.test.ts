// Unit tests for `memory reanchor` — extraction heuristic + resolution/minting, using
// MockMemoryRepository (zero real SQLite; the SQLite-level addAnchorsIfMissing contract is
// covered separately in test/memory.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockMemoryRepository } from "../mocks/memory.ts";
import {
  extractCandidateLabels,
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
  const labels = extractCandidateLabels("`foo` is called by `foo` again.");
  assert.deepEqual(labels, ["foo"]);
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
    content: "Calls `run` somewhere.",
    type: "architecture",
  });
  const resolve = makeResolver({
    run: [
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
    content: "Uses `openFreshStore`, calls `run`, and references `ghostFn`.",
    type: "architecture",
  });
  const resolve = makeResolver({
    openFreshStore: [{ nodeId: "n1", sourceFile: "src/cli/wiring.ts" }],
    run: [
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
