# leina — CLI Reference

This is the canonical reference for the `leina` command-line interface: every
command, its flags, what it prints, and the implementation entry point behind it.

**leina exposes a command-line interface.** Every command operates on an explicit
`<dir>` (defaulting to `.`) and runs in a short-lived process.

- **Entry point:** `src/cli/index.ts` (a `switch (cmd)` over `process.argv`).
- **Invocation:** `leina <command> [args]` (global install) or, from a clone,
  `node --experimental-strip-types src/cli/index.ts <command> [args]`.
- **Graph DB:** `<dir>/.leina/graph.db` (per project, git-ignored).
- **Memory DB:** `~/.leina/memory.db` (global, keyed by derived project key).

---

## Graph commands

All read commands (`query`, `affected`, `path`) route through the **freshness gate**
(`openFreshStore` in `src/cli/wiring.ts`, using `isStale` from `src/application/graph/manifest.ts`):

- fresh → serve as-is;
- stale + posture `auto` → rebuild, then serve (prints a `rebuilding ...` note on stderr);
- stale + posture `refuse` → fail and tell you to run `refresh`.

Posture is read by `loadFreshnessConfig` (`src/infrastructure/config/freshness.ts`).

### `build <dir> [--json]`
Build the graph for `<dir>` into `.leina/graph.db`. With `--json`, also export a
node-link dump to `.leina/graph.json`. Lazy-imports the extractor stack
(`src/application/graph/build.ts` → `buildGraph`). Prints node/edge/file counts.

### `refresh <dir>`
Force a rebuild now, ignoring freshness. Same implementation as `build` without `--json`.

### `status <dir>`
Report freshness (`fresh`/`STALE` + reason), posture, last build time, and tracked file
count. No rebuild. Backed by `isStale` / `readManifest` (`src/application/graph/manifest.ts`).

### `stats <dir>`
Print node count, edge count, and an edge confidence breakdown (`store.stats()`).

### `query <dir> <question>`
Term-scored subgraph for a free-text question (`queryGraph`, `src/application/graph/query.ts`). Prints
the resolved seeds and the `source --relation--> target` edges of the subgraph.

### `affected <dir> <label> [depth]`
Blast radius — what (transitively, up to `depth`, default 3) depends on the symbol matching
`<label>` (`resolveSeed` + `affected`, `src/application/graph/query.ts`). **Run this before renaming or
migrating a symbol.** Prints each dependent with its relation and source location.

### `path <dir> <from> <to>`
Shortest dependency path between two symbols (`shortestPath`, `src/application/graph/query.ts`). Prints
each hop as `--relation(confidence)--> node`.

### `impact analyze [<dir>] <symbol> [--json]`
First-level **impact analysis**: a bidirectional BFS from the node matching `<symbol>` over the
impact relation set (`IMPACT_RELATIONS` = code relations ∪ infra relations `deploys|reads|configures|exposes`),
categorising every reached node into `{files, tests, services, configs}`
(`analyzeImpact`, `src/application/graph/impact.ts`; handler `src/cli/handlers/impact.ts`). It
crosses code→test→config→service through **real graph edges** (e.g. a `docker-compose` service
whose `build.context` points at a module emits a `reads` edge to that code node). With `--json`
prints `{"impacted":{"files":[…],"tests":[…],"services":[…],"configs":[…]}}`; always exits 0
(an unknown symbol yields an empty shape). Routes through the freshness gate like the other
graph reads.

### `visualize <dir> [--out <path>] [--drilldown] [--single|--workspace]`
Export an interactive, self-contained HTML graph viewer (vis-network inlined, offline) to `<path>`
(default: `<dir>/.leina/graph.html`). Nodes are coloured and grouped by top-level folder/layer
(readable legend: `domain`, `application`, `infrastructure`, `cli`, …) and sized by bidirectional
non-`contains` degree. The top-12 god nodes are labelled and listed in the HUD sidebar. INFERRED edges
render as dashed lines. **Clicking a node opens a right-side drawer** with its structured detail (label,
kind, layer, file, degree, signature, and the detected Louvain community as a datum) — there is no hover
tooltip. The HTML also includes search, per-folder filters, a physics freeze toggle, and a fit-to-view
button. The Louvain community is still computed/persisted during build but no longer drives node colour.

Routes through the **freshness gate** (same as `query`/`affected`):
- stale + posture `auto` → rebuilds automatically before exporting;
- stale + posture `refuse` → fails with instruction to run `leina refresh <dir>`.

On success prints: `Exported graph.html ({N} nodes, {E} edges) -> {outPath}`.

