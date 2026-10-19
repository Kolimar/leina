// memory-search-rank.test.ts — the shared search ranking (domain/memory/search-rank.ts) and
// its two back ends: FTS5 and the forced LIKE path must order results by the same rules.
// Run: node --no-warnings --experimental-strip-types --test test/memory-search-rank.test.ts

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  foldText,
  likeRelevance,
  prefixTiers,
  queryTokens,
  rankSearchCandidates,
  type RankCandidate,
} from "../src/domain/memory/search-rank.ts";
import { __setFts5ProbeForTests } from "../src/infrastructure/sqlite/schema.ts";
import { SQLiteMemoryRepository } from "../src/infrastructure/sqlite/memory-repository.ts";

afterEach(() => __setFts5ProbeForTests(null));

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const DAY = 86_400_000;
const T0 = 1_780_000_000_000;

function cand(over: Partial<RankCandidate>): RankCandidate {
  return { id: "p:x", title: "t", content: "c", updatedAt: T0, status: "active", relevance: 0.5, tier: 0, ...over };
}

test("(srank-1) folding and tokens are accent/case-insensitive and de-duplicated", () => {
  assert.equal(foldText("Publicación ÜBER Çava"), "publicacion uber cava");
  assert.deepEqual(queryTokens("  Búsqueda  busqueda RÁPIDA "), ["busqueda", "rapida"]);
  assert.deepEqual(queryTokens("   "), []);
});

test("(srank-2) prefix tiers: ~60% cut, then 4 chars; short tokens never widen", () => {
  assert.deepEqual(prefixTiers("paginacion"), [["pagina"], ["pagi"]]);
  assert.deepEqual(prefixTiers("rendimiento build"), [["rendim", "buil"], ["rend", "buil"]]);
  assert.deepEqual(prefixTiers("xyz ab"), []);
  assert.deepEqual(prefixTiers("trust"), [["trus"]], "a tier identical to the previous one is dropped");
});

test("(srank-3) order: tier, then active before resolved, then boosts + relevance, then newest, then id", () => {
  const ranked = rankSearchCandidates(
    [
      cand({ id: "p:prefix-hit", tier: 1, relevance: 1, title: "release notes" }),
      cand({ id: "p:resolved", status: "resolved", relevance: 1, title: "release plan" }),
      cand({ id: "p:topic-family", topicKey: "release/2-1-0-status", relevance: 0.1, title: "estado" }),
      cand({ id: "p:title", relevance: 0.2, title: "pending-before-release WS6" }),
      cand({ id: "p:content", relevance: 0.9, content: "the release went out" }),
      cand({ id: "p:exact-topic", topicKey: "release", relevance: 0 }),
    ],
    "release",
  );
  assert.deepEqual(ranked.map((c) => c.id), [
    "p:exact-topic", // +5
    "p:topic-family", // +1.5 (family) beats a title phrase (+1)
    "p:title",
    "p:content",
    "p:resolved", // demoted below every active exact hit, whatever its relevance
    "p:prefix-hit", // prefix tier always last
  ]);
  for (let i = 1; i < 4; i++) assert.ok(ranked[i - 1]!.finalScore >= ranked[i]!.finalScore, "scores: higher is better");
});

test("(srank-4) the recency prior only separates near-equal hits; ties break by id", () => {
  const ranked = rankSearchCandidates(
    [
      cand({ id: "p:a", updatedAt: T0 - 400 * DAY, relevance: 0.6 }),
      cand({ id: "p:b", updatedAt: T0, relevance: 0.55 }),
      cand({ id: "p:c", updatedAt: T0 - 400 * DAY, relevance: 1 }),
      cand({ id: "p:d", updatedAt: T0 - 400 * DAY, relevance: 1 }),
    ],
    "nothing-in-titles",
  );
  assert.deepEqual(ranked.map((c) => c.id), ["p:d", "p:c", "p:b", "p:a"]);
});

