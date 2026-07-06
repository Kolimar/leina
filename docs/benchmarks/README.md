# Benchmarks

Real, reproducible numbers — no marketing rounding. Every figure below is the direct
output of the harness, re-run on demand.

Reproducible harness: `npm run bench -- <repoDir> [--symbol <name>] [--runs N] [--json]`
(`scripts/benchmark.ts`). Every timed run is a **fresh CLI process**, so process startup
is included — that is exactly what an agent pays per command. Read commands run one
discarded warm-up (absorbs the one-per-session cold page-cache cost of first reading
`graph.db`) then N timed runs; we report the **median (p50)** and **p95** of steady-state
latency. Builds run once cold (graph + extraction cache wiped) and once warm.

## What each measurement means

- **build (cold)** — first-ever build: full parse of every file.
- **rebuild (warm)** — same build with the per-file extraction cache populated: only
  changed files re-parse (TypeScript still runs its whole-program type check — that is
  what makes its edges compiler-grade).
- **read path** — `stats / affected / query / impact / audit / memory / context`: the
  commands an agent actually calls mid-session.

## Reference run — leina's own repo (dogfood)

**316 files · 2,085 nodes · 4,648 edges** — Node 26.4, linux-x64, AMD Ryzen 9 7900X3D,
21 runs, measured 2026-07-06. Raw JSON: [`bench/results/leina-selfhost.json`](../../bench/results/leina-selfhost.json).

### Read path — every command answers in ~⅛ second

<!-- bars generated from bench/results/leina-selfhost.json (p50); scale = 200ms -->
<div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5rem 0">
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">stats</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:62%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">123 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">affected</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:64%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">128 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">impact analyze</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:64%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">127 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">memory search</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:66%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">131 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">context build (hook)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:66%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">132 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">query (natural language)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:78%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">156 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">audit (source→sink)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:96%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#6366f1,#22d3ee)"></span></span><span style="flex:0 0 5rem;opacity:.7">191 ms</span></div>
</div>

| measurement | p50 ms | p95 ms |
|---|---:|---:|
| stats | 123 | 128 |
| affected `main` | 128 | 132 |
| impact analyze `main` | 127 | 133 |
| memory search | 131 | 137 |
| context build (session hook) | 132 | 138 |
| query (natural language) | 156 | 161 |
| audit (source→sink) | 191 | 196 |

The whole read path sits within **~70 ms of the ~120 ms process-startup floor** — the
heavy extractor stack is loaded only by `build`/`refresh`, never on reads.

### Build — cold vs warm, and where the time goes

<!-- bars generated from bench/results/leina-selfhost.json; scale = 3000ms -->
<div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5rem 0">
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">build (cold, no cache)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:98%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 5rem;opacity:.7">2930 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">rebuild (warm cache)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:94%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 5rem;opacity:.7">2808 ms</span></div>
</div>

Cold-build stage breakdown (`build --profile`, 2,602 ms total) — **80 % is the
TypeScript whole-program type check**, which is what buys compiler-grade edges:

<!-- bars generated from bench/results/leina-selfhost.json profile; scale = total 2602ms -->
<div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5rem 0">
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">extract: ts-morph (291 files)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:80%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#8b5cf6,#ec4899)"></span></span><span style="flex:0 0 5rem;opacity:.7">2079 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">extract: java sidecar (2)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:13%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#8b5cf6,#ec4899)"></span></span><span style="flex:0 0 5rem;opacity:.7">340 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">extract: tree-sitter (14)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:3.4%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#8b5cf6,#ec4899)"></span></span><span style="flex:0 0 5rem;opacity:.7">89 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">communities (Louvain)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:1.2%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#8b5cf6,#ec4899)"></span></span><span style="flex:0 0 5rem;opacity:.7">32 ms</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 13rem;text-align:right;opacity:.85">persist (SQLite)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:1%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#8b5cf6,#ec4899)"></span></span><span style="flex:0 0 5rem;opacity:.7">26 ms</span></div>
</div>

This repo is TypeScript-dominated (291/316 files via ts-morph), so the warm cache saves
little here — the cache pays off on polyglot repos where tree-sitter files dominate.
`leina build <dir> --profile` shows exactly where your repo's time goes.

### Cross-corpus — the read path is flat regardless of repo size

Same harness, run against [`zod`](https://github.com/colinhacks/zod) (an unrelated external
TypeScript repo, 418 files). Raw: [`zod-speed.json`](../../bench/results/zod-speed.json),
[`zod-tokens.json`](../../bench/results/zod-tokens.json).

| corpus | files | cold build | read path (p50 range) | token answer vs grep-floor |
|---|---:|---:|---:|---:|
| leina (self) | 316 | 2.93 s | 123–191 ms | 504 tok vs 123k (**244×**) |
| zod (external) | 418 | 5.07 s | 122–188 ms | 651 tok vs 100k (**154×**) |

The build scales with file count (bigger repo → longer parse), but **the read path barely
moves** — reads hit SQLite indexes, not the extractor, so `affected`/`impact`/`query` stay
near the same ~130 ms floor whether the graph has 2k or 6k edges. zod also flips the grep
failure mode from Fase 2: there a textual grep for `ZodType` matches **38** files but only
**27** are real dependents — grep over-matches (comments, strings) where on leina it
under-matched. leina returns the exact 27 either way.

## Run it on your own repo

```
npm run bench -- /path/to/your/repo --symbol someFunction --runs 21 --json
```

The `--json` block at the end is machine-readable — commit it next to this file and PR
the table. External validation corpora (zod, gson, Dapper — the extraction-precision
set) go here as they are measured.

