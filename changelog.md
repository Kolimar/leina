# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [3.0.0] — Unreleased

3.0.0 ships the never-published 2.1.0 work (the task harness and a security review) together with a functional review of detection, agent ergonomics and performance. Several defaults, CLI outputs and MCP payloads changed — read *Upgrading from 2.x* first.

### Upgrading from 2.x
- **Re-run `leina setup --hosts …` (or `leina activate --hosts …`) once.** It rewrites the user-global hooks to the 3.0 command form (`leina agent-hook <Event> --host claude|devin --scope user`) and now also wires **Claude Code** (`~/.claude/settings.json`); `--no-user-hooks` opts out. Run `leina doctor` afterwards: it now flags hooks that still run another leina install.
- **Run `leina init` once in every repo you use with leina on this machine** (also after moving or re-cloning it). Hooks, memory injection and harness automation now require an out-of-repo workspace trust record that only `init` writes; a committed `.leina/consent` grants nothing.
- **The task harness is opt-in.** `leina init` sets it up only with `--harness` (or `--harness-preset`); repos that already have `.harness/config.json` keep it.
- **The first graph read after upgrading rebuilds the graph once** (manifest v3, new TypeScript extractor schema).
- **The memory database migrates on first open** (schema v8): observations stored with the invalid type `note` become `discovery`, topic snapshots stranded by an older `merge-projects` are re-homed, and lifecycle columns are added. Copy `~/.leina/memory.db` first if you want a backup.
- **CLI scripts:** usage errors now exit **2** (an unknown command used to print the root help and exit 0); `<dir>` is optional and resolves to the project root, so `leina build packages/x` in a package that is not its own leina project acts on the repository (`leina init packages/x` makes it one); an explicit `<dir>` that does not exist is a usage error; `affected`'s depth is `--depth N`; `stats` exits 1 without a graph; `status` and `memory current-project` print `root:` first.
- **MCP consumers:** graph and memory tools answer in compact JSON with new shapes (see *Changed*), `root` is confined to the server workspace, and `affected`-style lookups take exact symbols only.

### Added
- **Per-command help and a usage contract.** `leina <command> --help`, `-h` and `leina help <command>` print that command's own usage, rendered from one command table that also drives dispatch and flag checks. Exit codes: 0 success, 1 runtime failure, 2 usage error (`leina <command>: <message>` + `run 'leina <command> --help' for usage`), with `did you mean` suggestions for commands and flags, a hint for a swapped sub-command order, and `--flag=value` for value flags.
- **Optional `<dir>`** on every per-project command, resolved to the project root: the nearest enclosing leina project (graph, consent flag or name lock), else the git toplevel, never crossing a git toplevel. Positional rules are fixed per command (`query [<dir>] <text…>`, `affected [<dir>] <symbol>`, `path [<dir>] <from> <to>`, `memory get [<dir>] <id>`, …); `init`, `deinit` and the workspace commands take `<dir>` as given.
- `impact analyze --depth`.
- **Task harness (absorbed from the standalone `harness-framework`), opt-in.** Lifecycle rules (intake → plan → execute → verify → deliver) with executable gates, task contracts checked against the real git diff, and multi-platform sync — native to leina, with no new dependencies (own validators instead of zod, JSON front matter instead of YAML, `safe-exec` instead of execa, own glob matcher calibrated against picomatch).
  - `leina init --harness [--harness-preset generic|leina-native]` seeds `.harness/config.json` and syncs the platform files; `deinit` reverses it through the sync lockfile.
  - `leina harness contract new|show|edit|end`, `verify`, `sync [--check|--force|--platforms]`, `list`, `hook <event>`.
  - 14 builtin rules under `assets/harness/rules/`. Presets: `leina-native` (default) keeps the four leina rules (`memory-first`, `graph-consult`, `graph-fresh`, `session-summary`); `generic` leaves them out so the harness works without adopting the rest of leina.
  - Agent-gate enforcement in trusted workspaces, on Claude Code and Devin: the integrity seal always applies; scope checks, the commit/push guard and the Stop gate (retry cap, then an honest yield) apply with an active contract, in strict mode, or when the config cannot be read.
  - 5 new capabilities (22 in total), exposed as MCP tools: `harness_contract_new/show/end`, `harness_verify`, `harness_rules_list`.
  - `leina tui` → **harness flow**: guided contract interview, recipe suggestions, rule selection with non-weakening constraints, status/verify/sync panels.
  - Platform adapters (CLAUDE.md / AGENTS.md managed blocks, skills, Cursor/Windsurf/OpenCode hook wiring through `leina harness hook`) with the standalone framework's lockfile and marker format.
