# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [2.1.0] — Unreleased

### Added
- **Harness subsystem (absorbed from the standalone `harness-framework`).** Lifecycle rules (intake → plan → execute → verify → deliver) + executable gates, task contracts enforced against the real git diff, and multi-platform sync — now native to leina, zero new dependencies (hand-rolled validators instead of zod, JSON front matter instead of YAML, `safe-exec` instead of execa, own glob matcher calibrated against picomatch).
  - `leina harness contract new|show|edit|end`, `verify`, `sync [--check|--force|--platforms]`, `list`, `hook <event>`.
  - 14 builtin rules under `assets/harness/rules/` (JSON front matter); the four leina rules (`memory-first`, `graph-consult`, `graph-fresh`, `session-summary`) ship **enabled by default** — `leina init` bootstraps `.harness/config.json`, runs a harness sync in-process and leaves the repo governed; `deinit` reverses it via the sync lockfile.
  - **Agent-gate enforcement** in trusted workspaces (see *Workspace trust*): the integrity seal always applies; scope checks, the commit/push guard and the Stop gate (retry cap, then honest yield) apply with an active contract, in strict mode, or when the config cannot be read.
  - 5 new capabilities in the registry (22 total), exposed as MCP tools: `harness_contract_new/show/end`, `harness_verify`, `harness_rules_list`.
  - `leina tui` → new **harness flow**: guided contract interview (goal/scope/criteria), recipe suggestions, rule selection with non-weakening constraints, status/verify/sync panels.
  - Platform adapters (CLAUDE.md / AGENTS.md managed blocks, skills, Cursor/Windsurf/OpenCode hook wiring via `leina harness hook`) with the same lockfile and marker format as the standalone framework; on Claude Code/Devin enforcement rides the leina agent gate instead of separate hooks.
- **Rule presets.** `leina init --harness-preset generic|leina-native` seeds a new `.harness/config.json`: `generic` disables the four leina-coupled rules so the harness works without adopting the rest of leina; `leina-native` (default) keeps the full suite.
- **Workspace trust.** An out-of-repo record (`$LEINA_HOME/trust/`, keyed by the repo's real path) written by `leina init` and removed by `deinit`; every automated harness path and every project-layer executable gate requires it. `leina doctor` reports it.
- `leina memory compact <dir> [--keep N] [--sessions-older-than DAYS] [--dry-run]` — GC superseded topic snapshots (live rows always kept), optionally purge idle sessions, then `VACUUM`.
- `leina query --json` (the flag was advertised but not implemented).

### Changed
- **MCP `root` is confined to the server workspace** — after resolving symlinks; roots outside it are rejected unless allow-listed with `LEINA_MCP_ALLOW_ROOTS`. `graph_visualize`'s `out` is confined the same way and must end in `.html`.
- **MCP `memory_context` returns previews by default** (`preview`, `truncated`, `contentChars` instead of the full `content`); `full: true` restores full bodies, `limit`/`sessionLimit` bound the payload.
- MCP `impact_analyze` resolves `symbol` like the CLI and returns `{seed, impacted, note?}`; numeric MCP arguments are integers clamped to fixed bounds; `root` is optional on every tool.
- Harness hooks, unattended verify and MCP `harness_verify` do nothing in a workspace that is not trusted on this machine — run `leina init` there once (also after moving or re-cloning a repo). A committed `.leina/consent` grants nothing. The advisory agent-gate hooks (memory injection, background self-heal build) require trust too.
- Harness config: `rules.<id>` overrides accept only `enabled`/`severity` (a `gate` key is an error); user and local layers can no longer weaken a blocking rule (disable, demote, or change its gate/phase/scope) nor lower `strictness`; an invalid config makes the hooks fail closed.
- `harness verify`: only full runs update the report the commit guard reads; an unknown `--rule`, a flag without a value or an unknown sub-command exits 2; outside git it fails closed; changed files are relative to the harness root (monorepo packages); `--json` includes `loadErrors`. `contract new --max-retries` must be 1–10, and `maxRetries` now counts blocks per stop chain, with a fresh verify on every Stop.
- The commit guard decides report freshness from working-tree content (a fingerprint recorded by verify) instead of file mtimes; reports from older versions count as stale.
- `harness sync --platforms` only touches the named platforms (an unknown id exits 2); sync compiles only committed layers (builtin + project rules + project config); `init --hosts` keeps previously synced or auto-detected platforms; `deinit` removes the config `init` wrote while it is unchanged.
- `memory import`/`sync` validate every line (sizes, enums, shapes; any invalid line fails the run), clamp timestamps, skip ids that belong to another project and do not resurrect compacted snapshots; `memory get`/`update` (CLI and MCP) only see the current project's ids.
- Raised the `@modelcontextprotocol/sdk` range to `^1.32.1`.

### Security
- A cloned repo could run its own code through the harness without `leina init`: via a `gate` override in `.harness/config.json`, a committed `.leina/consent`, or a repo-root module shadowing a builtin js gate. Fixed by the out-of-repo trust store, rejecting config gate overrides and per-layer module resolution.
- A crafted `.harness/harness.lock.json` could make `deinit` / `sync --force` delete or write files outside the repo; lockfile paths are now validated and every write/delete is confined by real path.
- MCP: a symlink inside the workspace escaped `root` confinement, and `graph_visualize` could overwrite any file the user can write.
- `memory import`/`sync` of a shipped `.leina/memory-export.jsonl` could overwrite another project's memories (later auto-injected into that project's sessions); id lookups crossed projects.
- Stored XSS in the offline graph viewer through repo folder names / repo keys.
- Rule-supplied regexes (command, diff-content and file gates) run under a hard timeout (ReDoS); diff-content failures report only `file:line` plus a masked prefix, never the matched secret; the untracked-file scan never follows symlinks; the no-secrets rule catches more credential shapes.
- The agent cannot edit `$LEINA_HOME/harness` (user rules) or the trust store; the pre-bash integrity guard reasons about write targets instead of mentions.
- The env store is written atomically with owner-only permissions.
- All `npm audit` advisories resolved (MCP SDK transitive express/hono/ajv stack, brace-expansion, js-yaml, undici, source-map-js).

