# Benchmarks

Reproducible harness: `npm run bench -- <repoDir> [--symbol <name>] [--runs N]`
(`scripts/benchmark.ts`). Every timed run is a **fresh CLI process**, so process startup
is included — that is exactly what an agent pays per command. Read commands report the
median of N runs; builds run once cold (graph + extraction cache wiped) and once warm.

## What to measure on your own repos

- **build (cold)** — first-ever build: full parse of every file.
- **rebuild (warm)** — same build with the per-file extraction cache populated: only
  changed files re-parse (TypeScript still runs its whole-program type check — that is
  what makes its edges compiler-grade).
- **stats / affected / query** — the read path an agent actually uses mid-session.

## Reference run (leina's own repo, dogfood)

258 files, 1.8k nodes, 4.1k edges — Node 26, linux-x64:

| measurement | median ms |
|---|---:|
| build (cold, no cache) | ~2500 |
| rebuild (warm extract cache) | ~2200 |
| stats | ~120 |
| affected (one symbol) | ~130 |
| query (natural language) | ~150 |

Notes on the shape of these numbers:

- The read path stays near the ~0.15s startup floor: the heavy extractor stack is only
  loaded by `build`/`refresh`.
- This repo is TypeScript-dominated (241/258 files via ts-morph), so the warm rebuild
  saves little here — the cache pays off on polyglot repos where tree-sitter files
  dominate. `leina build <dir> --profile` shows exactly where your repo's time goes.

## Comparing against a grep-based flow

The honest comparison is not wall-clock, it is **tokens and turns**: `affected` answers
"what breaks if I touch X?" in one command with a transitive, deterministic answer; a
grep flow needs one search per hop plus the model reading every match. Run both against
a symbol with indirect dependents and count what the agent had to ingest.

Numbers for public repos (zod, gson, Dapper — the extraction-precision validation set)
belong in this file as they are (re)measured; run the harness and PR the table.
