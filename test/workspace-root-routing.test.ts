// workspace-root-routing.test.ts — the single-repo graph paths hand a multi-repo workspace
// root to the workspace build instead of building it as one repo.
//
// Built as one repo, a workspace root indexes none of its members (nested repositories are
// skipped) and overwrites the merged graph with an empty one: `leina query <ws>` used to do
// exactly that through its stale-graph rebuild, and `leina build <ws>` on purpose.
// Run: node --no-warnings --experimental-strip-types --test test/workspace-root-routing.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isWorkspaceRoot } from "../src/application/project/detect-key.ts";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function gitRepo(dir: string, file: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
  assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
}

function mergedNodeCount(wsRoot: string): number {
  const s = new GraphStore(join(wsRoot, ".leina", "graph.db"));
  try {
    return s.stats().nodes;
  } finally {
    s.close();
  }
}

test("(wsr-1) isWorkspaceRoot: a non-git dir with ≥2 child repos or a workspace.json; never a git repo", () => {
  const base = mkdtempSync(join(tmpdir(), "leina-wsr1-"));
  try {
    const ws = join(base, "ws");
    gitRepo(join(ws, "a"), "a.ts", "export const a = 1;\n");
    assert.equal(isWorkspaceRoot(ws), false, "one child repo is not a workspace");
    gitRepo(join(ws, "b"), "b.ts", "export const b = 1;\n");
    assert.equal(isWorkspaceRoot(ws), true, "two child repos");
    assert.equal(isWorkspaceRoot(join(ws, "a")), false, "a member is its own repo");

    const declared = join(base, "declared");
    mkdirSync(declared);
    writeFileSync(join(declared, "workspace.json"), "{}");
    assert.equal(isWorkspaceRoot(declared), true, "workspace.json declares one");

    // A git repo is never routed: an Nx monorepo ships a workspace.json, and a repo may hold
    // nested clones; its own single-repo graph must keep working.
    const mono = join(base, "mono");
    gitRepo(mono, "workspace.json", "{\"version\": 2}");
    gitRepo(join(mono, "x"), "x.ts", "export const x = 1;\n");
    gitRepo(join(mono, "y"), "y.ts", "export const y = 1;\n");
    assert.equal(isWorkspaceRoot(mono), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("(wsr-2) query, build, refresh and status on a workspace root keep the merged graph", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-wsr2-home-"));
  const ws = mkdtempSync(join(tmpdir(), "leina-wsr2-ws-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, LEINA_HOME: join(home, ".leina") };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
      env,
      encoding: "utf8",
    });
  try {
    gitRepo(join(ws, "a"), "a.ts", "export function alphaFn(): number { return 1; }\n");
    gitRepo(join(ws, "b"), "b.ts", "export function betaFn(): number { return 2; }\n");

    // No graph yet: the read path builds the members and merges them.
    const q = run("query", ws, "alphaFn");
    assert.equal(q.status, 0, q.stderr);
    assert.match(q.stdout, /alphaFn\(\)/, "the merged graph answers");
    const merged = mergedNodeCount(ws);
    assert.ok(merged >= 2, `both members merged (got ${merged} nodes)`);

    for (const cmd of ["build", "refresh"]) {
      const r = run(cmd, ws);
      assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
      assert.match(r.stdout, /multi-repo workspace root/, `${cmd} says what it does`);
      assert.equal(mergedNodeCount(ws), merged, `${cmd} keeps the merged graph`);
    }

    const st = run("status", ws);
    assert.equal(st.status, 0, st.stderr);
    assert.match(st.stdout, /mode: workspace \(2 members/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
