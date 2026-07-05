// workspace-federation.test.ts — unit tests for WorkspaceMemoryFederator
// Covers: federated search across member repos (FR-05), writes to host repo (FR-06),
// de-duplication, and recentContext aggregation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";
import { WorkspaceMemoryFederator } from "../src/application/workspace/federation.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ws-federation-"));
}

function scopedRepo(dbPath: string, key: string): SQLiteMemoryRepository {
  return new SQLiteMemoryRepository(dbPath, key);
}

// ---------------------------------------------------------------------------
// FR-05: federated search returns results from all member repos
// ---------------------------------------------------------------------------

test("(FR-05) federated search returns hits from all member repos", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");
  try {
    // Seed observations to two member scopes via separate repos
    const repoA = scopedRepo(dbPath, "service-a");
    repoA.save({ title: "auth circuit breaker", content: "circuit breaker for auth", type: "decision" });
    repoA.close();

    const repoB = scopedRepo(dbPath, "service-b");
    repoB.save({ title: "payment retry strategy", content: "exponential backoff", type: "decision" });
    repoB.close();

    // Open all repos for the federator
    const wsRepo = scopedRepo(dbPath, "workspace-key");
    const memberRepoA = scopedRepo(dbPath, "service-a");
    const memberRepoB = scopedRepo(dbPath, "service-b");
    try {
      const federator = new WorkspaceMemoryFederator(wsRepo, [memberRepoA, memberRepoB]);
      const hits = federator.search("strategy");
      const titles = hits.map((h) => h.title ?? "");
      assert.ok(
        titles.some((t) => t.toLowerCase().includes("retry") || t.toLowerCase().includes("payment")),
        `expected payment-related hit; got: ${JSON.stringify(titles)}`,
      );
    } finally {
      wsRepo.close(); memberRepoA.close(); memberRepoB.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(FR-05b) federated search returns hits from auth-related member repos", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");
  try {
    const repoA = scopedRepo(dbPath, "svc-a");
    repoA.save({ title: "auth circuit breaker design", content: "circuit breaker pattern", type: "architecture" });
    repoA.close();

    const wsRepo = scopedRepo(dbPath, "ws-key");
    const memberA = scopedRepo(dbPath, "svc-a");
    try {
      const federator = new WorkspaceMemoryFederator(wsRepo, [memberA]);
      const hits = federator.search("circuit");
      assert.ok(hits.length >= 1, "should find circuit breaker observation");
      assert.ok(hits[0]!.title.toLowerCase().includes("circuit") || hits[0]!.snippet.toLowerCase().includes("circuit"));
    } finally {
      wsRepo.close(); memberA.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FR-06: save writes to the workspace host scope
// ---------------------------------------------------------------------------

test("(FR-06) save writes observation to the workspace host repo", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");
  try {
    const wsRepo = scopedRepo(dbPath, "workspace-key");
    try {
      const federator = new WorkspaceMemoryFederator(wsRepo, []);
      const { observation } = federator.save({
        title: "workspace-level decision",
        content: "This is a workspace-level architectural decision",
        type: "decision",
      });

      // Must be retrievable from the host repo
      const found = wsRepo.get(observation.id);
      assert.ok(found, "observation saved via federator must be in the host repo");
      assert.equal(found.title, "workspace-level decision");
    } finally {
      wsRepo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// De-duplication: same repo in both host and members → de-dup
// ---------------------------------------------------------------------------

test("(fed-dedup) search results de-duplicated when same repo appears in host and members", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");
  try {
    const wsRepo = scopedRepo(dbPath, "ws-key");
    wsRepo.save({ title: "shared decision", content: "shared", type: "decision" });
    // Use a second handle to the same projectKey to simulate the same scope
    const wsRepoCopy = scopedRepo(dbPath, "ws-key");
    try {
      // federator sees wsRepo (host) and wsRepoCopy (member pointing at same projectKey)
      const federator = new WorkspaceMemoryFederator(wsRepo, [wsRepoCopy]);
      const hits = federator.search("shared decision");
      const ids = hits.map((h) => h.id);
      const uniqueIds = new Set(ids);
      assert.equal(ids.length, uniqueIds.size, "duplicate ids must be de-duped");
    } finally {
      wsRepo.close(); wsRepoCopy.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// recentContext aggregates from all member repos
// ---------------------------------------------------------------------------

test("(fed-recentContext) recentContext merges observations from all repos", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");
  try {
    const rA = scopedRepo(dbPath, "svc-alpha");
    rA.save({ title: "alpha decision", content: "something for alpha", type: "discovery" });
    rA.close();

    const rB = scopedRepo(dbPath, "svc-beta");
    rB.save({ title: "beta decision", content: "something for beta", type: "discovery" });
    rB.close();

    const wsRepo = scopedRepo(dbPath, "ws-key");
    const memberA = scopedRepo(dbPath, "svc-alpha");
    const memberB = scopedRepo(dbPath, "svc-beta");
    try {
      const federator = new WorkspaceMemoryFederator(wsRepo, [memberA, memberB]);
      const ctx = federator.recentContext({ limit: 10 });
      const titles = ctx.observations.map((o) => o.title ?? "");
      assert.ok(titles.some((t) => t.includes("alpha")), `alpha must appear; got: ${JSON.stringify(titles)}`);
      assert.ok(titles.some((t) => t.includes("beta")), `beta must appear; got: ${JSON.stringify(titles)}`);
    } finally {
      wsRepo.close(); memberA.close(); memberB.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// get() delegates across all repos
// ---------------------------------------------------------------------------

test("(fed-get) get() finds observation from a member repo", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");
  try {
    const rA = scopedRepo(dbPath, "svc-a");
    const { observation } = rA.save({ title: "test obs", content: "content", type: "discovery" });
    rA.close();

    const wsRepo = scopedRepo(dbPath, "ws-key");
    const memberA = scopedRepo(dbPath, "svc-a");
    try {
      const federator = new WorkspaceMemoryFederator(wsRepo, [memberA]);
      const found = federator.get(observation.id);
      assert.ok(found, "get() must find the observation by id via member repo");
      assert.equal(found.title, "test obs");
    } finally {
      wsRepo.close(); memberA.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// close() is a no-op
// ---------------------------------------------------------------------------

test("(fed-close-noop) close() does not close the underlying repos", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "memory.db");
  try {
    const wsRepo = scopedRepo(dbPath, "ws-key");
    try {
      const federator = new WorkspaceMemoryFederator(wsRepo, []);
      federator.close(); // must not throw or close the underlying repo
      const ctx = wsRepo.recentContext();
      assert.ok(Array.isArray(ctx.observations));
    } finally {
      wsRepo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