**Workspace-aware:** if `<dir>` is a workspace root (see *Workspace commands* below), the
single-repo freshness gate is bypassed (it would clobber the merged graph) and the export
uses the merged workspace store instead. Default render is **constellation** mode (each repo
a super-node, cross-repo edges between them); pass `--drilldown` for the full merged graph
coloured by repo. `--single` / `--workspace` override auto-detection.

Backed by `handleVisualize` (`src/cli/handlers/visualize.ts`) →
`renderGraphHtml` / `renderConstellationHtml` (`src/application/graph/html-export.ts`).

---

## Workspace commands (multi-repo)

`leina workspace <build|status|detect|memory|visualize> [dir]` operates on a **multi-repo
workspace**: a directory that is either marked by a `workspace.json` at its root or contains
≥2 immediate child dirs with `.git` (`detectWorkspaceMode`,
`src/application/project/detect-key.ts`; source reported as `flag` / `workspace.json` /
`child-git-auto` / `git-root`). `--single` / `--workspace` flags override detection. A
workspace is stale when **any** member repo is stale (`isStaleWorkspace`,
`src/application/workspace/manifest.ts`).

### `workspace build [dir] [--json]`
Build every member repo's graph and the merged workspace store. With `--json` also exports
`<dir>/.leina/workspace-graph.json` (node-link dump of the merged graph). Prints merged
node/edge counts (`handleWorkspaceBuild`, `src/cli/handlers/workspace.ts`).

### `workspace status [dir]`
Report the detected mode; in workspace mode lists each member as `[fresh|STALE] <repoKey> (<dir>)`.

### `workspace detect [dir] [--single|--workspace]`
Print the detection result as JSON: `{mode, source, members[]}`.

### `workspace memory context [dir]` / `workspace memory search [dir] <query>`
**Federated memory** across all member repos: `context` shows recent sessions + observations
from every member; `search` runs full-text search over all members' observations (limit 20).
Backed by `openWorkspaceMemoryRepo` (`src/cli/wiring.ts`).

### `workspace visualize [dir] [--out <path>] [--drilldown]`
Equivalent to `visualize <dir> --workspace` (see above).

---

## Memory commands

`leina memory <sub> <dir> [flags]`. Memory lives in the **global** DB
(`~/.leina/memory.db`, `globalMemoryPath()`), partitioned by the project key derived
from the repo's git remote / root / dir name (`deriveProjectKey`, `src/application/project/detect-key.ts`).
The store is `SQLiteMemoryRepository` (`src/infrastructure/sqlite/memory-repository.ts`), wired with
graph-backed anchor resolution and drift verification (`makeResolveAnchor` / `makeVerifyNode`,
`src/application/memory/anchor-verify.ts`).

If the project key is ambiguous (multiple git repos), commands fail with guidance to create
`.leina/config.json` with `{"project_name":"<name>"}`.

Observation `--type` values (`ObservationType`, `src/domain/memory/model.ts`): `decision`, `bugfix`,
`discovery`, `pattern`, `architecture`, `config`, `manual` (default). `--scope` (`Scope`,
`src/domain/memory/model.ts`) is one of nine values — `project` (default), `personal`,
`workspace`, `path`, `skill`, `process`, `technology`, `security`, `infra`. Search/`verified`
default to `--scope project`; pass an explicit `--scope` to retrieve observations saved under
the richer scopes. The DB schema migrates idempotently (`MEMORY_SCHEMA_VERSION`, v4→v5) and the
live-row unique constraint is `(project_key, scope, topic_key)`.

### `memory save <dir> --title "..." --content "..." [--type t] [--topic key] [--scope s] [--anchors a,b]`
Save (or upsert) an observation. Passing `--topic <key>` evolves the existing entry with that
topic in place (prints `evolved rev N`); otherwise creates a new one. `--anchors` is a
comma-separated list of graph symbols the observation is about (resolved against the live
graph on save). Backed by `store.save(...)`.

**Batch:** `memory save <dir> --batch [--atomic]` reads a JSON array of
`{title, content, type?, topicKey?, scope?, anchors?}` from stdin (`store.saveBatch`).

### `memory update <dir> <id> [--title ..] [--content ..] [--type ..] [--anchors a,b]`
Update an observation in place by id, bumping its revision (`store.update`). **Batch:**
`--batch [--atomic]` reads a JSON array of `{id, title?, content?, type?, anchors?}`.

### `memory search <dir> <query> [--type t] [--scope s] [--limit N]`
Full-text search (default limit 10). Prints `#id [type] [topic] title` plus a snippet per hit
(`store.search`).

### `memory verified <dir> <query> [--type t] [--scope s] [--limit N]`
Search **plus drift classification** against the live graph (`getVerifiedContext`,
`src/application/memory/query.ts`). Buckets results into `USABLE` / `WARNING` / `DO NOT USE` with a reason
per hit. Prefer this over `search` when you're about to act on remembered context. If the
graph is unavailable, verdicts degrade to unverified (still printed).

