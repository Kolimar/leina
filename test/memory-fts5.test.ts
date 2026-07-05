// memory-fts5.test.ts — Tests for FTS5 capability detection and LIKE-mode fallback.
// Run: node --no-warnings --experimental-strip-types --test test/memory-fts5.test.ts
//
// Two suites:
//   1. FTS5 happy-path tests (run on Node 24+ where FTS5 is present).
//   2. LIKE-mode tests that use __setFts5ProbeForTests(() => false) to force LIKE
//      behavior on any Node build, including Node 24. afterEach always restores the
//      probe to null so tests are fully isolated.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMemorySchema,
  fts5Available,
  fts5UnavailableMessage,
  Fts5UnavailableError,
  FTS5_MIN_NODE_MAJOR,
  __setFts5ProbeForTests,
} from "../src/infrastructure/sqlite/schema.ts";
import { SQLiteMemoryRepository as MemoryStore } from "../src/infrastructure/sqlite/memory-repository.ts";

// Restore the probe after every test that uses the seam.
afterEach(() => __setFts5ProbeForTests(null));

// ---------------------------------------------------------------------------
// Suite A: FTS5 happy-path (run in all Node builds with FTS5)
// ---------------------------------------------------------------------------

test("(fts5-1) fts5Available is true on this Node build (>= 24)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.equal(fts5Available(db), true);
  } finally {
    db.close();
  }
});

test("(fts5-2) the probe leaves no residue in the db", () => {
  const db = new DatabaseSync(":memory:");
  try {
    fts5Available(db);
    fts5Available(db); // second call must not collide with a leftover temp table
    const rows = db
      .prepare("SELECT name FROM temp.sqlite_master WHERE name = '__leina_fts5_probe'")
      .all();
    assert.equal(rows.length, 0, "throwaway probe table is dropped");
  } finally {
    db.close();
  }
});

test("(fts5-3) ensureMemorySchema returns {fts5:true} when FTS5 is available", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const result = ensureMemorySchema(db);
    assert.equal(result.fts5, true);
  } finally {
    db.close();
  }
});

test("(fts5-4) a full MemoryStore round-trips (schema + search) on this Node", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-fts5-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), "fts5-test");
    store.save({ title: "auth bug fix", content: "fixed login race", type: "bugfix" });
    const hits = store.search("login");
    assert.equal(hits.length, 1, "FTS5 search returns the saved observation");
    assert.equal(store.usingLike, false, "FTS5 store should NOT report usingLike");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(fts5-5) Fts5UnavailableError carries the actionable message", () => {
  const err = new Fts5UnavailableError("v23.8.0");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "Fts5UnavailableError");
  assert.match(err.message, /v23\.8\.0/);
  assert.match(err.message, /FTS5/);
  assert.match(err.message, new RegExp(`Node ${FTS5_MIN_NODE_MAJOR}`));
  assert.match(err.message, /nodejs\.org/);
});

test("(fts5-6) fts5UnavailableMessage names the detected version and the floor", () => {
  const msg = fts5UnavailableMessage("v22.5.0");
  assert.match(msg, /v22\.5\.0/);
  assert.match(msg, new RegExp(String(FTS5_MIN_NODE_MAJOR)));
  assert.match(msg, /node --version/);
});

// ---------------------------------------------------------------------------
// Suite B: LIKE-mode fallback (forced via __setFts5ProbeForTests)
// ---------------------------------------------------------------------------

