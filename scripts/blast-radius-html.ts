// scripts/blast-radius-html.ts — One-off: export the blast radius of a symbol as a
// self-contained HTML subgraph (same renderer as `leina visualize`).
//
// Usage:
//   node --no-warnings --experimental-strip-types scripts/blast-radius-html.ts <symbol> [out] [depth]
//
// Builds the subgraph = seed node + everything that depends on it (transitive blast
// radius via the same `affected` walk the CLI uses), then renders it with renderGraphHtml.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openFreshStore } from "../src/cli/wiring.ts";
import { affected, resolveSeed } from "../src/application/graph/query.ts";
import { renderGraphHtml } from "../src/application/graph/html-export.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";

const symbol = process.argv[2] ?? "SQLiteMemoryRepository";
const out = resolve(process.argv[3] ?? "docs/blast-radius.html");
const depth = process.argv[4] ? Number(process.argv[4]) : 6;
const root = resolve(".");

const visJs = readFileSync(
  join(root, "assets", "vis-network", "vis-network.min.js"),
  "utf8",
);

const store = await openFreshStore(root);
try {
  const seed = resolveSeed(store, symbol);
  if (!seed) {
    console.error(`No node matches "${symbol}"`);
    process.exit(1);
  }

  // Included set: the seed + every dependent in its blast radius.
  const hits = affected(store, seed.id, depth);
  const included = new Set<string>([seed.id, ...hits.map((h) => h.node.id)]);

  const nodes: GraphNode[] = [...included]
    .map((id) => store.getNode(id))
    .filter((n): n is GraphNode => Boolean(n));

  // Keep edges whose endpoints are both inside the subgraph (incl. contains, for context).
  const links: GraphEdge[] = store
    .allEdges()
    .filter((e) => included.has(e.source) && included.has(e.target));

  const graph = {
    directed: true,
    multigraph: false,
    graph: {},
    nodes,
    links,
  };

  const artifact = renderGraphHtml(graph, visJs, {
    projectName: `${seed.label} — blast radius`,
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, artifact.content, "utf8");
  console.log(
    `Blast radius of ${seed.label}: ${nodes.length} nodes, ${links.length} edges -> ${out}`,
  );
} finally {
  store.close();
}
