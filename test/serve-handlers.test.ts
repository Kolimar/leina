// serve-handlers.test.ts — integration tests for the 6 `graph serve` JSON API endpoints
// (task 3.5): cli/serve/handlers.ts wired through the real HTTP router against a real
// graph.db + memory.db fixture on disk (project registry + GraphStore + Memory
// repository), driven with fetch against an ephemeral port (0 → OS assigns).
// Run: node --no-warnings --experimental-strip-types --test test/serve-handlers.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../src/cli/serve/router.ts";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";
import { recordProject } from "../src/infrastructure/config/project-registry-store.ts";
import { deriveProjectKey } from "../src/application/project/detect-key.ts";
import type { GraphEdge, GraphNode } from "../src/domain/graph/model.ts";

function node(over: Partial<GraphNode> & { id: string; label: string; sourceFile: string }): GraphNode {
  return { fileType: "code", ...over };
}
function edge(over: Partial<GraphEdge> & { source: string; target: string; relation: string }): GraphEdge {
  return { confidence: "EXTRACTED", sourceFile: "x", weight: 1, ...over };
}

interface Fixture {
  home: string;
  root: string;
  projectKey: string;
  server: Server;
  baseUrl: string;
}

/**
 * Build a real project: `<root>/.leina/graph.db` (fixture nodes/edges) + a matching
 * entry in `<home>/projects.json` (via $LEINA_HOME) + an anchored memory in the global
 * memory.db keyed by the SAME project key `openMemoryRepo`/`openGraphRepo` will derive
 * at request time. Then serves it through the real router on an ephemeral port.
 */