- **Workspace trust.** An out-of-repo record (`$LEINA_HOME/trust/`, keyed by the repo's real path) written by `leina init` and removed by `deinit`. Every automated harness path, every project-layer executable gate and the advisory hooks require it. `leina doctor` reports it.
- **Claude Code wiring.** `setup`/`activate` merge the managed hooks into `~/.claude/settings.json` (backup on the first change; a malformed file is left untouched and reported); project wiring (`init --hosts claude`) gains **PreToolUse** for Edit/Write/MultiEdit/NotebookEdit/Bash, so harness enforcement finally runs on Claude Code.
- **Memory lifecycle.** `leina memory resolve <dir> <id> [--note …] [--obsolete]`, `leina memory reopen <dir> <id>` (both with `--batch`), `memory update --status/--resolution`, MCP `memory_update {status, resolution}`. Resolved and obsolete notes leave the injected context; search, `get` and `verified` still return them, labelled and demoted. Short ids work on every id verb.
- `leina memory compact <dir> [--keep N] [--sessions-older-than DAYS] [--keep-sessions N] [--dry-run]` — GC superseded topic snapshots (live rows are always kept), optionally purge idle sessions (the newest N, default 5, always survive), then `VACUUM`.
- **Symbol selectors** for `affected`, `path` and `impact`: a raw node id, `path/to/file.ts:name` (path suffix or absolute), `name` / `name()`, `Class.method` / `Class#method`, or a file path suffix for the module.
- `leina query --json` (advertised before but not implemented) and `--include-tests` (MCP `includeTests`).
- **TypeScript graph:** nodes for type aliases, enums, variables and accessors; object-literal members as methods and an anonymous default export as `default()`; member-level `implements` and `overrides` edges; module → module `imports` edges.
- `leina doctor`: hook-wiring diagnostics — hooks that run another leina install or a missing CLI, leftover per-edit refresh entries, AI hosts with no hooks at all, committable `.leina` files hidden by `.gitignore` — and an injection-readiness check that requires consent, trust and wiring. `leina repair` fixes the install-side ones.
- `leina status` and MCP `graph_status` list reduced-precision extraction (`degraded`).

### Changed
- **Hooks**
  - Managed hook commands name their host and scope: `agent-hook <Event> --host claude|devin [--scope user]`. Entries written by 2.x keep working (the host is inferred) and are rewritten by `setup`/`activate`/`init`/`repair`.
  - A user-global hook stays silent for an event the project's own wiring already handles, so every event is answered once.
  - Hooks act on the project when they fire in a subdirectory, in a worktree under `.claude/worktrees/`, or in a linked git worktree.
  - Advisories reach Claude Code as `hookSpecificOutput.additionalContext` (Claude Code never shows the model the stderr of a hook that exits 0). The Stop save nudge appears at most once per session and never while `stop_hook_active`; the injection fallback at most once per session.
  - Session markers survive `resume` and compaction; only `startup`/`clear` reset them.
  - Devin project hooks no longer run `leina refresh` after every edit — the read path rebuilds lazily, incrementally and under a cross-process lock.
  - The Stop gate reuses the last full verify when HEAD, the working tree, the rules, the config, the contract and trust are all unchanged.
- **Graph reads**
  - `affected`, `path` and `impact` match symbols exactly: an ambiguous name uses the best match and prints the alternatives; no match prints `no exact match for "X"; did you mean: …` and exits 1 (MCP: `seed: null` + `suggestions`). There is no substring fallback any more.
  - `affected` on an implementation also reports the callers of the interface member or base method it implements/overrides (`via Interface.member`).
  - `affected`/`path` print the call-site `file:line` from the edge; `path` prints the real direction (`--rel-->` / `<--rel--`).
  - `query` ranks by relevance (EN/ES stopwords, identifier splitting, IDF weighting), excludes test/mock/fixture nodes unless `--include-tests`, lists every node and edge with `file:line`, returns at most 25 nodes by default and omits `contains`/`method` edges; `--json` is `{seeds, nodes, edges, testsExcluded}`.
- **MCP**
  - `graph_query`, `graph_affected`, `graph_path` and `impact_analyze` answer in compact JSON: nodes `{id, label, kind, at}`, edges `{source, target, relation, at}`; `graph_affected.dependents` and `graph_path` (`{path: {nodes, edges}}`) changed shape. The `memory_*` tools answer in compact JSON too.
  - Graph and memory tools act on the project their root belongs to (nearest leina project, else the git toplevel), like the CLI's `<dir>`: a server launched in a subdirectory uses the repository's graph, memory and consent flag instead of building a second graph there.
  - `memory_context` returns ranked, active-only previews (default limit 20; `full: true` for whole bodies).
  - `root` is confined to the server workspace after resolving symlinks; roots outside it are rejected unless allow-listed with `LEINA_MCP_ALLOW_ROOTS`. `graph_visualize`'s `out` is confined the same way and must end in `.html`. Numeric arguments are integers clamped to fixed bounds; `root` is optional on every tool.
- **Memory**
  - The injected context ranks active notes by type × recency, keeps at most 2 per topic prefix, shows short ids and dates, and includes the latest session summary; CLI `memory context`, MCP `memory_context` and the hooks share one renderer.
  - Search uses one ranking for FTS5 and the Node 22 LIKE fallback: accent-insensitive, prefix matches fill in below exact hits, recency and status weigh in, higher score is better.
  - Type and scope are validated on every write path (CLI, batch, MCP).
  - Drift checks fingerprint the anchored symbol's own lines (`sym1:` anchors) instead of the whole file; a drifted `decision`/`preference` is WARNING, `resolved` caps at WARNING and `obsolete` is DO NOT USE. `memory reanchor` upgrades 2.x anchors in place and no longer mints junk anchors (short or generic names, test-only matches).
  - Subdirectories and linked worktrees share the repository's project key; `.leina/config.json` is found by walking up.
  - `merge-projects` moves topic history too; `memory import`/`sync` validate every line, clamp timestamps, skip other projects' ids and do not resurrect compacted snapshots; `memory get`/`update` only see the current project's ids.
- **Build and freshness**
  - `leina refresh` always re-extracts every file instead of reusing the extraction cache.
  - A graph that fell back to tree-sitter for lack of a compiler sidecar goes stale once one is built, installed or configured, so the next read uses it; `leina scip install` and the degraded note remind to `leina refresh` after installing a SCIP indexer.
  - Sources are discovered through `git ls-files` (tracked + untracked-not-ignored), with a walker fallback outside git; hidden directories (except CI config dirs), nested repositories, submodules and gitignored files are no longer indexed.
  - The manifest (v3) records the leina version, the extractor schema and config-file hashes: upgrading leina or editing `tsconfig*.json`/`jsconfig.json`/`package.json` makes the graph stale.
  - Node ids: declarations whose names collide case-insensitively get a `:<tag>` suffix (non-colliding ids are unchanged); static and instance members are separate nodes; calls in a top-level initializer belong to that variable.
  - `build`/`refresh` refuse a missing or non-directory root (exit 1) instead of creating and registering it.
  - Reduced-precision notes (no SCIP indexer or sidecar) are printed once, only for product code; read-path rebuilds stay quiet.
- **Harness config and verify:** `rules.<id>` overrides accept only `enabled`/`severity`; user and local layers cannot weaken a blocking rule nor lower `strictness`; an invalid config fails closed. Only full `verify` runs update the commit guard's report; usage errors exit 2; outside git verify fails closed; changed files are relative to the harness root; `--json` includes `loadErrors`; `contract new --max-retries` is 1–10 and counts blocks per stop chain. The commit guard judges freshness by working-tree content. `sync --platforms` touches only the named platforms and compiles only committed layers; `init --hosts` keeps previously synced platforms; `deinit` removes the config `init` wrote while it is unchanged.
- MCP harness tools resolve the harness root of their (confined) root like `leina harness` does for its cwd, and `harness_verify` checks trust through the repository, so a subdirectory or a nested worktree of a trusted repo runs while an independent nested clone does not; an untrusted root is `skipped` with the `leina init` command to run.
- The AGENTS.md protocol block `init` writes documents `[<dir>]`, `--help` and exit 2, `--include-tests`, `--depth`, exact selectors, the full refresh, the init + trust requirement for injection and an opt-in harness section; the capability registry describes `query` as relevance-ranked.
- `init`'s `.gitignore` writer rewrites a bare `.leina/` line that hid `.leina/config.json` from git.
- Raised the `@modelcontextprotocol/sdk` range to `^1.32.1`.

### Security
- A cloned repo could run its own code through the harness without `leina init`: via a `gate` override in `.harness/config.json`, a committed `.leina/consent`, or a repo-root module shadowing a builtin js gate. Fixed by the out-of-repo trust store, rejecting config gate overrides and per-layer module resolution.
- A crafted `.harness/harness.lock.json` could make `deinit` / `sync --force` delete or write files outside the repo; lockfile paths are validated and every write/delete is confined by real path.
- MCP: a symlink inside the workspace escaped `root` confinement, and `graph_visualize` could overwrite any file the user can write.
- `memory import`/`sync` of a shipped `.leina/memory-export.jsonl` could overwrite another project's memories (later injected into that project's sessions); id lookups crossed projects.
- Stored XSS in the offline graph viewer through repo folder names / repo keys.
- Rule-supplied regexes (command, diff-content and file gates) run under a hard timeout (ReDoS); diff-content failures report only `file:line` and a masked prefix, never the matched secret; the untracked-file scan never follows symlinks; the no-secrets rule catches more credential shapes.
- The agent cannot edit `$LEINA_HOME/harness` (user rules) or the trust store; the pre-bash integrity guard reasons about write targets instead of mentions.
- The env store is written atomically with owner-only permissions.
- All `npm audit` advisories resolved (MCP SDK transitive express/hono/ajv stack, brace-expansion, js-yaml, undici, source-map-js).