test("(like-1) fresh DB in LIKE mode: schema without obs_fts/triggers, usingLike===true", () => {
  __setFts5ProbeForTests(() => false);
  const dir = mkdtempSync(join(tmpdir(), "leina-like-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), "like-test");
    assert.equal(store.usingLike, true, "store should report usingLike=true");

    // obs_fts table must NOT be created in LIKE mode
    const db = (store as unknown as { db: DatabaseSync }).db;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='obs_fts'")
      .all();
    assert.equal(tables.length, 0, "obs_fts should not exist in LIKE mode");

    // Triggers must NOT be created
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('obs_ai','obs_au','obs_ad')")
      .all();
    assert.equal(triggers.length, 0, "FTS5 triggers should not exist in LIKE mode");

    // Save and basic reads still work
    const { observation } = store.save({ title: "refactor auth module", content: "moved login logic to auth.ts", type: "architecture" });
    assert.ok(observation.id, "save returns an observation id");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(like-2) ex-FTS5 DB reopened in LIKE mode: triggers dropped, writes don't throw", () => {
  // Step 1: create a DB with real FTS5 (probe = real, not overridden)
  const dir = mkdtempSync(join(tmpdir(), "leina-like-exfts5-"));
  try {
    const fts5Store = new MemoryStore(join(dir, "memory.db"), "ex-fts5");
    fts5Store.save({ title: "initial observation", content: "created with FTS5", type: "architecture" });
    fts5Store.close();

    // Step 2: force LIKE mode and reopen the same DB
    __setFts5ProbeForTests(() => false);
    const likeStore = new MemoryStore(join(dir, "memory.db"), "ex-fts5");
    assert.equal(likeStore.usingLike, true);

    // Triggers must have been dropped
    const db = (likeStore as unknown as { db: DatabaseSync }).db;
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('obs_ai','obs_au','obs_ad')")
      .all();
    assert.equal(triggers.length, 0, "triggers must be dropped when switching to LIKE mode");

    // Writes must not throw (triggers no longer try to insert into obs_fts)
    assert.doesNotThrow(() => {
      likeStore.save({ title: "new entry in LIKE mode", content: "writes must work without FTS5", type: "bugfix" });
    });

    likeStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(like-3) LIKE→FTS5 transition: triggers recreated + obs_fts rebuilt with live rows only", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-like-transition-"));
  try {
    // Step 1: open in LIKE mode, save some observations
    __setFts5ProbeForTests(() => false);
    const likeStore = new MemoryStore(join(dir, "memory.db"), "transition-test");
    likeStore.save({ title: "live observation", content: "should be in FTS5 after transition", type: "architecture" });
    // Evolve once to create a superseded snapshot
    likeStore.save({ title: "live observation", content: "updated content — only this in FTS5", type: "architecture", topicKey: "live-observation" });
    likeStore.close();
    __setFts5ProbeForTests(null); // restore real probe

    // Step 2: reopen with FTS5 (probe returns true)
    const fts5Store = new MemoryStore(join(dir, "memory.db"), "transition-test");
    assert.equal(fts5Store.usingLike, false, "FTS5 should be active after transition");

    // Triggers must be present
    const db = (fts5Store as unknown as { db: DatabaseSync }).db;
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('obs_ai','obs_au','obs_ad')")
      .all() as { name: string }[];
    assert.equal(triggers.length, 3, "all 3 FTS5 triggers must be recreated");

    // obs_fts must contain only live (non-superseded) rows
    const ftsRows = db.prepare("SELECT rowid FROM obs_fts").all() as { rowid: number }[];
    const obsRows = db
      .prepare("SELECT rowid FROM observations WHERE superseded_by IS NULL")
      .all() as { rowid: number }[];
    assert.equal(
      ftsRows.length,
      obsRows.length,
      "obs_fts must contain exactly the live (non-superseded) observations",
    );

    // FTS5 search must work after the transition
    const hits = fts5Store.search("updated");
    assert.equal(hits.length, 1, "FTS5 search must return the live observation");

    fts5Store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(like-4) LIKE search: recall by substring, snippet with [ ], order by updated_at DESC", () => {
  __setFts5ProbeForTests(() => false);
  const dir = mkdtempSync(join(tmpdir(), "leina-like-search-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), "like-search");
    // Both content strings contain the search term "refactor" so the snippet
    // will always find a match and produce [ ] brackets.
    store.save({
      title: "auth module",
      content: "refactor authentication logic to a separate module for clarity",
      type: "architecture",
    });
    // Second insert is newer (higher updated_at)
    const obs2 = store.save({
      title: "cache layer for auth",
      content: "refactor auth cache implementation to use redis backend",
      type: "architecture",
    });

    // Search for "refactor" — both content strings match
    const hits = store.search("refactor", { limit: 10 });
    assert.ok(hits.length >= 2, "should find at least two hits for 'refactor'");

    for (const h of hits) {
      assert.ok(h.id, "hit has an id");
      assert.ok(h.snippet, "hit has a non-empty snippet");
      // Snippet must contain [ ] markers around the matched word
      assert.match(h.snippet, /\[.*?\]/, "snippet should highlight the match with [ ]");
    }

    // Most recently updated hit should come first
    assert.ok(
      hits[0]!.updatedAt >= hits[1]!.updatedAt,
      "hits should be ordered by updatedAt DESC",
    );

    // Single-token search with limit
    const limited = store.search("auth", { limit: 1 });
    assert.equal(limited.length, 1, "limit is respected");

    // No match → empty array
    const none = store.search("xyzzy123notexist");
    assert.equal(none.length, 0, "no results for a term that doesn't exist");

    store.close();
    void obs2; // suppress unused-var warning
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(like-5) LIKE search with empty query: returns recent live rows without text filter", () => {
  __setFts5ProbeForTests(() => false);
  const dir = mkdtempSync(join(tmpdir(), "leina-like-empty-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), "like-empty");
    store.save({ title: "alpha", content: "first", type: "architecture" });
    store.save({ title: "beta", content: "second", type: "architecture" });
    store.save({ title: "gamma", content: "third", type: "architecture" });

    const hits = store.search("", { limit: 10 });
    assert.equal(hits.length, 3, "empty query returns all live rows");
    // Order should be most-recently-updated first
    for (let i = 1; i < hits.length; i++) {
      assert.ok(hits[i - 1]!.updatedAt >= hits[i]!.updatedAt, "ordered by updatedAt DESC");
    }

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// prefix-fallback recall (QA fix #5): zero exact hits → one prefix-match retry.
// ---------------------------------------------------------------------------

test("(pf-1) cross-language root: 'paginacion' finds 'pagination' via prefix fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-pf-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), "pf-test");
    const { observation } = store.save({
      title: "Pagination cursor bugfix",
      content: "Fixed off-by-one in pagination cursor; inclusive end index.",
      type: "bugfix",
    });
    const hits = store.search("paginacion");
    assert.ok(hits.some((h) => h.id === observation.id), "prefix retry bridges the ES/EN root");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pf-2) fallback only fires on zero exact hits (precision untouched)", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-pf-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), "pf-test");
    const { observation: exact } = store.save({
      title: "Validation rules", content: "input validation for forms", type: "manual",
    });
    store.save({ title: "Valid names", content: "validity checker for slugs", type: "manual" });
    const hits = store.search("validation");
    assert.equal(hits[0]?.id, exact.id, "exact match ranks first, fallback not triggered");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pf-3) short tokens (<4 chars) never trigger the fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-pf-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), "pf-test");
    store.save({ title: "abc", content: "alphabet soup", type: "manual" });
    const hits = store.search("xyz");
    assert.equal(hits.length, 0, "no prefix retry for tiny tokens");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// pf-* contract under FORCED LIKE mode — pins the pf suite's behavior on Node
// builds without FTS5 (where pf-1..pf-3 above run through _searchLike), so a
// LIKE-branch regression is caught on every Node, not only on FTS5-less CI.
// ---------------------------------------------------------------------------

test("(pf-like-1) LIKE mode: prefix fallback bridges 'paginacion' → 'pagination' on zero exact hits", () => {
  __setFts5ProbeForTests(() => false);
  const dir = mkdtempSync(join(tmpdir(), "leina-pf-like-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), "pf-test");
    assert.equal(store.usingLike, true, "store must be in LIKE mode");
    const { observation } = store.save({
      title: "Pagination cursor bugfix",
      content: "Fixed off-by-one in pagination cursor; inclusive end index.",
      type: "bugfix",
    });
    const hits = store.search("paginacion");
    assert.ok(hits.some((h) => h.id === observation.id), "LIKE prefix retry bridges the ES/EN root");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pf-like-2) LIKE mode: exact match outranks a NEWER partial match (recency only tie-breaks)", async () => {
  __setFts5ProbeForTests(() => false);
  const dir = mkdtempSync(join(tmpdir(), "leina-pf-like-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), "pf-test");
    assert.equal(store.usingLike, true, "store must be in LIKE mode");
    const { observation: exact } = store.save({
      title: "Validation rules", content: "input validation for forms", type: "manual", topicKey: "validation_rules",
    });
    // Ensure a strictly newer updated_at so recency-first ordering would flip the result.
    await new Promise((r) => setTimeout(r, 2));
    store.save({
      title: "Valid names", content: "naming validation for slugs", type: "manual", topicKey: "valid_names",
    });
    const hits = store.search("validation");
    assert.equal(hits.length, 2, "both the exact and the partial match are hits");
    assert.equal(hits[0]?.id, exact.id, "exact title match ranks above the newer content-only match");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pf-like-3) LIKE mode: fallback only fires on zero exact hits; short tokens never retry", () => {
  __setFts5ProbeForTests(() => false);
  const dir = mkdtempSync(join(tmpdir(), "leina-pf-like-"));
  try {
    const store = new MemoryStore(join(dir, "memory.db"), "pf-test");
    const { observation: exact } = store.save({
      title: "Validation rules", content: "input validation for forms", type: "manual",
    });
    store.save({ title: "Valid names", content: "validity checker for slugs", type: "manual" });
    // Exact hit exists → the prefix retry must NOT widen the result set (pf-2 in LIKE mode).
    const hits = store.search("validation");
    assert.equal(hits[0]?.id, exact.id, "exact match ranks first, fallback not triggered");
    assert.ok(!hits.some((h) => h.title === "Valid names"), "prefix-only near-miss stays out");
    // And tiny tokens never trigger the retry at all (pf-3 in LIKE mode).
    assert.equal(store.search("xyz").length, 0, "no prefix retry for tiny tokens");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
