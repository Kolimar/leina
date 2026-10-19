// build-single-flight.test.ts — in-process single-flight for graph builds (wiring.ts).
//
// The MCP server runs tool calls concurrently in ONE process. Without coordination,
// every call that found the graph stale started its own full rebuild, and a reader
// racing a first build (graph_stats next to graph_build) could read the empty,
// not-yet-committed graph (nodes: 0). Builds are now keyed by resolved root: concurrent
// callers share the in-flight build and gated readers wait for it before reading.
// Run: node --no-warnings --experimental-strip-types --test test/build-single-flight.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitGraphBuild, buildGraphShared, openFreshStoreOrThrow, openGraphRepo } from "../src/cli/wiring.ts";

function tmpRepo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `leina-sf-${tag}-`));
  writeFileSync(join(dir, "b.ts"), "export function beta(): number { return 1; }\n");
  writeFileSync(join(dir, "a.ts"), "import { beta } from \"./b\";\nexport function alpha(): number { return beta(); }\n");
  return dir;
}

/** Run `fn` while capturing everything written to stderr. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let err = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    return { value: await fn(), err };
  } finally {
    process.stderr.write = original;
  }
}

test("(sf-1) concurrent builds of one root share a single in-flight build", async () => {
  const dir = tmpRepo("share");
  const other = tmpRepo("other");
  try {
    const first = buildGraphShared(dir);
    assert.equal(buildGraphShared(join(dir, ".")), first, "same root (any spelling) joins the running build");
    const elsewhere = buildGraphShared(other);
    assert.notEqual(elsewhere, first, "a different root builds independently");
    const [report] = await Promise.all([first, elsewhere]);
    assert.ok(report.nodes > 0, "the shared build produced a graph");
    const next = buildGraphShared(dir);
    assert.notEqual(next, first, "a settled build is not reused — the next call rebuilds");
    await next;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("(sf-2) concurrent stale-gate reads trigger ONE rebuild and all see the full graph", async () => {
  const dir = tmpRepo("gate");
  try {
    const { value: stores, err } = await captureStderr(() =>
      Promise.all([1, 2, 3].map(() => openFreshStoreOrThrow(dir, { buildIfMissing: true }))),
    );
    try {
      const rebuilds = err.split("\n").filter((l) => l.endsWith("; rebuilding ..."));
      assert.equal(rebuilds.length, 1, `exactly one rebuild started (stderr: ${err})`);
      for (const s of stores) assert.ok(s.stats().nodes > 0, "every caller reads the built graph");
    } finally {
      for (const s of stores) s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(sf-3) awaitGraphBuild holds a raw reader until the in-flight first build commits", async () => {
  const dir = tmpRepo("reader");
  try {
    const build = buildGraphShared(dir);
    await awaitGraphBuild(dir);
    const s = openGraphRepo(dir);
    try {
      assert.ok(s.stats().nodes > 0, "no empty half-built graph observed");
    } finally {
      s.close();
    }
    await build;
    await awaitGraphBuild(dir); // nothing in flight → resolves immediately
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
