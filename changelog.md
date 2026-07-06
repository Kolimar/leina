# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-07-06

### Fixed
- Concurrent multi-process access no longer fails intermittently with `SQLITE_BUSY`:
  `graph.db` and the global `memory.db` are now opened with a 5s `busy_timeout`, and
  the GraphStore constructor skips its schema DDL when the db is already stamped at
  the current version (opens used to execute write DDL on every open, colliding with
  a concurrent build). Covered by a multi-process regression test.
- Project keys no longer silently re-home when a git remote is added after `init`:
  `init` now auto-pins the derived key in `.leina/config.json` (config-lock), and
  `memory current-project`/`search`/`context` print an actionable hint when the
  resolved key has no memories but a previously-derived key does (e.g. memories
  saved under the dir-basename key before the remote existed), including the exact
  `memory merge-projects` command to recover them. `--name` writes are now
  merge-safe (sibling keys like `project_key_format` are preserved).
- Graph source discovery now skips conventionally-named minified artifacts
  (`*.min.js`, `*.min.css`, …): a vendored bundle used to flood the graph with
  meaningless one-letter god nodes and re-stale it on every copy. The workspace
  cross-repo scanner applies the same filter.
- Graph source discovery now skips .NET build outputs (`obj/`, `bin/`): generated
  files (`*.g.cs`, `AssemblyInfo.cs`) were indexed as sources, inflating the file
  count and re-staling the graph after every `dotnet build`. The workspace
  cross-repo scanner skips them too, matching the Roslyn sidecar's ignore list.

## [1.0.0] — 2026-07-05

Initial public release of **leina** — Linked Engineering Intelligence Network for Agents.

### Graph
- Queryable code knowledge graph (SQLite via `node:sqlite`, zero native deps) with a
  freshness gate: `query`/`affected`/`path` auto-rebuild when sources changed.
- **11 languages**: TypeScript/TSX compiler-grade via ts-morph; JavaScript, Go, Python,
  Java, C#, Kotlin, Rust, Ruby and PHP via tree-sitter with import-guided resolution and
  receiver-type inference; optional Roslyn/JavaParser sidecars lift Java/C# to compiler
  grade (`sidecar build` locally, or `sidecar install` — sha256-verified prebuilt binaries).
- Per-file extraction cache (content-hash) for incremental rebuilds; `build --profile`
  reports per-stage timings. Word-wise query scoring (camelCase/snake_case subtokens).
- `impact analyze` (code→test→config→service), `audit` (source→sink reachability),
  workspace federation for multi-repo checkouts, offline HTML visualizers.

### Memory
- Always-on project memory (global DB keyed by a stable project key) with graph-anchored
  **drift detection**: `memory verified` classifies recalls as USABLE / WARNING / DO-NOT-USE.
- **Portable memory**: `memory export/import` (JSONL, deterministic merge) and
  `memory sync` with a committable `.leina/memory-export.jsonl` snapshot — decisions
  travel with the repo, no server.

### Agent integration
- **MCP server** (`leina mcp`, stdio): the versioned capability registry (14 contracts)
  exposed as 15 tools; `init --mcp` registers it in the project `.mcp.json`.
- Host-neutral advisory hook gate (consent-scoped, never blocks): Devin
  (`.devin/hooks.v1.json`) and Claude Code (`init --claude-hooks` →
  `.claude/settings.json`) share one gate; `AGENTS.md` protocol block for every host
  that reads it.
- Multi-host asset linking (`activate --hosts devin,claude`) from a versioned share, with
  selective installation from a catalog (`--preset minimal|sdd|full`, `--skills`,
  `--agents`) and dependency closure.
- Bundled skills/agents: SDD workflow (spec→design→tasks, impact-scoped), reviewers,
  PR workflows, docs aids.

### Install & operations
- One-shot `setup` ⟷ `disable`; granular `activate` ⟷ `deactivate`, `init` ⟷ `deinit`
  (adaptive LIGHT/FULL, tri-state per-repo consent, all writers idempotent + merge-safe).
- `doctor` (read-only diagnosis incl. Node floor, WASM parser assets, host links) and
  `repair` (re-runs the idempotent writers, respects opt-outs, never touches DBs).
- `leina tui` interactive console; `leina env` credential store under a names-not-values
  contract (0600, masked listings, `env exec` process-to-process injection).
- Node ≥ 22.13 gate at startup with version-manager advice; no install scripts —
  clean installs under npm, pnpm, bun and `--ignore-scripts`.
- CI on Linux/macOS/Windows × Node 22/24; provenance-attested release workflow.
