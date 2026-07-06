# leina

[![CI](https://github.com/Kolimar/leina/actions/workflows/ci.yml/badge.svg)](https://github.com/Kolimar/leina/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@kolimar/leina)](https://www.npmjs.com/package/@kolimar/leina)
[![node](https://img.shields.io/node/v/@kolimar/leina)](#requirements)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![docs: EN/ES](https://img.shields.io/badge/docs-EN%20%2F%20ES-4493f8)](https://kolimar.github.io/leina/)

**Leina** is a **L**inked **E**ngineering **I**ntelligence **N**etwork for **A**gents:
a persistent system that connects code, decisions, tests, skills and learnings.

In practice: a **CLI** that builds a queryable **knowledge graph of a codebase** plus
local **project memory**, so an AI assistant (Devin, Claude Code, …) retrieves *scoped*
context through fast `leina` commands instead of grepping through files.

> **Command-line interface.** Every capability is a
> `leina <subcommand>` you run directly (or that an agent runs via its
> shell). The read/query path starts in ~0.15s because the heavy extractor stack
> (tree-sitter + ts-morph) is loaded lazily — only `build`/`refresh` pay for it.

Two layers ship today: the **graph** (what's connected to what) and **memory with
drift detection** (the *why* behind the code, re-checked against the graph as it
changes). A bundled **SDD** workflow (spec→design→tasks) ships as agent skills
and in the always-on protocol — its design and tasks phases scope impact with
`leina affected` before deciding. Built in TypeScript, SQLite-backed, with
a semantic sidecar for compiler-grade C#/Java.

The tool is **local-first, cloud-ready, graph-native and validation-first**: core
use cases are exposed as transport-agnostic **capabilities** (`capabilities list`)
with versioned output schemas, every machine-readable command carries a
`schemaVersion`, and `verify --json` gives CI an actionable health gate. The graph
model is **extensible beyond code** (services, configs, infra) so `impact analyze`
can cross code→test→config→service, and a local **event outbox** (off by default)
is the seam for a future opt-in cloud sync — no cloud dependency exists today.

## Why a graph (and not just vector RAG)

A vector store answers "what looks similar to this?". A graph answers "what is
*connected* to this, and how?" — multi-hop questions like *"who depends on this
class?"* or *"how does the CLI reach the database?"*. For code, the second kind
matters most. The two are complementary; this is the graph half.

## Requirements

- **Node ≥ 22.13** — uses the built-in `node:sqlite` (no native deps) and runs
  TypeScript directly via `--experimental-strip-types` (no build step). Node 22.13.0
  is the first 22.x Active LTS release where `node:sqlite` is available without the
  `--experimental-sqlite` flag. **Node ≥ 24 is recommended** — Node 22/23 builds lack
  SQLite FTS5, so memory search runs in degraded LIKE mode (no porter stemming or BM25
  ranking). A warning is emitted to stderr on each `memory` command in that mode.

  <details><summary><b>Why the ≥ 22.13 floor?</b> (a deliberate trade-off)</summary>

  The floor buys the property everything else rests on: **zero native dependencies**.
  `node:sqlite` replaces `better-sqlite3`-style native modules, which is why leina
  installs cleanly under npm/pnpm/bun, with `--ignore-scripts`, behind proxies, and
  without a compiler toolchain. Lowering the floor would trade that away.
  Node 20 left its maintenance window in April 2026 — every supported LTS line
  (22, 24) runs leina. Feature matrix by Node version:

  | Node | Status |
  |---|---|
  | < 22.13 | ✗ unsupported — the CLI exits at startup with upgrade advice |
  | 22.13 – 23.x | ✓ full graph features; memory search degraded (LIKE, no FTS5) |
  | ≥ 24 | ✓ everything, incl. FTS5 full-text memory search (porter + BM25) |

  </details>

```bash
# use it anywhere — installs the `leina` binary on your PATH
npm install -g @kolimar/leina

# or, working from a clone (contributors / latest unreleased code):
npm install
```

### Package managers

leina deliberately has **no install/postinstall scripts** and **no native compile
step** (its parser grammars are plain `.wasm` files inside regular packages), so it
installs cleanly even where lifecycle scripts are disabled:

| Manager | Status | Notes |
|---|---|---|
| npm | ✅ | including `--ignore-scripts` |
| pnpm | ✅ | no "ignored build scripts" approval needed — there are none |
| bun | ✅ | no `trustedDependencies` entry needed |
| yarn (node_modules linker) | ✅ | classic, or Berry with `nodeLinker: node-modules` |
| yarn Plug'n'Play | ❌ | unsupported — the WASM grammars must exist on the real filesystem |

If a global install ever resolves strangely (symlinked stores, custom prefixes),
`leina doctor` prints where the CLI entry, bundled assets and WASM grammars
actually resolve from.

> **Windows + Git Bash:** run `leina` from **cmd.exe or PowerShell**, not Git Bash. Under
> MSYS/Git Bash the npm POSIX shim can mis-resolve the CLI path and fail with `MODULE_NOT_FOUND`
> pointing at `C:\Program Files\Git\Users\...` even on a correct install. `leina doctor`
> flags this (the _shell interop_ check) and `leina setup`/`activate`/`init` print the remedy
> (there is deliberately no npm postinstall hook — pnpm/bun skip dependency scripts). Workarounds:
> call node directly — `node "%APPDATA%\npm\node_modules\leina\dist\cli\index.js" --help` —
> or add a `~/.bashrc` wrapper:
> `leina() { node "$APPDATA/npm/node_modules/leina/dist/cli/index.js" "$@"; }`

## Usage

```bash
# These examples use the clone/contributor form `npm run cli -- <command>`.
# If you ran `npm install -g @kolimar/leina`, drop the prefix and call `leina <command>`.
#
# ── Interactive console ─────────────────────────────────────────────────────
# Everything below is also available through menus: install/update (pick asset
# groups), init/deinit the current repo, health status, repair, env vars, uninstall.
npm run cli -- tui                            # also: leina tui

# ── Quick Start ─────────────────────────────────────────────────────────────
# One command, once per machine: the "magic" setup (global share + symlinks +
# user-global Exec grant + hooks, and turns on blanket mode). That's it —
# leina is now available in every Devin session.
npm run cli -- setup                         # also: leina setup
# Undo everything machine-wide at any time:
npm run cli -- disable

# Per project: nothing to remember. Under blanket mode the leina-setup skill
# asks once per repo ("use leina here?") and runs init/deinit for you. Each
# repo has a local, git-ignored consent flag: unknown -> ask once, enabled -> on,
# disabled -> silent. The graph builds on demand the first time it's queried.
# You can also wire a repo by hand:
npm run cli -- init <dir>                     # adaptive: LIGHT under blanket, FULL standalone
npm run cli -- init <dir> --build             # also build the graph synchronously now
npm run cli -- init <dir> --mcp               # register the MCP server in .mcp.json
npm run cli -- init <dir> --claude-hooks      # Claude Code hooks (same gate Devin gets)
npm run cli -- deinit <dir>                   # opt this repo out (consent=disabled) + strip wiring

# Prefer the granular pieces? They compose what `setup` does and each has an inverse:
#   activate <-> deactivate   (global share/symlinks/user-config; no blanket)
#   install-global            (deprecated alias of activate)

# Choose WHICH bundled skills/agents install (see assets/catalog.json for the full list,
# groups and dependencies). Omit the flags to keep your previous choice; default is full.
npm run cli -- activate --preset minimal        # core plumbing only
npm run cli -- activate --preset sdd            # core + the SDD workflow
npm run cli -- activate --skills graph-viz,github-pr --agents none
# Dependencies are auto-included (e.g. selecting the sdd-explore skill pulls its agent);
# switching to a smaller selection sweeps the now-stale host symlinks.

# Choose which AI hosts to link into (default: devin). Claude Code gets the skills as
# ~/.claude/skills/<name> and the agents as ~/.claude/agents/<name>.md (its native format).
# --hosts alone changes WHERE without touching the asset selection.
npm run cli -- activate --hosts devin,claude

# ── Build / query ───────────────────────────────────────────────────────────
# build the graph for a project (writes <dir>/.leina/graph.db + manifest)
npm run cli -- build <dir> [--json]          # --json also writes a portable graph.json
npm run cli -- build <dir> --profile         # stage timings (unchanged files reuse the extract cache)
npm run cli -- refresh <dir>                 # force a full rebuild

# diagnose health: node version, parser wasm assets, global share freshness, host symlinks,
# and the project (graph freshness, AGENTS.md/.gitignore/.devin wiring). Exits non-zero if
# any check fails. Read-only — never writes, never opens a DB file (it checks that DBs
# exist, not that they are internally sound).
npm run cli -- doctor [<dir>]
# auto-fix what doctor found: re-runs the idempotent install writers (global + repo wiring),
# scoped to prior installs; respects deinit; never touches DBs.
npm run cli -- repair [<dir>]

# inspect — query/affected/path auto-rebuild a stale graph before answering
npm run cli -- stats <dir>                    # node/edge counts + confidence breakdown
npm run cli -- status <dir>                   # freshness: is the graph stale vs the code?
npm run cli -- affected <dir> "<symbol>"     # blast radius: who depends on it
npm run cli -- path <dir> "<a>" "<b>"        # shortest path between two symbols
npm run cli -- query <dir> "a question"      # term-scored subgraph

# memory — persist and recall the *why*
# Global DB: ~/.leina/memory.db (honoring $LEINA_HOME), keyed by project.
# Always-on: no init required — any directory works, even ones without a git repo.
npm run cli -- memory save <dir> --title "..." --content "..." [--type decision] [--topic key] [--anchors a,b]
npm run cli -- memory update <dir> <id> [--title ..] [--content ..] [--type ..]
npm run cli -- memory search <dir> "a question" [--type ..] [--limit N]
npm run cli -- memory verified <dir> "a question"   # drift-classified: USABLE / WARNING / DO-NOT-USE
npm run cli -- memory get <dir> <id>
npm run cli -- memory context <dir>
npm run cli -- memory session <dir> --content "..." [--title "..."]
npm run cli -- memory session-start <dir> [--title "..."]
npm run cli -- memory suggest-topic <dir> --title "..." [--type ..]
npm run cli -- memory current-project <dir>         # show derived project key + detection method
npm run cli -- memory merge-projects <dir> --from <old-key> --to <new-key> [--dry-run]
npm run cli -- memory migrate <dir>                 # fold legacy per-repo memory.db into global DB
# Portable memory: decisions travel WITH the repo (no server). `sync` merges the committable
# snapshot .leina/memory-export.jsonl both ways; export/import move JSONL between machines.
npm run cli -- memory sync <dir>                    # absorb + rewrite the snapshot; commit it
npm run cli -- memory export <dir> --out mem.jsonl / memory import <dir> --in mem.jsonl
# memory scopes: --scope project (default) | personal | workspace | path | skill | process |
#                technology | security | infra   (search defaults to project; pass --scope to widen)

# ── MCP server (dual transport) ───────────────────────────────────────────────
# The same capabilities, as MCP tools over stdio. Register ONCE at user scope and the
# tools are available in every project (each tool takes `root`, defaulting to the
# workspace the host launched the server in). Skills/AGENTS.md are transport-neutral:
# agents prefer the mcp__leina__* tools when the host exposes them, else the CLI.
# Tools mirror the capability registry: graph_query/affected/path/stats/build/status/
# visualize, impact_analyze, memory_add/search/verified/context/get/update/
# suggest_topic/session (batch via items[]/ids[]), context_build, audit_run, doctor_run.
# Graph tools build the graph on first use; per-repo consent=disabled blocks tool calls.
# CLI-only by design: env exec (names-not-values contract).
npm run cli -- mcp                             # stdio server (hosts launch this)
npm run cli -- mcp register                    # USER-GLOBAL: Claude Code / Cursor / Windsurf
npm run cli -- mcp status                      # read-only per-host registration state
npm run cli -- mcp unregister                  # inverse of register
npm run cli -- activate --mcp                  # or register as part of install/setup
npm run cli -- init <dir> --mcp                # PROJECT-LEVEL .mcp.json (committable, teams)
# manual registration for any host:  command "leina", args ["mcp"]

# ── Env store (variables for skills that call services) ──────────────────────
# Global store at ~/.leina/.env (0600, plain text). NAMES-NOT-VALUES contract:
# an AI agent only ever handles variable names — values enter via hidden TTY prompt
# (or piped stdin for scripts), listings are masked, --reveal requires a real
# terminal, and `env exec` injects values process-to-process so a skill can call an
# authenticated service without the credential ever entering the model context.
npm run cli -- env set MY_SERVICE_TOKEN        # prompts (hidden); or: echo "$V" | ... env set KEY
npm run cli -- env list                         # names + masked values
# (single quotes: the CHILD shell expands the var — the parent never sees the value)
npm run cli -- env exec --only MY_SERVICE_TOKEN -- sh -c 'curl -H "Authorization: Bearer $MY_SERVICE_TOKEN" https://api...'
npm run cli -- env unset MY_SERVICE_TOKEN
# The bundled `authenticated-api` skill is the canonical worked example (SonarQube GET +
# POST, and the stricter argv-free variants: curl -K - via stdin, or a script consuming
# process.env). See assets/skills/authenticated-api/SKILL.md.

# ── Validation & contracts ────────────────────────────────────────────────────
npm run cli -- doctor [<dir>] [--json]       # health report; --json includes repoIdentity + confidence
npm run cli -- verify [<dir>] [--json]       # same checks, exit 1 on fail (CI gate)
npm run cli -- capabilities list [--json]    # the 6 transport-agnostic capabilities + schemas

# ── Impact / audit / events ───────────────────────────────────────────────────
npm run cli -- impact analyze <dir> "<symbol>" [--json]   # code→test→config→service blast radius
npm run cli -- audit <dir> [--format md|json|html]        # source→sink candidate paths + findings[]
npm run cli -- events tail <dir> [--json]                 # local event outbox (off by default)

# ── Visualize / multi-repo workspaces ─────────────────────────────────────────
npm run cli -- visualize <dir> [--out <path>]             # interactive offline HTML graph viewer
npm run cli -- workspace build <dir>                      # merged graph across member repos
npm run cli -- workspace status|detect <dir>              # per-member freshness / detection JSON
npm run cli -- workspace memory context|search <dir>      # federated memory across members
npm run cli -- workspace visualize <dir> [--drilldown]    # constellation (repos as super-nodes)

# ── Sidecars (Java / C# compiler-grade extraction) ─────────────────────────────
npm run cli -- sidecar status                # are the C#/Java sidecars configured?
npm run cli -- sidecar install csharp        # download a prebuilt binary (sha256-verified) — no toolchain needed
npm run cli -- sidecar verify java           # verify against a fixture (honest skip if no toolchain)

# ── SCIP indexers (Go/Rust/Python and beyond — compiler-grade via third-party binaries) ─
npm run cli -- scip status                  # is scip-go/rust-analyzer/scip-python on PATH?
npm run cli -- scip install python          # detect+instruct only — prints the install command
npm run cli -- scip verify python           # verify against a fixture (honest skip if not installed)
```

Example (run against this repo's own `src/`):

```bash
npm run cli -- build src
npm run cli -- affected src "GraphStore"
#   openStore()  [references]  cli/index.ts:L48
```

> **Full command reference:** [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md) documents every
> command, its flags, what it prints, and the implementation entry point behind it.
>
> **How it works (conceptual guide):** [`docs/concepts/`](docs/concepts/README.md) explains the
> internals — graph, memory, search, drift and hooks — with diagrams and storytelling (in Spanish).
>
> **Guided, Q&A-style walkthrough (in Spanish):** [`docs/guides/usage-guide.md`](docs/guides/usage-guide.md)
> covers the same ground as this README and `GETTING_STARTED.md` from a "what can I ask the AI"
> angle, plus a full SDD walkthrough — a good fit for less CLI-fluent teammates.
>
> **All docs, bilingual, in your browser:** [kolimar.github.io/leina](https://kolimar.github.io/leina/)
> hosts the project's full documentation (this README, the guides above, the CLI reference,
> roadmap and more) as a single site with an EN/ES toggle — see [`docs/README.md`](docs/README.md)
> for the full index or generate it locally with `npm run docs:site:build`.

### Batch input (stdin JSON)

`memory save`, `memory update` and `memory get` accept `--batch`: a JSON array on stdin
collapses N writes/reads into one process. `save`/`update` also take `--atomic` for an
all-or-nothing transaction.

```bash
echo '[{"title":"a","content":"x"},{"title":"b","content":"y"}]' \
  | npm run cli -- memory save <dir> --batch --atomic
echo '["id1","id2"]' | npm run cli -- memory get <dir> --batch
```

### Freshness

`query` / `affected` / `path` route through a **freshness gate**: if the sources changed
since the last build, the graph is rebuilt before answering (posture `auto`, the default).
Under posture `refuse` a stale read instructs you to run `refresh` instead. `status` reports
freshness without rebuilding; `refresh` forces a rebuild.

> 📘 **Setup & lifecycle.** Every install command is **reversible** and nothing acts in a repo
> without consent. There are three layers, each with an explicit inverse:
>
> - **Machine, one-shot:** `setup` ⟷ `disable`. `setup` is the "magic" command — it runs
>   `activate` (global share at `~/.leina/share/{skills,agents,workflows}`, symlinked into
>   `~/.config/devin/{skills,agents}`, plus the user-global `Exec(leina)` grant + hooks) and
>   turns on the machine-wide **blanket** sentinel (`~/.leina/.blanket`). `disable` undoes all
>   of it (strip-inverse — preserves third-party entries; no `.bak` reliance).
> - **Global, granular:** `activate` ⟷ `deactivate` (the global half of `setup`, without the
>   blanket sentinel). `install-global` is a deprecated alias of `activate`.
> - **Repo, granular:** `init` ⟷ `deinit`.
>
> **Tri-state consent (per repo, local & git-ignored — `.leina/consent`):** `unknown`
> (no flag) → the Devin gate stays silent and the `leina-setup` skill asks once
> ("use leina here?"); `enabled` → leina acts (memory + graph injection, advisories,
> on-demand `SessionStart` graph self-heal); `disabled` → permanent silent no-op.
>
> **`init` is adaptive** (`isBlanketActive()`): it always writes the `enabled` consent flag +
> `.gitignore`. Under blanket that's all (**LIGHT** — the machine-wide share/grant/hooks already
> cover the repo). Standalone (no blanket) it also writes a committable `AGENTS.md` protocol block,
> `.devin/hooks.v1.json`, and a **repo-local** `Exec` grant in `.devin/config.json` (**FULL**) —
> never the user-global config. `init --name <project-name>` locks the project key in a committable
> `.leina/config.json`; `init --build` builds the graph synchronously now (otherwise the
> graph builds on demand). `deinit` writes `disabled` and strip-inverse removes the repo's managed
> blocks/grant/hooks.

### Memory CLI batch + anchors

`memory save` resolves `--anchors a,b` to real graph nodes so `memory verified` can later
re-check each saved observation against the live graph (drift detection). Pass `--topic <key>`
to evolve an existing entry in place instead of creating a duplicate. Already have
observations saved without `--anchors`? `memory reanchor <dir> [--dry-run]` retro-anchors
them by extracting only *explicit* path/symbol references from their text and verifying each
candidate against the live graph — ambiguous or unresolved mentions are discarded, never
guessed. It's additive and idempotent, so re-running it is always safe.

### Graph explorer server (`graph serve`)

```bash
npm run cli -- graph serve <dir> [--port 7423] [--host 127.0.0.1]
```

A read-only, foreground `node:http` server (zero new dependencies) over the same graph +
anchored memory as the rest of the CLI: a JSON API (`/api/projects`, `.../stats`, `.../tree`,
`.../search`, `.../nodes/:id`, `.../nodes/:id/memories`) plus a small vanilla-JS explorer UI —
project selector, node/edge-kind chips, a folder tree, and a detail drawer with
`declaredBy`/`invokedBy` and drift-badged memories. Binds strictly to loopback and self-registers
the project into `~/.leina/projects.json` (the same registry `build`/`refresh`/`init` upsert
into). Stop it with Ctrl+C. See [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md#graph-serve-dir---port-n---host-h)
for the full flag/config reference.

## Memory & drift detection

The graph holds structure; it can't hold *why* a decision was made. The memory
layer does — decisions, bug root-causes and discoveries persist across sessions.

**Always-on global storage.** Memory is stored in a single global DB at
`~/.leina/memory.db` (or `$LEINA_HOME/memory.db`), keyed by a
**stable project key** derived automatically from the git remote URL, repo root
basename, or directory name. No `init` is required — `memory save` works in any
directory. Use `memory current-project <dir>` to inspect the derived key. Lock it
permanently with `init --name <name>` (writes `.leina/config.json`,
committable, takes priority over all detection steps).

Cross-project isolation is enforced by project key: a `memory search` in repo A
never returns results from repo B.

What makes it more than a notes file: an observation can be **anchored** to graph
nodes (the symbols it talks about). When the code changes, `memory verified`
re-checks each hit against the live graph and labels it **USABLE**, **WARNING** (the
anchored code moved — stale), or **DO-NOT-USE** (a normative claim the code now
contradicts). Memory that quietly goes wrong is worse than no memory; drift
detection is what keeps recalled context trustworthy.

**Migrating from the old per-repo layout.** If you have a `<dir>/.leina/memory.db`
from an earlier version, run `leina memory migrate <dir>` to fold it into the global
DB. The original file is left untouched. `leina doctor <dir>` warns if a legacy DB is
present.

## Languages

| Language | Extraction | Precision |
|---|---|---|
| **TypeScript, TSX** | **ts-morph** (TS compiler API, in-process) | **compiler-grade — 100% resolved, 0 guesses** |
| JavaScript, Go, Python, Java, C#, Kotlin, Rust, Ruby, PHP | tree-sitter (WASM) + import-guided resolution | syntactic |
| Go, Rust, Python (optional) | SCIP indexer (`scip-go`, `rust-analyzer`, `scip-python`) | compiler-grade |
| Java, C# (optional) | semantic sidecar (Roslyn / JavaParser) | compiler-grade |

**Precision ladder.** Every language starts on tree-sitter (syntactic, always available,
zero setup); an optional compiler-grade layer can upgrade it further, in the order
**tree-sitter → SCIP indexer → ts-morph/semantic sidecar**. TypeScript's ts-morph and the
Java/C# sidecars run in-process or as leina-built binaries; a SCIP indexer (`scip-go`,
`rust-analyzer`, `scip-python` today) is a third-party binary you install yourself — the
same "compiler-grade if present, syntactic fallback otherwise" contract, just for tools
leina doesn't own. Ruby (`scip-ruby`) is backlog, pending an empirical fixture validation
(see `backlog/scip-ruby-deferred`). See
[SCIP indexers](#scip-indexers-go-rust-python-and-beyond) below.

**Resolution strategy.** Every call/reference is resolved to its target with a
confidence ladder:
- **TypeScript** goes through the real type checker (ts-morph) — overloads,
  imports, re-exports and generics all resolve exactly. No AMBIGUOUS.
- **Other languages** use tree-sitter with two stacked heuristics:
  1. **Import-guided resolution** — `import { make } from "./auth"` proves a call
     to `make()` targets that module (EXTRACTED, disambiguated by module path).
  2. **Receiver-type inference** (Java/C#) — tracks the declared type of fields,
     `this`, parameters and locals (incl. `var x = new Foo()`), so `x.m()`
     resolves to the right class's method instead of guessing among homonyms.

> ⚠️ **Java/C# note:** ~15% (Java) to ~23% (C#) of call edges remain AMBIGUOUS
> and are dropped from blast radius. C# trails because `var` from method returns
> and LINQ/extension chains need real type inference. Structural edges
> (`extends`, `implements`, `contains`) and class references are reliable. The
> semantic sidecar lifts call precision to compiler grade.

### Confidence ladder

Every call/reference edge is tagged so the assistant knows what was proven vs
guessed:

- `EXTRACTED` — same-file unique match, or compiler-resolved by the sidecar.
- `INFERRED` — cross-file unique-name heuristic.
- `AMBIGUOUS` — multiple candidates; first kept and **flagged** (not silently
  dropped).

## Semantic sidecars (C# and Java)

tree-sitter is syntactic: it sees a call to `bar` but can't always tell *which*
`bar`. For C# and Java we delegate to a real compiler front-end — Roslyn for C#,
JavaParser's symbol solver for Java — so cross-file calls, overloads, generics
and inheritance resolve to the exact symbol and edges are compiler-proven
(`EXTRACTED`).

### Source ships as templates, built on demand

The sidecar **sources** are not committed as `.cs`/`.java` files — they ship as
inert `.tmpl` text under `assets/sidecars/**`. That keeps this repo a pure
TypeScript/Node project (so a strict TypeScript-only quality pipeline never trips
over foreign-language source), while the templates still travel inside the
published npm package.

When a target repo actually contains Java/C# files, build the sidecar once:

```bash
leina sidecar build          # build whatever the local toolchain supports
leina sidecar build csharp   # or a single language
leina sidecar status         # show what's built + which tools are missing
```

This materialises the templates and invokes the local toolchain, then caches a
self-contained binary (C#: single file; Java: a jpackage app-image with a bundled
JRE) under `~/.leina/sidecars/<lang>/dist`. Subsequent graph builds reuse
it — running the cached binary needs **no** .NET/JVM installed.

`leina build` can also build the sidecar implicitly on first use when you
opt in with `LEINA_BUILD_SIDECARS=1`; otherwise it prints a one-line
advisory and falls back to tree-sitter. If a sidecar isn't built, that language
degrades to tree-sitter automatically — the graph still builds, just syntactically.

Override the auto-detected binary (or point at a prebuilt one) with an env var:

```bash
export LEINA_CSHARP_SIDECAR="/path/to/RoslynGraph"
export LEINA_JAVA_SIDECAR="/path/to/JavaGraph"
```

### Build requirements (only when you build a sidecar)

Building needs the language toolchain on PATH; running the cached binary does not.

- **C#** → the .NET SDK (`dotnet`). Private/enterprise NuGet mirrors work via the
  usual `NuGet.config`.
- **Java** → a JDK 17+ that includes `jpackage`, plus `curl` (fetches the
  JavaParser jars). Point at a Maven mirror with `LEINA_MAVEN_BASE`. See
  `assets/sidecars/java/README.md` for the underlying steps.

Both sidecars run **once over the whole project** (not per file) so the compiler
builds one model and resolves calls across files. The Java sidecar infers source
roots from package declarations, so multi-module layouts resolve correctly. See
`src/infrastructure/extractors/semantic/sidecar.ts` for the JSON contract. GraalVM `native-image`
(single-file Java binary), a `.sln`-aware Roslyn mode and Eclipse JDT are future
upgrades.

## SCIP indexers (Go, Rust, Python and beyond)

[SCIP](https://sourcegraph.com/docs/scip) is a protobuf-based compiler-grade code
intelligence index format with an indexer per language (`scip-go`, `rust-analyzer`,
`scip-python`, ...). Unlike the C#/Java sidecars above — leina-owned binaries built
from templates it ships — a SCIP indexer is a **third-party tool you install yourself**
via that language's own package manager; leina only detects it and, once present, uses
it for compiler-grade extraction. It never downloads, builds, or auto-installs one.

```bash
leina scip status            # is scip-go/rust-analyzer/scip-python on PATH?
leina scip install python    # detect+instruct only — prints the install command, never runs it
leina scip verify python     # verify against a fixture (honest skip if the indexer is missing)
```

Today this covers Go via [`scip-go`](https://github.com/scip-code/scip-go):

```bash
go install github.com/scip-code/scip-go/cmd/scip-go@latest
```

Rust via [`rust-analyzer`](https://rust-analyzer.github.io/)'s built-in `scip`
subcommand (no separate indexer project — one `rustup` component):

```bash
rustup component add rust-analyzer
```

and Python via [`scip-python`](https://github.com/sourcegraph/scip-python) (an npm
package; a working `pip` on `PATH` is also required — e.g. any venv's `bin/`):

```bash
npm install -g @sourcegraph/scip-python
```

Once the indexer for a language is on `PATH`, `leina build`/`refresh` automatically
upgrade that language's files from tree-sitter to compiler-grade: the indexer runs once
over the whole project (same whole-project contract as the sidecars — for Rust, a
single `rust-analyzer scip .` at the workspace root covers every crate in a Cargo
workspace), the resulting `.scip` index is streamed Document-by-Document by a
hand-rolled protobuf parser (no new dependency —
`src/infrastructure/extractors/semantic/scip-proto.ts`), and every SCIP symbol is
translated to the SAME graph id tree-sitter/ts-morph would produce for that symbol, so
nothing duplicates — it merges. Without the indexer, that language's extraction is
unchanged (tree-sitter, syntactic); nothing else about the build is affected.
scip-python never populates `SymbolInformation.kind`/`display_name` — leina derives both
the node kind and the label from the symbol's own descriptor chain instead, and flattens
nested functions (two same-named closures collapse to one id, matching tree-sitter's own
behavior). Ruby (`scip-ruby`) is backlog, pending an empirical fixture validation — see
`backlog/scip-ruby-deferred`.

## Project layout

Hexagonal layout — `domain` (types + ports) ← `application` (use-cases) ← `infrastructure`
(adapters) ← `cli` (driving adapter):

```
src/
├── domain/          graph/{model,ports} · memory/{model,ports} · install/artifact · shared/{batch,id}
├── application/     graph/{build,query,manifest,sources,resolve,detect,dedup} · memory/{query,anchor-verify}
│                    · project/detect-key · install/{agents,command,devin-hooks,devin-skills,migrate,permissions,port,protocol,gitignore} · activate
├── infrastructure/  sqlite/{graph-store,memory-repository,schema} · extractors/{treesitter,semantic/*}
│                    · config/freshness · install/{global,share-paths,symlinks,native-assets,shell,safe-exec}
├── cli/             index (dispatcher) · wiring (composition root) · handlers/{graph,memory,install,system}
│                    · args · io · doctor · agent-gate · active-context
└── version.ts
```

## Status

Validated end-to-end on fixtures for all 7 languages and on real open-source repos:

| Repo | Lang | Nodes | EXTRACTED |
|---|---|---|---|
| [zod](https://github.com/colinhacks/zod) | TS (ts-morph) | 2.2k | **100%** |
| [gson](https://github.com/google/gson) | Java | 4.4k | 78% |
| [jackson-core](https://github.com/FasterXML/jackson-core) | Java | 5.7k | 77% |
| [Dapper](https://github.com/DapperLib/Dapper) | C# | 2.2k | 72% |
| [Newtonsoft.Json](https://github.com/JamesNK/Newtonsoft.Json) | C# | 9.2k | 69% |
| [Polly](https://github.com/App-vNext/Polly) | C# | 5.8k | 65% |

TypeScript is compiler-grade (ts-morph). For Java/C#, three syntactic techniques
stack up — import-guided resolution, then **receiver-type inference** (fields,
`this`, parameters and locals: `JsonReader in` → `in.nextString()` resolves to
`JsonReader`). Java reaches 77–78% EXTRACTED; C# trails at 65–72% because it
leans on `var` from method returns and LINQ/extension-method chains that only a
real type checker (the sidecar) can follow.

Dogfooding on these repos surfaced and fixed several real extraction bugs (Go
receiver methods, `new` expressions, generic-type heritage, constructor/class
name collisions). Typechecks clean (`npx tsc --noEmit`); the CLI test suite
(`npm test`) passes.

## Roadmap

1. ✅ Graph layer.
2. ✅ `memory` module — persistent decisions/bugs (the *why* the graph can't hold),
   with graph-anchored drift detection.
3. ✅ `sdd` workflow — the design and tasks phases scope impact with `leina affected`
   before deciding, wired into the always-on protocol (`AGENTS.md`).
   Devin gets the SDD phases as custom subagent profiles (one AGENT.md per phase) and a
   delegating skill per phase, plus a `leina-sdd` orchestrator skill that drives the
   full flow — all installed globally by `leina activate`.
4. Clustering / god-nodes for very large codebases.

## License

[MIT](LICENSE) © Alejandro Alfonzo