test("(srank-5) likeRelevance: rarer terms and title hits weigh more; normalised to [0, 1]", () => {
  const docs = [
    { title: "cache", content: "a common word appears here: common common" },
    { title: "other", content: "cache cache, mentioned in the body only" },
    { title: "third", content: "common" },
  ];
  const rel = likeRelevance(docs, ["cache"], 10);
  assert.equal(Math.max(...rel), 1);
  assert.ok(rel[0]! > rel[1]!, "a title hit (5×) beats two body hits");
  assert.equal(rel[2], 0);
  assert.deepEqual(likeRelevance([], ["x"], 3), []);
});

function bothModes(fn: (store: SQLiteMemoryRepository, mode: string) => void): void {
  for (const like of [false, true]) {
    __setFts5ProbeForTests(like ? () => false : null);
    const dir = mkdtempSync(join(tmpdir(), "leina-srank-"));
    const store = new SQLiteMemoryRepository(join(dir, "memory.db"), "p");
    try {
      assert.equal(store.usingLike, like);
      fn(store, like ? "LIKE" : "FTS5");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      __setFts5ProbeForTests(null);
    }
  }
}

test("(srank-6) both back ends: accent-insensitive, same order, resolved demoted, prefix fill below", () => {
  bothModes((store, mode) => {
    const pub = store.save({ title: "Publicación en npm", content: "pasos de la publicación y el tag", type: "decision" }).observation;
    const other = store.save({ title: "Notas varias", content: "menciona la publicacion de paso", type: "manual" }).observation;
    const old = store.save({ title: "Publicación vieja", content: "plan de publicación anterior", type: "decision" }).observation;
    store.update(old.id, { status: "obsolete" });
    for (const q of ["publicacion", "publicación", "PUBLICACIÓN"]) {
      const ids = store.search(q).map((h) => h.id);
      assert.deepEqual(ids, [pub.id, other.id, old.id], `${mode} "${q}"`);
    }
    const near = store.save({ title: "Publicar release", content: "script de publicar", type: "manual" }).observation;
    const hits = store.search("publicacion");
    assert.equal(hits.at(-1)?.id, near.id, `${mode}: the prefix-only hit fills the page last`);
    assert.ok(hits.every((h, i) => i === 0 || hits[i - 1]!.status === "active" || h.status !== "active" || h.id === near.id));
  });
});

test("(srank-7) both back ends: an exact topic key wins; LIKE escapes % and _ in the query", () => {
  bothModes((store, mode) => {
    store.save({ title: "release notes", content: "release release release", type: "manual" });
    const exact = store.save({ title: "estado", content: "nada que ver con release", type: "decision", topicKey: "release" }).observation;
    assert.equal(store.search("release")[0]?.id, exact.id, mode);
    store.save({ title: "100% done", content: "progress", type: "manual" });
    store.save({ title: "snake_case names", content: "naming", type: "manual" });
    assert.deepEqual(store.search("100%").map((h) => h.title), ["100% done"], `${mode}: '%' is literal`);
    assert.ok(!store.search("e_c").some((h) => h.title === "release notes"), `${mode}: '_' is literal`);
  });
});

test("(srank-8) CLI: flag values never leak into the query", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-srank-home-"));
  const proj = mkdtempSync(join(tmpdir(), "leina-srank-proj-"));
  const env = { ...process.env, LEINA_HOME: home };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], { encoding: "utf8", env });
  try {
    assert.equal(run("memory", "save", proj, "--title", "confiable", "--content", "x", "--type", "decision").status, 0);
    const none = run("memory", "search", proj, "zzzz", "--limit", "6", "--type", "decision", "--scope", "project");
    assert.match(none.stdout, /No results for "zzzz"\n/, "the query is just the positional words");
    const hit = run("memory", "search", proj, "--limit", "6", "confiable");
    assert.match(hit.stdout, /\[decision\] confiable/);
    const bad = run("memory", "search", proj, "confiable", "--limit", "six");
    assert.equal(bad.status, 2, "an invalid flag value is a usage error");
    assert.match(bad.stderr, /--limit must be a positive integer/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
