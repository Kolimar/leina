// project-registry.test.ts — unit tests for the global project registry:
// src/application/project/registry.ts (pure merge) and
// src/infrastructure/config/project-registry-store.ts (~/.leina/projects.json r/w).
// Run: node --no-warnings --experimental-strip-types --test test/project-registry.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pruneRegistry,
  upsertProject,
  withAvailability,
  type ProjectEntry,
} from "../src/application/project/registry.ts";
import {
  projectRegistryPath,
  readProjectRegistry,
  writeProjectRegistry,
  recordProject,
} from "../src/infrastructure/config/project-registry-store.ts";
import { handleGraphGc } from "../src/cli/handlers/graph.ts";

// ---------------------------------------------------------------------------
// upsertProject — pure merge, keyed by root
// ---------------------------------------------------------------------------

function entry(root: string, over: Partial<ProjectEntry> = {}): ProjectEntry {
  return { projectKey: `key-${root}`, root, lastBuild: 1, ...over };
}

test("upsertProject: new root is appended", () => {
  const list = upsertProject([], entry("/repo/a"));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.root, "/repo/a");
});

test("upsertProject: same root replaces the entry (no duplicate) and advances lastBuild", () => {
  const first = upsertProject([], entry("/repo/a", { lastBuild: 100 }));
  const second = upsertProject(first, entry("/repo/a", { lastBuild: 200 }));
  assert.equal(second.length, 1, "re-building the same root must not duplicate the row");
  assert.equal(second[0]!.lastBuild, 200);
});

test("upsertProject: 2+ entries are all preserved and listed", () => {
  let list = upsertProject([], entry("/repo/a"));
  list = upsertProject(list, entry("/repo/b"));
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((p) => p.root).sort(), ["/repo/a", "/repo/b"]);
});

test("upsertProject: is pure — does not mutate the input list", () => {
  const list = [entry("/repo/a", { lastBuild: 1 })];
  const snapshot = JSON.stringify(list);
  upsertProject(list, entry("/repo/a", { lastBuild: 999 }));
  assert.equal(JSON.stringify(list), snapshot, "input list must be unchanged");
});

// ---------------------------------------------------------------------------
// withAvailability — never deletes, only annotates
// ---------------------------------------------------------------------------

test("withAvailability: existing root is untouched (no unavailable flag)", () => {
  const list = [entry("/repo/a")];
  const out = withAvailability(list, () => true);
  assert.equal(out[0]!.unavailable, undefined);
});

test("withAvailability: missing root is flagged unavailable, never dropped", () => {
  const list = [entry("/repo/a"), entry("/repo/b")];
  const out = withAvailability(list, (root) => root !== "/repo/b");
  assert.equal(out.length, 2, "roots are annotated, not removed");
  assert.equal(out.find((p) => p.root === "/repo/a")!.unavailable, undefined);
  assert.equal(out.find((p) => p.root === "/repo/b")!.unavailable, true);
});

// ---------------------------------------------------------------------------
// pruneRegistry — explicit GC: partitions kept vs removed, never mutates input
// ---------------------------------------------------------------------------

test("pruneRegistry: partitions into existing (kept) and vanished (removed)", () => {
  const list = [entry("/repo/a"), entry("/repo/gone"), entry("/repo/b")];
  const { kept, removed } = pruneRegistry(list, (root) => root !== "/repo/gone");
  assert.deepEqual(kept.map((p) => p.root).sort(), ["/repo/a", "/repo/b"]);
  assert.deepEqual(removed.map((p) => p.root), ["/repo/gone"]);
});

test("pruneRegistry: all roots present → nothing removed", () => {
  const list = [entry("/repo/a"), entry("/repo/b")];
  const { kept, removed } = pruneRegistry(list, () => true);
  assert.equal(kept.length, 2);
  assert.equal(removed.length, 0);
});

test("pruneRegistry: is pure — does not mutate the input list", () => {
  const list = [entry("/repo/a"), entry("/repo/gone")];
  const snapshot = JSON.stringify(list);
  pruneRegistry(list, (root) => root !== "/repo/gone");
  assert.equal(JSON.stringify(list), snapshot, "input list must be unchanged");
});

// ---------------------------------------------------------------------------
// `graph gc` handler — end-to-end against a real registry file + real roots
// ---------------------------------------------------------------------------