### Fixed
- `graph_visualize` could terminate the whole MCP server on a refused stale graph; concurrent MCP calls on a stale graph each rebuilt it (and `graph_stats` could read a half-written graph) — builds are now single-flight per root.
- MCP `impact_analyze` always returned empty results for a symbol name; `memory_verified` ignored `type`.
- Source files over 4 MiB are skipped consistently by the build and the freshness check.
- The NOCASE label index retrofit no longer blocks a read when another process holds the write lock.
- `memory compact` reports a locked db or a failed `VACUUM` without a stack trace and does not report a grown db while another process holds it open.
- `env set`/`unset` match keys the parser accepts (`KEY =value`) and collapse duplicates.
- Harness: commit detection and the integrity guard handle `&`, subshells and backticks; strict mode and the integrity seal now also apply on Claude Code/Devin and Cursor's shell hook makes the same decision as pre-bash; the OpenCode plugin blocks only on exit status 2; `.harness/state/` ignores itself; `hookCommand` must be a leina launch form; the TUI writes rule overrides only after the contract is confirmed; deinit preserves user JSON verbatim and writes atomically.
- The root and `memory` help showed `memory <dir> <sub>`; the dispatcher reads `memory <sub> <dir>`.
- Tests no longer write into the developer's real `~/.leina`.

### Performance
- A NOCASE label index serves `findByLabel`'s exact branch; the freshness gate and a stale-triggered rebuild share one source walk.

### Documentation
- CLI reference (EN/ES): `memory compact`, `graph gc`, `query --json`, `init --harness-preset`, `setup`/`activate` asset selection, the MCP confinement and argument rules, memory import/sync rules, env store limits, and the harness/trust behaviour.
- Concepts chapter 7 (EN/ES): rule presets, the hook/gate vocabulary map, workspace trust.
- Benchmarks: corrected the warm-cache and read-path scaling claims.

## [2.0.1] — 2026-07-09

### Fixed
- `repair` no longer aborts on a repo that carries committed init evidence (AGENTS.md / .gitignore) when the machine has no persisted host selection. It now skips the project re-wire with an advisory note and still runs its remaining phases (shell-wrapper, doctor) — consistent with repair's fail-open, never-picks-a-host contract. `init` still requires an explicit `--hosts`.

## [2.0.0] — 2026-07-08

### Changed
- **Explicit host selection (breaking).** `setup`, `activate` and `init` now require an explicit `--hosts` — leina never selects an AI host for you. When it's missing, the command shows which hosts it detected and stops.
- **Explicit init profile (breaking).** A full `leina init` now requires `--profile devin|windsurf`.
- **Explicit MCP hosts (breaking).** `--mcp` on `setup`/`activate` now requires `--mcp-hosts`, and `leina mcp register` requires `--hosts`.

### Added
- `graph gc` — prune projects that no longer exist from the global registry.
- Launch the read-only graph explorer directly from `leina tui`.
- `doctor` now reports an `info` severity for optional and not-applicable checks, with colour output and the info items grouped at the end.

### Removed
- The `install-global` command (use `activate`), the `--agent` init flag (use `--profile`), and the `memory migrate` command.

### Documentation
- Refreshed the English and Spanish docs to match the current CLI.

## [1.1.3] — 2026-07-07