### `memory get <dir> <id>`
Print the full observation (title, type, topic_key, timestamps, revision, content).
**Batch:** `memory get <dir> --batch` reads a JSON array of id strings from stdin.

### `memory context <dir> [--limit N]`
Recent sessions + latest observations for the project. **Run this at the start of every
session** to restore prior decisions (`store.recentContext`).

### `memory session <dir> --content "summary" [--title "..."]`
Save a session summary (`store.saveSession`). Run at the **end** of a session.

### `memory session-start <dir> [--title "..."]`
Open a fresh session and print its id, to group later observations (`store.startSession`).

### `memory suggest-topic <dir> --title "..." [--type t]`
Suggest a normalized `topic_key` for a title, plus near-matches to existing topics
(`store.suggestTopicKeyWithMatches`). Use before `save --topic` to avoid duplicate topics.

### `memory current-project <dir>`
Print the derived `project_key`, the detection `method`, and the raw name — no DB access.
Useful to debug ambiguous-project failures.

### `memory merge-projects <dir> --from <key> --to <key> [--dry-run]`
Move/merge all observations from one project key to another (after a remote rename, say).
`--dry-run` reports what would move (`store.mergeProject`).

### `memory migrate <dir>`
Fold a legacy per-repo `<dir>/.leina/memory.db` into the global DB under the derived
project key. No-op if there's no legacy DB.

---

## Audit, findings & artifacts

`leina audit [<sub>] [dir] [flags]` runs source→sink candidate-path analysis over the
(possibly merged) graph. Output is **evidence for triage** — candidate data-flow routes, never
confirmed vulnerabilities (a disclaimer banner is always printed). The audit pack carries
`schemaVersion` and a `findings[]` array.

### `audit [dir] [--format md|json|html] [--json] [--from <id,...>] [--max-pack-kb <N>]`
Run the audit and render it (`handleAudit`, `src/cli/handlers/audit.ts`). The format selects the
renderer (`Renderer<AuditPack>`, `src/domain/artifact/renderer.ts`):
- no `--format` → original human UX text;
- `--format md` → Markdown report to stdout (`MarkdownRenderer`);
- `--format json` (or the `--json` alias) → machine-readable `AuditPack` to stdout (`JsonRenderer`),
  including `findings[]` (`Finding` = `{severity, evidence, relatedNodes, suggestedActions, confidence}`,
  `src/domain/findings/model.ts`) and `schemaVersion`;
- `--format html` → writes a self-contained offline `audit-graph.html` (source/sink roles,
  candidate paths, clickable path list).

`--from <id,...>` overrides the entry points; `--max-pack-kb <N>` caps the JSON pack size.
Emits an `audit.completed` event (see Events) after writing the pack.

### `audit catalog|reachability|pack|visualize [dir] [flags]`
Multi-repo / workspace audit subcommands: `catalog` (repos/nodes/edges grouped by repo),
`reachability --from <id,...> [--backward]` (reachable set from entry points), `pack` (full
report = catalog + reachability), `visualize` (offline HTML audit subgraph). Run
`leina workspace build` first for a fresh workspace-level graph.

---

## Events (local outbox)

An append-only local **event outbox** records domain events (`LeinaEvent`, `schemaVersion: 1`,
`src/domain/events/model.ts`). It is **off by default** (a no-op `DebugEventSink`) — stdout/UX are
unchanged unless you opt in.

### `events tail [dir] [--json]`
Print the most recent events from the outbox (`handleEventsTail`, `src/cli/handlers/events.ts`).
With `--json` prints the raw JSONL event objects. When persistence is off it prints a hint to
enable it.

**Enable persistence:** set `LEINA_EVENTS_PERSIST=1`. Events are then appended as JSONL to
`~/.leina/events/outbox.jsonl` (`LocalEventStore`, `src/infrastructure/events/local-event-store.ts`)
and emitted after successful `graph.built`, `audit.completed`, and `memory.created` operations.
A `Redactor` port keeps payloads free of sensitive content; the outbox is the seam a future
opt-in `CloudEventSink` would drain — no cloud dependency exists today.

---

## Env store (names, not values)

`leina env <sub>` manages service credentials for skills that call authenticated services,
under the **names-not-values contract**: an AI agent only ever handles variable *names* —
values never travel through argv, model context, or captured stdout. Storage is a global
`~/.leina/.env` (0600, plain text; `envFilePath()`, `src/infrastructure/env/env-file.ts`).
`env list` warns if the file's permissions are group/other-readable.

