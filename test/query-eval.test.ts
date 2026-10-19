// query-eval.test.ts — relevance evaluation of `query` on leina's own graph.
//
// Builds the graph of a copy of this repo's src/, test/ and scripts/ (never the checkout
// itself: a build writes .leina/), asks realistic questions and checks that the expected
// production symbols rank at the top. Thresholds, not exact rankings, so new symbols or
// extractor improvements don't break it; a rename of an expected symbol does — update the
// set. Reported metrics (t.diagnostic): mean precision@5, hit@5, MRR, share of test nodes.
// Run: node --no-warnings --experimental-strip-types --test test/query-eval.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { buildGraph } from "../src/application/graph/build.ts";
import { buildDefaultRegistry } from "../src/cli/wiring.ts";
import { queryGraph } from "../src/application/graph/query.ts";
import { isTestLikePath } from "../src/application/graph/test-paths.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// question → the production symbols (bare names) a good answer starts with.
const EVAL: readonly (readonly [string, readonly string[]])[] = [
  ["how does the hook resolve the project root", ["resolveHookProjectRoot"]],
  ["where is the MCP root confined", ["confineRoot", "confinePath"]],
  ["where is graph freshness checked", ["isStale", "openFreshStore", "graphStatus", "computeFreshnessNote"]],
  ["how are memory anchors verified", ["getVerifiedContext", "deriveAnchorState", "makeResolveAnchor", "anchorsFor"]],
  ["how is the shortest path between two symbols found", ["shortestPath", "expandPath", "reconstruct"]],
  ["how are node ids normalized", ["normalizeLabel", "makeId"]],
  ["where is the foreground build lock acquired", ["acquireForegroundBuildLock", "acquireLock", "acquireLockOrFail"]],
  ["how is workspace trust checked", ["isWorkspaceTrusted", "hasTrustRecord", "checkWorkspaceTrust"]],
  ["where is the consent flag read", ["readConsentFlag"]],
  ["how are graph communities detected", ["detectCommunities"]],
  ["how does the mcp server list its tools", ["listTools"]],
  ["how is a sidecar built", ["buildSidecar", "sidecarBuild"]],
  ["how does the stop hook nudge to save memory", ["emitStopNudge"]],
  ["how is the project key derived", ["deriveProjectKey"]],
  ["how are hook commands derived", ["deriveCliCommand"]],
  ["dónde se lee el consent flag", ["readConsentFlag"]],
];

test("(qeval-1) query ranks the expected production symbols first on leina's own graph", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "leina-query-eval-"));
  try {
    for (const sub of ["src", "test", "scripts"]) cpSync(join(REPO, sub), join(dir, sub), { recursive: true });
    mkdirSync(join(dir, ".leina"));
    const store = new GraphStore(join(dir, ".leina", "graph.db"));
    try {
      await buildGraph(dir, store, await buildDefaultRegistry());
      let p5 = 0;
      let hit5 = 0;
      let rr = 0;
      let testShare = 0;
      const misses: string[] = [];
      for (const [q, expected] of EVAL) {
        const nodes = queryGraph(store, q).nodes;
        const relevant = (i: number): boolean => {
          const n = nodes[i]!;
          return expected.includes(n.label.replace(/\(\)$/, "")) && !isTestLikePath(n.sourceFile);
        };
        const top5 = nodes.slice(0, 5).filter((_, i) => relevant(i)).length;
        const first = nodes.findIndex((_, i) => relevant(i));
        p5 += top5 / 5;
        hit5 += top5 > 0 ? 1 : 0;
        rr += first >= 0 ? 1 / (first + 1) : 0;
        testShare += nodes.length > 0 ? nodes.filter((n) => isTestLikePath(n.sourceFile)).length / nodes.length : 0;
        if (top5 === 0) misses.push(`${q} (first relevant at ${first})`);
      }
      const n = EVAL.length;
      t.diagnostic(
        `precision@5=${(p5 / n).toFixed(3)} hit@5=${(hit5 / n).toFixed(3)} MRR=${(rr / n).toFixed(3)} ` +
          `test-share=${(testShare / n).toFixed(3)} misses=${JSON.stringify(misses)}`,
      );
      assert.ok(hit5 / n >= 0.8, `hit@5 ${hit5}/${n}; misses: ${misses.join("; ")}`);
      assert.ok(rr / n >= 0.7, `MRR ${(rr / n).toFixed(3)}`);
      assert.equal(testShare, 0, "no test/mock/fixture node in a default answer");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