### Documentation
- Updated the benchmark's retrieval-recall section (EN + ES) to match the type-annotation
  reference edges already shipped in the extractor. The docs still framed type-only recall as a
  4.5% blind spot against 95.1% value recall; the current snapshots show **100% value recall**
  and **98.2% type-only recall**. Rewrote the bars, table, and narrative accordingly — the
  residual ~2% is dynamic-import destructuring, tracked in the backlog.

## [1.1.2] — 2026-07-07

### Fixed
- `--help` / `-h` after a subcommand no longer gets consumed as the `<dir>` positional.
  Commands that read `<dir>` from their first argument (`status`/`stats`/`affected`/`path`/
  `query`) treated `--help` as a directory — an earlier build even created a stray
  `--help/.leina/graph.db`. The dispatcher now intercepts `--help`/`-h` and prints help, and
  those handlers reject a leading `--` token as a directory (matching `build`/`refresh`/
  `serve`/`visualize`). Covered by a 10-case regression test.

### Documentation
- Clarified that `visualize` and `graph serve` are **different tools**, not two forms of the
  same view: `visualize` exports a static, shareable `.html` file for one project; `graph serve`
  runs a live local server with a multi-project selector and per-node anchored memory. Added a
  comparison table to the getting-started guide, listed `graph serve` in the usage guide's visual
  tools (it was missing), and cross-referenced both ways in the README and CLI reference — all in
  both languages. Also translated the `graph serve` sections that were missing from the Spanish
  README and CLI reference.

## [1.1.1] — 2026-07-07

### Fixed
- `bin.leina` in `package.json` normalized (`./dist/cli/index.js` → `dist/cli/index.js`),
  silencing the warning npm already auto-corrected at publish time. No functional change.

### Documentation
- Reoriented the install docs around the **published package**. `readme.md`,
  `GETTING_STARTED.md` and the usage guide now lead with `npm install -g @kolimar/leina` +
  `leina tui` as the primary path (a three-command Quickstart) and demote the from-a-clone
  workflow to `CONTRIBUTING.md`. The README "Usage" examples switched from the clone form
  `npm run cli -- <cmd>` to `leina <cmd>`.
- New **"Connect it to your AI"** section documenting the two integration surfaces: the
  universal **MCP server** (`leina mcp`, stdio) with a per-host registration table — Claude
  Code, Cursor, Windsurf (auto via `leina mcp register`), plus VS Code, OpenAI Codex CLI,
  Gemini CLI, LM Studio, Zed, Cline and JetBrains/Junie (manual, with each host's config
  location and format) — and the **hooks** auto-injection, now explicitly scoped to Devin and
  Claude Code (every other host calls the MCP tools on demand). Corrected the asset-link host
  list to Devin and Claude Code only (Cursor/Windsurf consume MCP, not the skills/agents share).
- Applied across both languages: `GETTING_STARTED.md` / `docs/i18n/es/getting-started.md`,
  `docs/guides/usage-guide.md` / `docs/i18n/en/usage-guide.md`, `readme.md` /
  `docs/i18n/es/index.md`.

## [1.1.0] — 2026-07-06

### Added
- **`leina graph serve`**: a read-only, foreground HTTP server (`node:http`, zero new
  dependencies) exposing the graph + anchored memory of a project as a JSON API
  (`/api/projects`, `.../graph`, `.../stats`, `.../tree`, `.../search`, `.../nodes/:id`,
  `.../nodes/:id/memories`), plus a vanilla-JS explorer UI: the full graph renders up
  front (force layout frozen after stabilization, node size by degree, labels appear as
  you zoom), with a live search dropdown, kind/relation filter chips (structural
  `contains` off by default), a collapsible folder tree, a node drawer listing every
  incident relation in both directions as navigable groups, and drift-badged memory
  cards (title/date/preview, expandable). Binds strictly to loopback, supports an
  optional constant-time-compared auth token (`LEINA_SERVE_TOKEN`), and self-registers
  the project into a new global registry (`~/.leina/projects.json`, also upserted by
  `build`/`refresh`/`init`).
- **`leina memory reanchor`**: conservatively retro-anchors existing observations by
  extracting only explicit path/symbol references from their text and verifying each
  candidate against the live graph before minting — ambiguous or unresolved candidates are
  discarded. Additive and idempotent per `(observation_id, node_id)`; supports `--dry-run`.
- **Type + value references in the ts-morph extractor**: `affected` under-reported blast
  radius because type-only dependents (`import type`, annotations) and imported symbols used
  as values but never called produced no edges. Two new pass-2 walks emit compiler-proven
  `references` edges — type-only recall rose 4.5% → 98.2%, and interfaces like `GraphNode`
  (0 → 221 dependents) and `GraphEdge` (0 → 198) stopped reporting "nothing depends on it".

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
- **MCP server** (`leina mcp`, stdio): the versioned capability registry (17 contracts)
  exposed as 19 tools; `init --mcp` registers it in the project `.mcp.json`.
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