### `env set <KEY>`
Store a value. Interactive: hidden TTY prompt (input not echoed). Non-interactive: first line
of piped stdin (`echo "$V" | leina env set KEY`). Never via argv — argv lands in shell
history and agent transcripts. Key names must match `[A-Za-z_][A-Za-z0-9_]*`.

### `env list`
Print stored variable names with **masked** values.

### `env get <KEY> [--reveal]`
Masked by default. `--reveal` prints the plain value **only when stdout is a real TTY** — a
driving agent cannot capture it by piping; the command fails with a pointer to `env exec`.

### `env unset <KEY>`
Remove the variable.

### `env exec [--only K1,K2] -- <cmd...>`
Run `<cmd>` with the stored variables injected into its environment (all of them, or only the
`--only` subset). The secret travels **process-to-process**: with single quotes, the *child*
shell expands the var and the parent (and the model) never sees the value:

```bash
leina env exec --only MY_TOKEN -- sh -c 'curl -H "Authorization: Bearer $MY_TOKEN" https://api...'
```

Exits with the child's exit code. Backed by `handleEnv` (`src/cli/handlers/env.ts`) over
`src/application/env/store.ts`.

---

## Sidecar commands (Java / C# compiler-grade extraction)

`leina sidecar [build|status|clean|verify] [csharp|java] [--force]` manages the optional
on-demand compiler sidecars. Without a sidecar, Java/C# still extract via tree-sitter (SYNTACTIC —
call edges best-effort); the sidecar adds compiler-grade precision.

- `sidecar status` — report whether each sidecar is configured and whether the toolchain is present.
- `sidecar build <csharp|java>` — build the sidecar (needs the local toolchain: dotnet SDK for C#;
  JDK 17+ with `jpackage` for Java).
- `sidecar clean [csharp|java]` — remove built sidecars.
- `sidecar verify <java|csharp>` — verify the extractor against a minimal fixture
  (`test/fixtures/Sample.{java,cs}`). **Honest skip**: if the toolchain is missing it prints
  `<lang>: skip — …` and exits `0` (never a spurious failure); with the toolchain present it runs
  a normal extraction and reports `ok`/`fail` plus a `VerificationCheck`. Backed by the
  `GraphExtractor.verify()` method on `SidecarExtractor`
  (`src/infrastructure/extractors/semantic/sidecar.ts`).

All extractors (ts-morph, the two sidecars, tree-sitter, and the YAML-infra extractor) implement
the common `GraphExtractor` port (`src/domain/graph/extractor.ts`) and are iterated from an
`ExtractorRegistry` (`src/application/graph/extractor-registry.ts`) wired in `buildDefaultRegistry`
(`src/cli/wiring.ts`). Each `extract()` returns a versioned `GraphExtractionResult`
(`schemaVersion: 1`, `diagnostics`, `durationMs`, `errors`).

---

## SCIP commands (compiler-grade ingestion via third-party indexers)