async function buildFixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "leina-serve-home-"));
  const root = mkdtempSync(join(tmpdir(), "leina-serve-proj-"));
  process.env.LEINA_HOME = home;

  mkdirSync(join(root, ".leina"), { recursive: true });
  // A real source file on disk, matching the node's sourceFile — makeVerifyNode (wired
  // through openMemoryRepo) hashes the ACTUAL file at read time, so the anchor below is
  // stamped with the matching hash to get a genuine "usable" verdict (not a fake one).
  mkdirSync(join(root, "src", "domain"), { recursive: true });
  const fileContent = "export function target() { /* memoized */ }\n";
  writeFileSync(join(root, "src", "domain", "file.ts"), fileContent, "utf8");
  const fileHash = createHash("sha256").update(fileContent).digest("hex");

  const graph = new GraphStore(join(root, ".leina", "graph.db"));
  graph.addNodes([
    node({ id: "mod:file", label: "file.ts", sourceFile: "src/domain/file.ts", kind: "module" }),
    node({ id: "fn:target", label: "target", sourceFile: "src/domain/file.ts", kind: "function" }),
    node({ id: "fn:caller", label: "caller", sourceFile: "src/application/other.ts", kind: "function" }),
  ]);
  graph.addEdges([
    edge({ source: "mod:file", target: "fn:target", relation: "contains" }),
    edge({ source: "fn:caller", target: "fn:target", relation: "calls" }),
  ]);
  graph.close();

  const projectKey = deriveProjectKey(root).key;
  recordProject({ projectKey, root, lastBuild: Date.now() });

  const mem = new SQLiteMemoryRepository(join(home, "memory.db"), projectKey);
  const { observation } = mem.save({
    title: "Target memoizes",
    content: "fn:target caches its result.",
    type: "architecture",
  });
  mem.addAnchorsIfMissing(observation.id, [
    { nodeId: "fn:target", anchorFile: "src/domain/file.ts", anchorHash: fileHash },
  ]);
  mem.close();

  const server = createServer(createRouter({ assetsRoot: join(root, "no-assets") }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no server address");
  return { home, root, projectKey, server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function withFixture<T>(use: (f: Fixture) => Promise<T>): Promise<T> {
  const savedHome = process.env.LEINA_HOME;
  const f = await buildFixture();
  try {
    return await use(f);
  } finally {
    await new Promise<void>((resolve) => f.server.close(() => resolve()));
    rmSync(f.home, { recursive: true, force: true });
    rmSync(f.root, { recursive: true, force: true });
    if (savedHome !== undefined) process.env.LEINA_HOME = savedHome;
    else delete process.env.LEINA_HOME;
  }
}

// ---------------------------------------------------------------------------
// GET /api/projects — FR-01/FR-06
// ---------------------------------------------------------------------------

test("(sh-1) GET /api/projects lists the registered project", async () => {
  await withFixture(async (f) => {
    const res = await fetch(`${f.baseUrl}/api/projects`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { projects: { projectKey: string; root: string }[] };
    assert.ok(body.projects.some((p) => p.projectKey === f.projectKey && p.root === f.root));
  });
});

test("(sh-2) GET /api/projects omits a registered project whose root no longer exists", async () => {
  await withFixture(async (f) => {
    const ghostRoot = join(f.root, "ghost-that-never-existed");
    recordProject({ projectKey: "ghost-project", root: ghostRoot, lastBuild: Date.now() });
    const res = await fetch(`${f.baseUrl}/api/projects`);
    const body = (await res.json()) as { projects: { projectKey: string }[] };
    assert.ok(!body.projects.some((p) => p.projectKey === "ghost-project"), "unavailable root filtered out");
  });
});

// ---------------------------------------------------------------------------
// Unknown project key → 400 PROJECT_NOT_FOUND (FR-06/FR-07), across every :key route
// ---------------------------------------------------------------------------

test("(sh-3) unknown project key → 400 PROJECT_NOT_FOUND on every :key-scoped endpoint", async () => {
  await withFixture(async (f) => {
    const routes = ["stats", "tree", "search?q=x", "nodes/fn:target", "nodes/fn:target/memories"];
    for (const route of routes) {
      const res = await fetch(`${f.baseUrl}/api/projects/does-not-exist/${route}`);
      assert.equal(res.status, 400, route);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, "PROJECT_NOT_FOUND", route);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:key/stats — FR-06/FR-14
// ---------------------------------------------------------------------------

test("(sh-4) GET .../stats returns byKind/byRelation over the fixture graph", async () => {
  await withFixture(async (f) => {
    const res = await fetch(`${f.baseUrl}/api/projects/${f.projectKey}/stats`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      byKind: { kind: string; count: number }[];
      byRelation: { relation: string; count: number }[];
    };
    assert.deepEqual(
      body.byKind.sort((a, b) => a.kind.localeCompare(b.kind)),
      [{ kind: "function", count: 2 }, { kind: "module", count: 1 }],
    );
    assert.deepEqual(
      body.byRelation.sort((a, b) => a.relation.localeCompare(b.relation)),
      [{ relation: "calls", count: 1 }, { relation: "contains", count: 1 }],
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:key/tree — FR-06/FR-10
// ---------------------------------------------------------------------------

test("(sh-5) GET .../tree derives a folder tree from sourceFile", async () => {
  await withFixture(async (f) => {
    const res = await fetch(`${f.baseUrl}/api/projects/${f.projectKey}/tree`);
    assert.equal(res.status, 200);
    interface Tree { path: string; children: Tree[] }
    const body = (await res.json()) as { tree: Tree };
    assert.equal(body.tree.path, "");
    // Both fixture files live under src/{application,domain}/*.ts — the root only has
    // one direct child ("src"); the two leaves are one level further down.
    assert.equal(body.tree.children.length, 1);
    assert.equal(body.tree.children[0]!.path, "src");
    assert.deepEqual(
      body.tree.children[0]!.children.map((c) => c.path).sort(),
      ["src/application", "src/domain"],
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:key/search?q= — FR-06
// ---------------------------------------------------------------------------

test("(sh-6) GET .../search finds a node by label", async () => {
  await withFixture(async (f) => {
    const res = await fetch(`${f.baseUrl}/api/projects/${f.projectKey}/search?q=target`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: { id: string; label: string }[] };
    assert.ok(body.results.some((r) => r.id === "fn:target"));
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:key/nodes/:id — FR-06/FR-07/FR-11
// ---------------------------------------------------------------------------

test("(sh-7) GET .../nodes/:id returns declaredBy/invokedBy", async () => {
  await withFixture(async (f) => {
    const res = await fetch(`${f.baseUrl}/api/projects/${f.projectKey}/nodes/fn:target`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      node: { id: string };
      declaredBy: { id: string }[];
      invokedBy: { id: string }[];
    };
    assert.equal(body.node.id, "fn:target");
    assert.deepEqual(body.declaredBy.map((r) => r.id), ["mod:file"]);
    assert.deepEqual(body.invokedBy.map((r) => r.id), ["fn:caller"]);
  });
});

test("(sh-8) GET .../nodes/:id on a missing node → 404 NODE_NOT_FOUND", async () => {
  await withFixture(async (f) => {
    const res = await fetch(`${f.baseUrl}/api/projects/${f.projectKey}/nodes/does-not-exist`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "NODE_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:key/nodes/:id/memories?limit= — FR-06/FR-12
// ---------------------------------------------------------------------------

test("(sh-9) GET .../memories returns the anchored memory with a drift badge", async () => {
  await withFixture(async (f) => {
    const res = await fetch(`${f.baseUrl}/api/projects/${f.projectKey}/nodes/fn:target/memories`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { memories: { observationId: string; driftState: string; text: string }[] };
    assert.equal(body.memories.length, 1);
    assert.match(body.memories[0]!.text, /Target memoizes/);
    assert.equal(body.memories[0]!.driftState, "usable");
  });
});

test("(sh-10) GET .../memories on a node with no anchors → empty array, not an error", async () => {
  await withFixture(async (f) => {
    const res = await fetch(`${f.baseUrl}/api/projects/${f.projectKey}/nodes/fn:caller/memories`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { memories: unknown[] };
    assert.deepEqual(body.memories, []);
  });
});

test("(sh-11) GET .../memories?limit=1 forwards the limit", async () => {
  await withFixture(async (f) => {
    // Anchor a second observation onto the same node so limit actually has something to cap.
    const home = f.home;
    const mem = new SQLiteMemoryRepository(join(home, "memory.db"), f.projectKey);
    const { observation } = mem.save({ title: "Second note", content: "more context", type: "discovery" });
    mem.addAnchorsIfMissing(observation.id, [{ nodeId: "fn:target" }]);
    mem.close();

    const res = await fetch(`${f.baseUrl}/api/projects/${f.projectKey}/nodes/fn:target/memories?limit=1`);
    const body = (await res.json()) as { memories: unknown[] };
    assert.equal(body.memories.length, 1);
  });
});