### Fixed
- Under `leina setup`, Claude Code never received memory injection (only Devin got user-global hooks); harness enforcement never ran on Claude Code (no PreToolUse hook); every advisory was invisible to Claude Code (stderr with exit 0).
- Devin hooks kept running whatever leina install they were written with, and `doctor` reported everything as healthy.
- Hooks were silent in subdirectories and worktrees of an initialized repo.
- After a compaction the Stop nudge asked to save a session that was already saved; a failed injection re-injected its fallback on every prompt.
- `affected` missed callers reached through destructured dynamic imports (`const { f } = await import(…)`) and local renames, and every caller that went through an interface; same-named declarations differing only in case (`hostSpec` / `HostSpec`) collapsed into one node.
- `affected`/`path` silently reported a different symbol when the name had no exact match (substring fallback) and picked test mocks for ambiguous names.
- YAML was always parsed by the line-based fallback: the bundled grammar needed C++ runtime symbols web-tree-sitter 0.25 does not export.
- `sidecar verify` / `scip verify` were broken in a published install (their fixtures were not shipped; the C#/Java ones were empty).
- `leina build <missing dir>` created the directory, built an empty graph and registered it.
- Concurrent reads of a stale graph each ran a full rebuild (one process per reader).
- On a multi-repo workspace root, `query`/`affected`/`path` rebuilt it as one repo — indexing none of its members — and overwrote the merged graph with an empty one, and so did `build`/`refresh` (MCP `graph_build` too). They now build the stale members and merge them, and `status` lists the members; a git repository is never treated as one.
- A graph built by an older leina still read as fresh after an upgrade.
- Worktrees under `.claude/worktrees/` and gitignored output were indexed, duplicating symbols.
- `memory save`/`update` accepted invalid types, which then broke `memory export` → `import`; `memory search` folded flag values into the query.
- `merge-projects` stranded topic snapshots under the old key and could leave ghost full-text entries.
- The TypeScript extraction cache never hit on Node 22 (its key was cut at a NUL by node:sqlite).
- `graph_visualize` could terminate the whole MCP server on a refused stale graph; concurrent MCP calls on a stale graph each rebuilt it (and `graph_stats` could read a half-written graph) — builds are single-flight per root.
- MCP `impact_analyze` returned nothing for a symbol name; `memory_verified` ignored `type`.
- Source files over 4 MiB are skipped consistently by the build and the freshness check.
- The NOCASE label index retrofit no longer blocks a read when another process holds the write lock.
- A js gate stuck on a promise that never settles is reported as a timeout instead of letting verify exit early (seen on Node 22).
- `memory compact` reports a locked db or a failed `VACUUM` without a stack trace and does not report a grown db while another process holds it open.
- `env set`/`unset` match keys the parser accepts (`KEY =value`) and collapse duplicates.
- Harness: commit detection and the integrity guard handle `&`, subshells and backticks; Cursor's shell hook makes the same decision as pre-bash; the OpenCode plugin blocks only on exit status 2; `.harness/state/` ignores itself; `hookCommand` must be a leina launch form; the TUI writes rule overrides only after the contract is confirmed; deinit preserves user JSON verbatim and writes atomically.
- The root and `memory` help showed `memory <dir> <sub>`; the dispatcher reads `memory <sub> <dir>`. Unknown commands and memory sub-commands printed help and exited 0; other usage problems exited 1.
- Flag values were read as the project or the symbol: `visualize --out x.html`, `audit --from id`, `init --hosts devin <dir>` and `workspace memory search` picked the wrong word. `tui` took any first word as its directory, `impact analyze` ignored its depth, `workspace build/status` ignored `--single`/`--workspace`, invalid `--format`/`--max-pack-kb`/`--type`/`--scope`/`--status` values were accepted, and `stats` created an empty graph.db.
- Tests no longer write into the developer's real `~/.leina` nor leave `.leina/` in `test/fixtures` (fixtures are built from temp copies); the 51 `test/use-cases` tests and the fake-agent-runner test, which `npm test` never ran, run again.

### Performance
- **Incremental TypeScript extraction.** Only edited files are re-extracted, plus their importers when the visible shape, the file set or an import resolution changes; a global declaration, a non-TypeScript file the checker reads, tsconfig, package.json, a lockfile, the leina version, `leina refresh` or `LEINA_TS_FULL_EXTRACT=1` force a full extraction. The incremental graph is identical to a full one. Whole `leina build`, before → after:

  | Repo | Build | 2.x | 3.0 |
  |---|---|---|---|
  | leina (372 TS files) | nothing changed | 7.7 s · 807 MiB | 0.55 s · 259 MiB |
  | leina | 1-file edit | ~8 s · ~830 MiB | ~0.9 s · ~300 MiB |
  | Next.js app (751 TS files) | nothing changed | 21 s · 1.8 GiB | 0.8 s · 278 MiB |
  | Next.js app | 1-file edit | 19.5 s · ~1.8 GiB | 1.8–2.8 s · 464–620 MiB |
  | Next.js app | cold | 26 s · 1.9 GiB | 10 s · 1.5 GiB |
- Stale-graph rebuilds are serialized across processes: four concurrent reads after an edit went from four rebuilds (≈ 4.5 GB combined RSS) to one (≈ 1.5 GB); waiting readers reuse its result.
- A NOCASE label index serves exact symbol lookups; a staleness check lists the project once and shares that listing with a triggered rebuild.
- MCP graph payloads shrank 3–8× (e.g. `graph_query` ≈ 50 KB → 5–9 KB).

### Documentation
- CLI reference (EN/ES): a help and exit-code section, the positional rules of every command, and `doctor`'s exit code; readme, usage guide and concepts show `[<dir>]`. AGENTS.md's install surface no longer claims that `init` runs `activate` or writes the user-global Devin config. CONTRIBUTING: tests isolate HOME/LEINA_HOME and build fixtures from a copy.
- CLI reference (EN/ES) for every change above and for `memory compact`, `graph gc`, `init --harness-preset` and `setup`/`activate` asset selection, including the MCP confinement and argument rules, memory import/sync rules, env store limits, the harness and trust behaviour, symbol selectors and the memory lifecycle.
- Concepts (EN/ES): graph ids, node kinds and relations, incremental extraction; harness presets, the hook/gate vocabulary map and workspace trust.
- Benchmarks: corrected the warm-cache and read-path scaling claims and added the incremental-build numbers.

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