`leina scip [status|verify|install] [go|rust|python]` detects/verifies/instructs installation of
**third-party SCIP indexer binaries** (SCIP = [SCIP protocol](https://sourcegraph.com/docs/scip),
a compiler-grade code intelligence index format). Unlike the C#/Java sidecars above — which
leina builds and bundles itself from templates under `assets/sidecars/` — SCIP indexers (e.g.
`scip-go`, `rust-analyzer`, `scip-python`) are tools the USER installs via their own language's
package manager; leina never downloads, builds, or auto-installs one. Without an indexer, the
language still extracts via tree-sitter (SYNTACTIC); an available indexer upgrades that language
to compiler-grade precision, ahead of tree-sitter in the extractor order. `go`/`rust`/`python` are
the three languages wired end-to-end today (`WIRED_SCIP_LANGS` in `scip-indexer.ts`); `ruby` is
tracked as `backlog/scip-ruby-deferred`.

- `scip status [go|rust|python]` — report whether each SCIP indexer is found on `PATH` (or via
  its env override), printing the install command otherwise.
- `scip install [go|rust|python]` — **detect + instruct only**: prints the command to install the
  indexer (e.g. `go install github.com/scip-code/scip-go/cmd/scip-go@latest` for Go,
  `rustup component add rust-analyzer` for Rust, `npm install -g @sourcegraph/scip-python` for
  Python — which also needs a working `pip` on `PATH`, e.g. any venv's `bin/`); never downloads or
  runs anything on the user's behalf.
- `scip verify [go|rust|python]` — verify the extractor against a minimal fixture
  (`test/fixtures/scip/go/`, `test/fixtures/scip/rust/`, `test/fixtures/scip/python/`). **Honest
  skip**: if the indexer isn't found it prints `<lang>: skip — …` and exits `0` (never a spurious
  failure); with the indexer present it runs a real index + parse and reports `ok`/`fail` plus
  node/edge counts. Backed by the `GraphExtractor.verify()` method on `ScipExtractor`
  (`src/infrastructure/extractors/semantic/scip.ts`).

`ScipExtractor` (id `scip-<lang>`, e.g. `scip-go`, `scip-rust`, `scip-python`) runs whole-project:
it invokes the indexer against the project root, streams the resulting `.scip` protobuf index
Document-by-Document (a hand-rolled parser in
`src/infrastructure/extractors/semantic/scip-proto.ts` — no new dependency), and translates each
SCIP symbol to a leina graph id byte-identical to what tree-sitter/ts-morph would produce for the
same symbol (`src/infrastructure/extractors/semantic/scip-indexer.ts`). For Rust specifically, a
single `rust-analyzer scip .` at the workspace root covers every crate in a Cargo workspace
(cross-crate calls resolve within that one invocation), and `impl` blocks (rust-analyzer's
synthetic `impl#[SelfType]`/`impl#[SelfType][Trait]` descriptor) are rewritten to their Self type
so an inherent impl and a trait impl of the same type — or two different types' impls sharing a
method name — never collide under one invented owner id. For Python specifically, scip-python
never populates `SymbolInformation.kind` or `display_name` — leina derives the node kind from the
resolved id chain's final descriptor suffix instead, and the label from that same chain's name —
and nested functions are flattened (two same-named closures collapse to one id, matching
tree-sitter's own behavior for Python, which never tracks an enclosing function as an owner). The
`.scip` output always lands in an ephemeral `os.tmpdir()` directory that is deleted immediately
after being read — never under the project root (every currently-wired indexer accepts an
explicit `--output <path>` flag; no language needs a `cwd-default`-scanning fallback today). If
the indexer is missing, fails, or produces a partial/corrupt index, `ScipExtractor` reports
non-fatal `errors` and claims nothing, leaving tree-sitter to process those files (see
`EXTRACTOR_ORDER` in `src/application/graph/extractor-registry.ts`: `scip-go`/`scip-rust`/
`scip-python` precede both sidecars and tree-sitter).

---

## MCP server & tools (dual transport)

Every read/write capability is exposed twice: as the CLI commands above **and** as MCP
tools served by `leina mcp` (stdio). Both transports call the same use cases through the
capability registry, so they cannot diverge. Agents should prefer the MCP tools when the
host exposes them (structured JSON, no shell round-trip); every tool takes an optional
`root` — the `<dir>` argument of the CLI form (default: the cwd the host launched the
server in, i.e. the workspace root).

| CLI | MCP tool | Notes |
|---|---|---|
| `query` | `graph_query` | builds the graph on first use |
| `affected` | `graph_affected` | |
| `path` | `graph_path` | |
| `stats` | `graph_stats` | |
| `status` | `graph_status` | |
| `build` / `refresh` | `graph_build` | |
| `impact analyze` | `impact_analyze` | |
| `visualize` | `graph_visualize` | returns the PATH of the generated HTML |
| `audit` | `audit_run` | |
| `doctor` | `doctor_run` | consent-exempt (diagnosis always allowed) |
| `memory save` | `memory_add` | batch: `items[]` + `atomic` |
| `memory search` | `memory_search` | |
| `memory verified` | `memory_verified` | |
| `memory context` | `memory_context` | |
| `memory get` | `memory_get` | batch: `ids[]` |
| `memory update` | `memory_update` | |
| `memory suggest-topic` | `memory_suggest_topic` | |
| `memory session` | `memory_session` | |
| `agent-hook SessionStart` | `context_build` | |

CLI-only, by design: `env exec` (the names-not-values contract injects secrets
process-to-process; an MCP tool result would pull values into model context),
`memory session-start`, `merge-projects`, `migrate`, and the install/lifecycle commands.

Consent: the server honours the per-repo opt-out — a tool call whose `root` has
`.leina/consent = disabled` fails with an actionable error (`doctor_run` stays available).

### Registration

```bash
leina mcp register [--hosts claude,cursor,windsurf]   # USER-GLOBAL: one entry per host,
                                                      # available in every project
leina mcp unregister [--hosts ...]                    # inverse
leina mcp status                                      # read-only per-host state
leina activate --mcp   /   leina setup --mcp          # register during install
leina init <dir> --mcp                                # PROJECT-LEVEL .mcp.json (committable,
                                                      # for teams) + mcp__leina grant
```

Host mechanics: Cursor (`~/.cursor/mcp.json`) and Windsurf
(`~/.codeium/windsurf/mcp_config.json`) are merged in place (only the `leina` entry is
owned; foreign servers and unknown keys survive; malformed JSON is never clobbered; a
host is only touched if its config directory already exists). Claude Code registration
delegates to `claude mcp add --scope user leina leina mcp` (its `~/.claude.json` is
host-owned state we never write) and grants `mcp__leina` (server-level, all tools) in
`~/.claude/settings.json`. `deactivate`/`disable` remove the user-global registrations;
`deinit` removes the project one. `leina doctor` reports registration state per host and
fails only when a registration exists but `leina` does not resolve on PATH.

---

## Install / lifecycle commands

leina exposes a **layered, fully reversible** command model — every install command has an
explicit inverse, and nothing acts in a repo without consent:

| Layer | Command | Inverse | Blast radius |
|---|---|---|---|
| **Machine** (one-shot) | `setup` | `disable` | machine-wide: global share + symlinks + user-global config + blanket sentinel |
| **Global** (granular) | `activate` | `deactivate` | machine-wide: global share + symlinks + user-global `Exec` grant + hooks |
| **Repo** (granular) | `init` | `deinit` | one repo: consent flag (+ `AGENTS.md`/`.devin/*` when standalone) |
| **Repo** | `build` | — | one repo: `graph.db` (on-demand) |

**Blanket + tri-state consent.** `setup` turns on a machine-wide **blanket sentinel**
(`~/.leina/.blanket`, `blanketFile()`/`isBlanketActive()`). Independently, each repo carries a
**local, git-ignored consent flag** (`.leina/consent`, `readConsentFlag`/`writeConsentFlag`,
`src/application/install/consent.ts`) with three states:

- `unknown` (no flag) — the Devin gate stays **silent** (no injection, no advisories); the
  `leina-setup` skill prompts the user once ("leina available — use this workspace?").
- `enabled` — leina acts: gate injects memory + graph stats, advisories fire, and (under
  blanket) the graph self-heals on `SessionStart`. Written by `init`.
- `disabled` — permanent silent no-op. Written by `deinit`.

Legacy repos that have only a `.devin/hooks.v1.json` (from a previous version) but no consent flag
resolve to `unknown`, so they are re-prompted once rather than silently silenced.

### `setup [--no-user-hooks]`
The one-shot "magic" command (once per machine). Composes `activate` (share + symlinks +
user-global `Exec` grant + hooks) **and** turns the blanket sentinel ON. Idempotent. After `setup`,
leina is available in every Devin session and each repo is governed by its consent flag.
`--no-user-hooks` skips merging the user-global hooks. Backed by `handleSetup`
(`src/cli/handlers/install.ts`).

### `disable`
Inverse of `setup` (once per machine). Turns the blanket sentinel OFF and runs the global
teardown via `runDeactivate` (`unlinkHosts` + `revokeCliExecPermission` + `removeUserGlobalHooks`).
Strip-inverse only — removes leina's managed entries while preserving any third-party
symlinks/grants/hooks; does **not** rely on `.bak` files. Idempotent (a second `disable` exits 0).

### `init [dir] [--profile devin|windsurf] [--freshness auto|refuse] [--build] [--name <project-name>]`
Per-repo opt-in — **adaptive** on whether blanket is active (`isBlanketActive()`). Always writes the
consent flag `enabled` and ensures the `.gitignore` block. Then:

- **LIGHT** (blanket active): nothing else. The machine-wide share/grant/hooks from `setup` already
  cover this repo, so `AGENTS.md` and `.devin/*` are redundant and are **not** written.
- **FULL** (standalone, no blanket): also writes the `AGENTS.md` protocol block (`mergeAgentsMd`),
  `.devin/hooks.v1.json`, and a **repo-local** `Exec(leina)` grant in `.devin/config.json`
  (`grantCliExecPermission`) — making the repo self-contained. **Never** mutates the user-global
  `~/.config/devin/config.json`.

`init` does **no** auto-build. Pass `--build` to run a graph build **synchronously in the
foreground** (with progress) right after wiring. `--name <project-name>` writes a committable
`.leina/config.json` locking the project key. `--profile windsurf` adds the Windsurf
capabilities section to `AGENTS.md` (FULL only). Back-compat: `--activate`, `--write-user-config`
and `--no-global-skills` are accepted but silently ignored (init no longer touches the machine).
Backed by `handleInit` (`src/cli/handlers/install.ts`).

### `deinit [dir]`
Inverse of `init` (per repo). Writes the consent flag `disabled` and strip-inverse removes the
repo's managed artifacts: the `AGENTS.md` protocol block (`removeAgentsMdBlock`), the `.gitignore`
block (`removeGitignoreBlock`), the local `Exec` grant (`revokeCliExecPermission`), and
`.devin/hooks.v1.json`. User content outside the managed markers is preserved. Idempotent — when
there is nothing to revert (e.g. after a LIGHT init) it exits 0 with a "nothing to revert" note.

### `activate`  (alias: `install-global` — deprecated)
The global half of `setup` (once per machine), without flipping the blanket sentinel. Populate
`~/.leina/share/{skills,agents,workflows}` from bundled `assets/` and symlink each entry into
Devin's global dirs (`~/.config/devin/{skills,agents}`), and write the user-global config (the
`Exec(leina)` grant + hooks). Backed by `runActivate` (`src/application/activate.ts`) over
`src/infrastructure/install/global.ts`. `install-global` is a still-working **deprecated alias** for
`activate`.

### `deactivate`
Inverse of `activate` (once per machine). Runs the global teardown (`runDeactivate`: `unlinkHosts`
+ `revokeCliExecPermission` + `removeUserGlobalHooks`) but **leaves the blanket sentinel untouched**
(that is `disable`'s concern). Strip-inverse, idempotent.

### `version` (aliases: `--version`, `-v`)
Print the installed package version (`readPackageVersion()`) and exit. No project or DB access.

### `help` (aliases: `--help`, `-h`)
Print the root usage text (`printRootHelp`, `src/cli/handlers/system.ts`). The same text is
printed for any unknown command.

### `doctor [dir] [--json]`
Diagnose install + project health (`runDoctor`, `src/cli/doctor.ts`). Without `--json` prints the
human report (grouped checks + a final `N fail, M warn, K checks total` line). With `--json` emits
the full `DoctorReport` — including the `repoIdentity` aggregate
(`{projectKey, strategy, confidence: "high"|"medium"|"low", pathHash, rootCommit?, normalizedRemote?}`,
built fail-open by `buildRepoIdentity`, `src/application/project/identity.ts`). `pathHash` is a
cross-OS-deterministic SHA-256 of the normalised absolute path; `normalizedRemote` is the
`host/org/repo` canonical form. `doctor` never changes its exit code (it is informational).

### `verify [dir] [--json]`
Re-run the same checks as `doctor` but with an **actionable exit code** — exit `1` if any check
is `fail`, `0` otherwise (warn-only still exits 0). With `--json` returns the `DoctorReport`
(carrying the same `repoIdentity`) plus an `exitCode` field, for CI gating. Reuses `runDoctor`
without modifying `doctor` (`handleVerify`, `src/cli/handlers/system.ts`).

### `repair [dir] [--no-user-hooks]`
The **write-side counterpart of `doctor`**: re-runs the idempotent install writers for
whatever doctor finds broken, scoped strictly by **evidence of a previous install** — it
never installs something the user never asked for:

- **Global** (share + symlinks + user-global grant/hooks): only when activation evidence
  exists (share populated or blanket sentinel on). Never a first-time install.
- **Project** (`AGENTS.md` / `.gitignore` / `.devin/*` wiring / consent): only when init
  evidence exists (consent flag, managed hooks file, or `AGENTS.md` protocol block) **and**
  consent is not `disabled` — a `deinit` opt-out is always respected. The original profile
  (Devin/Windsurf) is preserved.

Never touches `graph.db` / `memory.db` (if a legacy per-repo memory DB exists it points you
at `memory migrate` instead). Ends by re-running doctor; remaining failures drive a non-zero
exit. Backed by `handleRepair` (`src/cli/handlers/install.ts`).

### `tui [dir]`
Interactive console (`@clack/prompts`, lazy-imported so it never taxes the fast read path).
Menus for: status (doctor summary), install/update with **asset-group selection** (catalog
presets / individual skills & agents), init/deinit of the current repo, repair, env-variable
management (password-style prompt, masked listing), and uninstall. A thin presentation layer
**by design**: every action dispatches to the same handlers the flag-based commands use
(`handleSetup`/`handleActivate`/`handleRepair`/… and the env store), so the TUI can never
drift from CLI behaviour. Requires a real interactive terminal on stdin+stdout; otherwise it
fails pointing at the non-interactive equivalents. Backed by `handleTui`
(`src/cli/handlers/tui.ts`).

### `capabilities list [--json]`
List the **6 system capabilities** that expose core use cases as transport-agnostic contracts
(`CommandContract`, `src/application/capabilities/registry.ts`): `graph.query`, `graph.status`,
`memory.add`, `memory.search`, `context.build`, `audit.run`. With `--json` prints an array of
`{id, description, inputSchema, outputSchema, schemaVersion, transports}` (the `fn` reference is
omitted from JSON). Each output schema is versioned (`schemaVersion: 1`) and validated in
`test/schema-validation.test.ts`. This registry is the seam that lets a future alternative
transport (HTTP, SDK, TUI, …) resolve the same use cases the CLI calls today, without duplicating logic.

### `agent-hook <Event>` (alias: `devin-hook`)
Host-neutral agent hook gate; reads the payload JSON on stdin (`devin-hook` remains a compatibility alias — existing `.devin/hooks.v1.json` installs invoke it). Events: `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `SessionStart`, `PostCompaction`, `Stop`. **Advisory only** — never blocks
(`runAgentGate`, `src/cli/agent-gate.ts`). **Scope-aware**: the gate is a silent no-op unless the
repo's consent flag is `enabled` (`isLeinaProject` = `readConsentFlag(cwd) === "enabled"`), so a
user-global hook stays quiet in repos that haven't opted in (`unknown`/`disabled`).

**Auto-build self-heal (SessionStart)**: on every `SessionStart` **for a consented (`enabled`)
repo**, if `graph.db` is absent or the manifest is stale, a detached `leina build` is spawned
in the background before `emitInjectedContext` runs. It never fires in `unknown`/`disabled` repos
(the scope guard returns early), so leina never builds a graph in a workspace you haven't opted
into. The nudge text from `computeFreshnessNote` remains the fallback for
the current session; the background build materialises a fresh graph for the next session. This
is advisory/fail-open — any spawn error is silently swallowed and context injection proceeds
normally. Suppress with `LEINA_DISABLE_AUTOBUILD=1`.

**Lock file**: both `init` and `SessionStart` auto-build coordinate via
`.leina/graph.build.lock` (JSON `{ pid, startedAt }`), written with `O_EXCL` to serialise
concurrent triggers. The lock is deleted in `handleBuild`'s `finally` block. A stale lock (PID
dead via `ESRCH`, or `startedAt` older than 15 min) is automatically reclaimed.

---

## Implementation map (for contributors)

The source tree follows a hexagonal layout (`domain` / `application` / `infrastructure` / `cli`).

| Area | File(s) |
|---|---|
| CLI dispatch | `src/cli/index.ts` (dispatcher) + `src/cli/handlers/*.ts` |
| Composition root / freshness gate | `src/cli/wiring.ts` (`openFreshStore`) |
| Graph store / stats / node-link | `src/infrastructure/sqlite/graph-store.ts` |
| Graph build (extractors) | `src/application/graph/build.ts`, `src/infrastructure/extractors/*` |
| Graph queries (query/affected/path) | `src/application/graph/query.ts` |
| Impact analysis (impact analyze) | `src/application/graph/impact.ts`, `src/cli/handlers/impact.ts` |
| Extractor port + registry | `src/domain/graph/extractor.ts`, `src/application/graph/extractor-registry.ts` |
| SCIP ingestion (protobuf parser, id translation, adapter) | `src/infrastructure/extractors/semantic/scip-proto.ts`, `scip-indexer.ts`, `scip.ts` |
| Capability registry + schemas | `src/application/capabilities/registry.ts`, `src/domain/contracts/schemas.ts` |
| Verify / doctor JSON + repo identity | `src/cli/handlers/system.ts`, `src/cli/doctor.ts`, `src/application/project/identity.ts`, `src/domain/project/identity.ts` |
| Audit findings + renderers | `src/domain/findings/model.ts`, `src/application/audit/*.ts`, `src/application/render/*-renderer.ts`, `src/domain/artifact/renderer.ts` |
| Events outbox | `src/domain/events/*.ts`, `src/infrastructure/events/local-event-store.ts`, `src/cli/handlers/events.ts` |
| Freshness / manifest | `src/application/graph/manifest.ts`, `src/infrastructure/config/freshness.ts` |
| Workspace detection / merge / federated memory | `src/application/project/detect-key.ts` (`detectWorkspaceMode`), `src/application/workspace/*.ts`, `src/cli/handlers/workspace.ts` |
| Env store (names-not-values) | `src/application/env/store.ts`, `src/infrastructure/env/env-file.ts`, `src/cli/handlers/env.ts` |
| TUI console | `src/cli/handlers/tui.ts` |
| Memory store | `src/infrastructure/sqlite/memory-repository.ts` (port: `src/domain/memory/ports.ts`) |
| Memory model / types | `src/domain/memory/model.ts` |
| Verified context (drift) | `src/application/memory/query.ts` |
| Anchor resolution / node verify | `src/application/memory/anchor-verify.ts` |
| Project key detection | `src/application/project/detect-key.ts` |
| Batch stdin parsing / formatting | `src/cli/args.ts` (`parseBatchInput`), `src/domain/shared/batch.ts` |
| Install (global/hooks/permissions/migrate) | `src/application/install/*.ts`, `src/infrastructure/install/*.ts` |
| Agent hook gate (host-neutral) | `src/cli/agent-gate.ts` |
| Background build helper (lock + spawn) | `src/cli/background-build.ts` |
| Doctor | `src/cli/doctor.ts` |