/** Run `fn` with console.log captured; returns everything logged, joined by newlines. */
function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("(gc-1) graph gc prunes vanished roots and keeps live ones", () => {
  withHome((home) => {
    // Two roots that really exist on disk, one that never will.
    const liveA = mkdtempSync(join(tmpdir(), "leina-gc-live-"));
    const liveB = mkdtempSync(join(tmpdir(), "leina-gc-live-"));
    const gone = join(home, "definitely-not-here");
    try {
      writeProjectRegistry([entry(liveA), entry(gone), entry(liveB)]);
      const out = captureLog(() => handleGraphGc([]));
      assert.match(out, /Removed 1 stale root\(s\), kept 2/);
      assert.match(out, new RegExp(gone.replace(/[/\\]/g, "\\$&")));

      const after = readProjectRegistry();
      assert.deepEqual(after.map((p) => p.root).sort(), [liveA, liveB].sort());
    } finally {
      rmSync(liveA, { recursive: true, force: true });
      rmSync(liveB, { recursive: true, force: true });
    }
  });
});

test("(gc-2) graph gc --dry-run reports but never rewrites the file", () => {
  withHome((home) => {
    const gone = join(home, "vanished");
    writeProjectRegistry([entry(gone)]);
    const out = captureLog(() => handleGraphGc(["--dry-run"]));
    assert.match(out, /Would remove 1 stale root\(s\)/);
    assert.match(out, /dry run — registry left unchanged/);
    // File untouched: the stale entry is still there.
    assert.deepEqual(readProjectRegistry().map((p) => p.root), [gone]);
  });
});

test("(gc-3) graph gc --json emits machine-readable result", () => {
  withHome((home) => {
    const gone = join(home, "vanished");
    writeProjectRegistry([entry(gone)]);
    const out = captureLog(() => handleGraphGc(["--json"]));
    const parsed = JSON.parse(out) as { dryRun: boolean; kept: number; removed: string[] };
    assert.equal(parsed.kept, 0);
    assert.deepEqual(parsed.removed, [gone]);
    assert.equal(parsed.dryRun, false);
  });
});

test("(gc-4) graph gc on a clean registry reports nothing to prune", () => {
  withHome(() => {
    const live = mkdtempSync(join(tmpdir(), "leina-gc-clean-"));
    try {
      writeProjectRegistry([entry(live)]);
      const out = captureLog(() => handleGraphGc([]));
      assert.match(out, /Nothing to prune — all 1 registered root\(s\) still exist/);
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// infrastructure store — fail-open r/w against ~/.leina/projects.json
// ---------------------------------------------------------------------------

function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "leina-registry-"));
  const prev = process.env.LEINA_HOME;
  process.env.LEINA_HOME = home;
  try {
    fn(home);
  } finally {
    if (prev !== undefined) process.env.LEINA_HOME = prev;
    else delete process.env.LEINA_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

test("readProjectRegistry: absent file returns empty list, never throws", () => {
  withHome(() => {
    assert.deepEqual(readProjectRegistry(), []);
  });
});

test("readProjectRegistry: corrupt JSON returns empty list, never throws (NFR-01)", () => {
  withHome((home) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(projectRegistryPath(), "{ not valid json", "utf8");
    assert.deepEqual(readProjectRegistry(), []);
  });
});

test("readProjectRegistry: malformed entries (wrong shape) are filtered out", () => {
  withHome((home) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      projectRegistryPath(),
      JSON.stringify([{ root: "/repo/a" }, entry("/repo/b")]),
      "utf8",
    );
    const list = readProjectRegistry();
    assert.equal(list.length, 1, "entry missing projectKey/lastBuild must be dropped");
    assert.equal(list[0]!.root, "/repo/b");
  });
});

test("writeProjectRegistry + readProjectRegistry: round-trips", () => {
  withHome(() => {
    writeProjectRegistry([entry("/repo/a"), entry("/repo/b")]);
    const list = readProjectRegistry();
    assert.deepEqual(list.map((p) => p.root).sort(), ["/repo/a", "/repo/b"]);
  });
});

test("recordProject: upserts by root across two calls (build then rebuild)", () => {
  withHome(() => {
    recordProject(entry("/repo/a", { lastBuild: 1 }));
    recordProject(entry("/repo/a", { lastBuild: 2 }));
    const list = readProjectRegistry();
    assert.equal(list.length, 1, "rebuilding the same root must not duplicate the row");
    assert.equal(list[0]!.lastBuild, 2);
  });
});

test("recordProject: multiple projects are all listed", () => {
  withHome(() => {
    recordProject(entry("/repo/a"));
    recordProject(entry("/repo/b"));
    assert.equal(readProjectRegistry().length, 2);
  });
});