## Token savings — answering "what breaks if I touch X?"

Wall-clock is the easy half. The number that actually moves an agent's cost is **tokens
spent to answer a structural question**. `leina impact analyze X` returns X's *impact set*
— the files structurally connected to it (what depends on X and what X depends on) — as a
compact JSON list. Without a graph, an agent has to *read source* to derive, and verify,
the same set. Harness: `bench/tokens.ts`.

Three deterministic baselines, no LLM in the loop, all counted with the **same tokenizer**
(`gpt-tokenizer`, cl100k, exact):

<!-- bars generated from bench/results/tokens-buildGraph.json; linear scale, max = 847,101; leina floored to a visible sliver -->
<div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5rem 0">
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">leina <code>impact analyze</code></span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:0.9%;min-width:6px;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#10b981,#34d399)"></span></span><span style="flex:0 0 8rem;opacity:.85">504 tok · 1 cmd</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">hand-picked (grep + open hits)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:6.2%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 8rem;opacity:.7">52.3k tok ⚠</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">grep-flow floor (read impacted)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:14.5%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 8rem;opacity:.7">123k tok</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">whole-repo dump (upper bound)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:100%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 8rem;opacity:.7">847k tok</span></div>
</div>

Symbol `buildGraph` (45 files in its impact set), leina's own repo — 307 source files,
847k tokens total. Raw: [`bench/results/tokens-buildGraph.json`](../../bench/results/tokens-buildGraph.json).

| baseline (same question, no graph) | tokens | files to read | vs leina |
|---|---:|---:|---:|
| leina `impact analyze --json` | **504** | 0 (answer *is* the list) | 1× |
| hand-picked — grep the symbol, open every hit | 52,321 | 18 ⚠ | 104× |
| grep-flow floor — read every impacted file | 123,146 | 45 | 244× |
| whole-repo dump | 847,101 | 307 | 1681× |

**Read the honest caveats — they matter more than the multiplier:**

- This is **discovery cost, not edit cost.** leina tells you *which* 45 files are affected
  in 504 tokens; if you then have to edit all 45, you read them anyway. The saving is in
  *finding* the set, which is exactly where a grep agent burns tokens and turns.
- **⚠ hand-picked is cheaper because it is *wrong*.** Textual grep finds 18 files; leina
  finds 45. The 27 it misses are transitive/indirect dependents grep can't follow. So the
  cheapest baseline is also the incomplete one — the token win and the *correctness* win
  are the same story (see precision, below).
- **The tokenizer barely matters.** Swapping the exact cl100k tokenizer for a crude
  `chars/3.6` estimate moves every ratio by under 2% — because the savings is a ratio and
  every row uses the same estimator. The multiplier is not a tokenizer artifact.

Run it on your own repo: `node --experimental-strip-types bench/tokens.ts <repo> <symbol> --json`.

## Retrieval recall — does `affected` recover the dependents you can verify?

For a dependency graph the honest precision question is recall: when you ask "who depends
on X?", does `affected` return the files that genuinely do? The oracle is verifiable and
non-circular — every file with a direct `import` of X from within the repo (a strict
*lower bound* on real dependents). Harness: `bench/precision/run.ts`. It also counts the
**transitive** dependents leina surfaces *beyond* that import floor — the indirect ones a
grep-for-imports flow never reaches.

The result splits sharply, and honestly, by symbol kind:

<!-- bars from bench/results/precision-{value,type}.json; scale = 100% recall -->
<div style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:.5rem 0">
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">value symbols (fn / class)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:95%;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#10b981,#34d399)"></span></span><span style="flex:0 0 7rem;opacity:.85">95.1% recall</span></div>
<div style="display:flex;align-items:center;gap:.6rem;margin:.3rem 0"><span style="flex:0 0 15rem;text-align:right;opacity:.85">type-only symbols (interface)</span><span style="flex:1;background:rgba(128,128,128,.16);border-radius:5px"><span style="display:block;width:4.5%;min-width:6px;height:1.15rem;border-radius:5px;background:linear-gradient(90deg,#f59e0b,#ef4444)"></span></span><span style="flex:0 0 7rem;opacity:.7">4.5% recall</span></div>
</div>

| symbol kind | verifiable import-dependents | recovered | recall |
|---|---:|---:|---:|
| value (functions, classes) — calls/refs/implements | 41 | 39 | **95.1%** |
| type-only (interfaces, type aliases) | 111 | 5 | **4.5%** |

Raw: [`precision-value.json`](../../bench/results/precision-value.json), [`precision-type.json`](../../bench/results/precision-type.json).

**What this actually says — the limitation is the headline, not a footnote:**

- **On value dependencies leina is near-complete (95%)** and adds real transitive reach:
  it recovers virtually every file that calls, references, or implements a symbol, *plus*
  indirect dependents a textual import search misses.
- **On type-only dependencies leina is currently blind (~5%).** `affected GraphNode`
  reports "nothing depends on it" while 50 files import that type. leina models *value*
  edges (call/reference/implements), not *type-annotation* edges — so changing an
  interface's shape is not yet surfaced by `affected`. This is a real, documented gap, not
  a rounding error, and the benchmark exists precisely to keep us honest about it.
- The harness also caught a specific anomaly — a heavily-called function reporting zero
  dependents — now tracked as an extraction bug. A benchmark that never finds anything
  wrong isn't measuring anything.

Method limits, stated plainly: the oracle counts single-line and multi-line internal
`import`s (it misses re-exports and dynamic imports), and it is a *lower bound* — so recall
here is conservative. Extending the corpus to external repos and a commit-labeled set is
tracked under `bench/precision/`.
