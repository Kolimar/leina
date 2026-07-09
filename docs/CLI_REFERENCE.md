# leina — CLI Reference

This is the canonical reference for the `leina` command-line interface: every
command, its flags, and what it prints.

**leina exposes a command-line interface.** Every command operates on an explicit
`<dir>` (defaulting to `.`) and runs in a short-lived process.

- **Invocation:** `leina <command> [args]`.
- **Graph DB:** `<dir>/.leina/graph.db` (per project, git-ignored).
- **Memory DB:** `~/.leina/memory.db` (global, keyed by derived project key).

---

## Graph commands

All read commands (`query`, `affected`, `path`) route through the **freshness gate**:

- fresh → serve as-is;
- stale + posture `auto` → rebuild, then serve (prints a `rebuilding ...` note on stderr);
- stale + posture `refuse` → fail and tell you to run `refresh`.

### `build <dir> [--json]`
Build the graph for `<dir>` into `.leina/graph.db`. With `--json`, also export a
node-link dump to `.leina/graph.json`. Prints node/edge/file counts.

### `refresh <dir>`
Force a rebuild now, ignoring freshness. Prints node/edge/file counts.

### `status <dir>`
Report freshness (`fresh`/`STALE` + reason), posture, last build time, and tracked file
count. No rebuild.

### `stats <dir>`
Print node count, edge count, and an edge confidence breakdown.

### `query <dir> <question>`
Term-scored subgraph for a free-text question. Prints the resolved seeds and the
`source --relation--> target` edges of the subgraph.

### `affected <dir> <label> [depth]`
Blast radius — what (transitively, up to `depth`, default 3) depends on the symbol matching
`<label>`. **Run this before renaming or migrating a symbol.** Prints each dependent with its
relation and source location.

### `path <dir> <from> <to>`
Shortest dependency path between two symbols. Prints each hop as
`--relation(confidence)--> node`.

### `impact analyze [<dir>] <symbol> [--json]`
First-level **impact analysis**: a bidirectional traversal from the node matching `<symbol>`
over the impact relation set (code relations plus infra relations `deploys|reads|configures|exposes`),
categorising every reached node into `{files, tests, services, configs}`. It crosses
code→test→config→service through **real graph edges** (e.g. a `docker-compose` service whose
`build.context` points at a module emits a `reads` edge to that code node). With `--json`
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
button. The Louvain community is computed and persisted during build and surfaced as node detail.

Routes through the **freshness gate** (same as `query`/`affected`):
- stale + posture `auto` → rebuilds automatically before exporting;
- stale + posture `refuse` → fails with instruction to run `leina refresh <dir>`.

On success prints: `Exported graph.html ({N} nodes, {E} edges) -> {outPath}`.

> **`visualize` vs `graph serve`:** this is a one-shot **static file** for a single project (no
> memory, no server). For a **live server** with a multi-project selector and per-node anchored
> memory, use [`graph serve`](#graph-serve-dir---port-n---host-h). Same viewer, different tool.

**Workspace-aware:** if `<dir>` is a workspace root (see *Workspace commands* below), the
single-repo freshness gate is bypassed (it would clobber the merged graph) and the export
uses the merged workspace store instead. Default render is **constellation** mode (each repo
a super-node, cross-repo edges between them); pass `--drilldown` for the full merged graph
coloured by repo. `--single` / `--workspace` override auto-detection.

### `graph serve [<dir>] [--port <n>] [--host <h>]`
Start a **read-only, foreground** HTTP server exposing the graph + anchored memory of `<dir>`
as a JSON API, plus a vanilla-JS explorer UI at `/` (the same vendored vis-network viewer as
`visualize`). Routes through the same freshness gate as the other graph reads before starting,
and self-registers `<dir>` in the global project registry (`~/.leina/projects.json`) — the same
registry `build`/`refresh`/`init` opportunistically upsert into, which backs the UI's project selector.

Config resolves **port → host → token** with a 3-tier precedence (env > `.leina/config.json`
`"serve"` key > defaults): `LEINA_SERVE_PORT`/`LEINA_SERVE_HOST`/`LEINA_SERVE_TOKEN`, defaulting
to port `7423`, host `127.0.0.1`, no token. Bind is **strictly loopback** — a non-loopback
`--host`/config/env value is refused before the server ever binds. If a token is configured,
requests without a matching token get `401`; the comparison is constant-time.

JSON API (all read-only; non-GET → `405`; errors are `{"error":{"code","message"}}`):

| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects` | every project in the global registry |
| GET | `/api/projects/:key/stats` | node/edge counts by kind and by relation |
| GET | `/api/projects/:key/tree` | folder/file tree for the project selector |
| GET | `/api/projects/:key/search?q=` | label search |
| GET | `/api/projects/:key/nodes/:id` | node detail + `declaredBy`/`invokedBy` edges |
| GET | `/api/projects/:key/nodes/:id/memories?limit=` | latest anchored observations, drift-classified |

Runs in the **foreground** until Ctrl+C (`SIGINT` closes every open connection and releases the
port — no zombie process).

> **`graph serve` vs `visualize`:** not interchangeable. [`visualize`](#visualize-dir---out-path---drilldown---single--workspace)
> exports a **static, shareable `.html` file** for one project; `graph serve` is a **live server**
> (multi-project selector + per-node anchored memory) that only runs while the process is up.

---

## Workspace commands (multi-repo)

`leina workspace <build|status|detect|memory|visualize> [dir]` operates on a **multi-repo
workspace**: a directory that is either marked by a `workspace.json` at its root or contains
≥2 immediate child dirs with `.git` (source reported as `flag` / `workspace.json` /
`child-git-auto` / `git-root`). `--single` / `--workspace` flags override detection. A
workspace is stale when **any** member repo is stale.

### `workspace build [dir] [--json]`
Build every member repo's graph and the merged workspace store. With `--json` also exports
`<dir>/.leina/workspace-graph.json` (node-link dump of the merged graph). Prints merged
node/edge counts.

### `workspace status [dir]`
Report the detected mode; in workspace mode lists each member as `[fresh|STALE] <repoKey> (<dir>)`.

### `workspace detect [dir] [--single|--workspace]`
Print the detection result as JSON: `{mode, source, members[]}`.

### `workspace memory context [dir]` / `workspace memory search [dir] <query>`
**Federated memory** across all member repos: `context` shows recent sessions + observations
from every member; `search` runs full-text search over all members' observations (limit 20).

### `workspace visualize [dir] [--out <path>] [--drilldown]`
Equivalent to `visualize <dir> --workspace` (see above).

---

## Memory commands

`leina memory <sub> <dir> [flags]`. Memory lives in the **global** DB
(`~/.leina/memory.db`), partitioned by the project key derived from the repo's git remote /
root / dir name. Anchor resolution and drift verification are backed by the live graph.

If the project key is ambiguous (multiple git repos), commands fail with guidance to create
`.leina/config.json` with `{"project_name":"<name>"}`.

Observation `--type` values: `decision`, `bugfix`, `discovery`, `pattern`, `architecture`,
`config`, `manual` (default). `--scope` is one of nine values — `project` (default), `personal`,
`workspace`, `path`, `skill`, `process`, `technology`, `security`, `infra`. Search/`verified`
default to `--scope project`; pass an explicit `--scope` to retrieve observations saved under
the richer scopes. The live-row unique constraint is `(project_key, scope, topic_key)`.

### `memory save <dir> --title "..." --content "..." [--type t] [--topic key] [--scope s] [--anchors a,b]`
Add (or upsert) an observation. Passing `--topic <key>` evolves the existing entry with that
topic in place (prints `evolved rev N`); otherwise creates a new one. `--anchors` is a
comma-separated list of graph symbols the observation is about (resolved against the live
graph on save).

**Batch:** `memory save <dir> --batch [--atomic]` reads a JSON array of
`{title, content, type?, topicKey?, scope?, anchors?}` from stdin.

### `memory update <dir> <id> [--title ..] [--content ..] [--type ..] [--anchors a,b]`
Update an observation in place by id, bumping its revision. **Batch:**
`--batch [--atomic]` reads a JSON array of `{id, title?, content?, type?, anchors?}`.

### `memory search <dir> <query> [--type t] [--scope s] [--limit N]`
Full-text search (default limit 10). Prints `#id [type] [topic] title` plus a snippet per hit.

### `memory verified <dir> <query> [--type t] [--scope s] [--limit N]`
Search **plus drift classification** against the live graph. Buckets results into
`USABLE` / `WARNING` / `DO NOT USE` with a reason per hit. Prefer this over `search` when
you're about to act on remembered context. If the graph is unavailable, verdicts degrade to
unverified (still printed).

### `memory get <dir> <id>`
Print the full observation (title, type, topic_key, timestamps, revision, content).
**Batch:** `memory get <dir> --batch` reads a JSON array of id strings from stdin.

### `memory context <dir> [--limit N]`
Recent sessions + latest observations for the project. **Run this at the start of every
session** to restore prior decisions.

### `memory session <dir> --content "summary" [--title "..."]`
Save a session summary. Run at the **end** of a session.

### `memory session-start <dir> [--title "..."]`
Open a fresh session and print its id, to group later observations.

### `memory suggest-topic <dir> --title "..." [--type t]`
Suggest a normalized `topic_key` for a title, plus near-matches to existing topics.
Use before `add --topic` to avoid duplicate topics.

### `memory current-project <dir>`
Print the derived `project_key`, the detection `method`, and the raw name — no DB access.
Useful to debug ambiguous-project failures.

### `memory merge-projects <dir> --from <key> --to <key> [--dry-run]`
Move/merge all observations from one project key to another (after a remote rename, say).
`--dry-run` reports what would move.

### `memory reanchor <dir> [--dry-run]`
Retro-anchor **existing** observations that reference a real file/symbol in prose but were
saved without an explicit `--anchors`. Extracts only EXPLICIT references (a path matching a
node's `sourceFile`, or a symbol resolved with a functional-exact match against the live
graph) — ambiguous (2+ matches) or unresolved candidates are discarded, never guessed.
Minting is **additive** (unions with any anchors the observation already has) and
**idempotent** per `(observation_id, node_id)`: re-running never duplicates a row.
`--dry-run` reports what would be minted/rejected without writing. Prints a summary
(`{processed, minted, rejected}`) plus a per-observation breakdown.

### `memory export <dir> [--out file.jsonl]`
Dump this project's observations + anchors as JSONL (to `--out` or stdout).

### `memory import <dir> [--in file.jsonl]`
Merge an export from stdin (or `--in file.jsonl`); newer revision wins.

### `memory sync <dir>`
Two-way merge with a committable `.leina/memory-export.jsonl` snapshot.

---

## Audit, findings & artifacts

`leina audit [<sub>] [dir] [flags]` runs source→sink candidate-path analysis over the
(possibly merged) graph. Output is **evidence for triage** — candidate data-flow routes, never
confirmed vulnerabilities (a disclaimer banner is always printed). The audit pack carries
`schemaVersion` and a `findings[]` array.

### `audit [dir] [--format md|json|html] [--json] [--from <id,...>] [--max-pack-kb <N>]`
Run the audit and render it. The format selects the renderer:
- no `--format` → human-readable text;
- `--format md` → Markdown report to stdout;
- `--format json` (or the `--json` alias) → machine-readable `AuditPack` to stdout, including
  `findings[]` (each `{severity, evidence, relatedNodes, suggestedActions, confidence}`) and
  `schemaVersion`;
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

An append-only local **event outbox** records domain events (`schemaVersion: 1`). It is
**off by default** — stdout/UX are unchanged unless you opt in.

### `events tail [dir] [--json]`
Print the most recent events from the outbox. With `--json` prints the raw JSONL event
objects. When persistence is off it prints a hint to enable it.

**Enable persistence:** set `LEINA_EVENTS_PERSIST=1`. Events are then appended as JSONL to
`~/.leina/events/outbox.jsonl` and emitted after successful `graph.built`, `audit.completed`,
and `memory.created` operations. Payloads are redacted so the outbox stays free of sensitive
content, and everything stays local — there is no cloud dependency.

---

## Env store (names, not values)

`leina env <sub>` manages service credentials for skills that call authenticated services,
under the **names-not-values contract**: an AI agent only ever handles variable *names* —
values never travel through argv, model context, or captured stdout. Storage is a global
`~/.leina/.env` (0600, plain text). `env list` warns if the file's permissions are
group/other-readable.

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

Exits with the child's exit code.

---

## Sidecar commands (Java / C# compiler-grade extraction)

`leina sidecar [build|install|status|clean|verify] [csharp|java] [--force]` manages the optional
on-demand compiler sidecars. Without a sidecar, Java/C# still extract via tree-sitter (SYNTACTIC —
call edges best-effort); the sidecar adds compiler-grade precision.

- `sidecar status` — report whether each sidecar is configured and whether the toolchain is present.
- `sidecar install [csharp|java]` — download a prebuilt, sha256-verified sidecar binary from the
  release assets and cache it (no local .NET/JDK toolchain required); `sidecar build` is the
  local-toolchain alternative.
- `sidecar build <csharp|java>` — build the sidecar (needs the local toolchain: dotnet SDK for C#;
  JDK 17+ with `jpackage` for Java).
- `sidecar clean [csharp|java]` — remove built sidecars.
- `sidecar verify <java|csharp>` — verify the extractor against a minimal fixture. **Honest
  skip**: if the toolchain is missing it prints `<lang>: skip — …` and exits `0` (never a
  spurious failure); with the toolchain present it runs a normal extraction and reports
  `ok`/`fail` plus a verification check.

All extractors (ts-morph, the two sidecars, tree-sitter, and the YAML-infra extractor) implement
a common extractor contract and each extraction returns a versioned result
(`schemaVersion: 1`, with diagnostics, duration, and errors).

---

## SCIP commands (compiler-grade ingestion via third-party indexers)

`leina scip [status|verify|install] [go|rust|python]` detects/verifies/instructs installation of
**third-party SCIP indexer binaries** (SCIP = [SCIP protocol](https://sourcegraph.com/docs/scip),
a compiler-grade code intelligence index format). Unlike the C#/Java sidecars above — which
leina builds and bundles itself — SCIP indexers (e.g. `scip-go`, `rust-analyzer`, `scip-python`)
are tools the USER installs via their own language's package manager; leina never downloads,
builds, or auto-installs one. Without an indexer, the language still extracts via tree-sitter
(SYNTACTIC); an available indexer upgrades that language to compiler-grade precision, ahead of
tree-sitter in the extractor order. `go`, `rust`, and `python` are the three languages wired
end-to-end.

- `scip status [go|rust|python]` — report whether each SCIP indexer is found on `PATH` (or via
  its env override), printing the install command otherwise.
- `scip install [go|rust|python]` — **detect + instruct only**: prints the command to install the
  indexer (e.g. `go install github.com/scip-code/scip-go/cmd/scip-go@latest` for Go,
  `rustup component add rust-analyzer` for Rust, `npm install -g @sourcegraph/scip-python` for
  Python — which also needs a working `pip` on `PATH`, e.g. any venv's `bin/`); never downloads or
  runs anything on the user's behalf.
- `scip verify [go|rust|python]` — verify the extractor against a minimal fixture. **Honest
  skip**: if the indexer isn't found it prints `<lang>: skip — …` and exits `0` (never a spurious
  failure); with the indexer present it runs a real index + parse and reports `ok`/`fail` plus
  node/edge counts.

The SCIP extractor (id `scip-<lang>`, e.g. `scip-go`, `scip-rust`, `scip-python`) runs
whole-project: it invokes the indexer against the project root and translates each SCIP symbol to
a leina graph id byte-identical to what tree-sitter/ts-morph would produce for the same symbol.
For Rust, a single `rust-analyzer scip .` at the workspace root covers every crate in a Cargo
workspace (cross-crate calls resolve within that one invocation). For Python, scip-python is
installed via npm and leina derives node kinds and labels from the resolved id chain. The `.scip`
output always lands in an ephemeral temp directory that is deleted immediately after being read —
never under the project root. If the indexer is missing, fails, or produces a partial/corrupt
index, the SCIP extractor reports non-fatal errors and claims nothing, leaving tree-sitter to
process those files.

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
`memory session-start`, `merge-projects`, and the install/lifecycle commands.

Consent: the server honours the per-repo opt-out — a tool call whose `root` has
`.leina/consent = disabled` fails with an actionable error (`doctor_run` stays available).

### Registration

MCP hosts (`claude`, `cursor`, `windsurf`) are a different set from the install hosts
(`devin`, `claude`). `--hosts` is **required** on `mcp register`/`unregister`.

```bash
leina mcp register --hosts claude,cursor,windsurf     # USER-GLOBAL: one entry per host,
                                                       # available in every project
leina mcp unregister --hosts claude,cursor,windsurf   # inverse
leina mcp status                                       # read-only per-host state
leina activate --hosts devin,claude --mcp --mcp-hosts claude   # register during install
leina setup --hosts devin,claude --mcp --mcp-hosts claude
leina init <dir> --mcp                                 # PROJECT-LEVEL .mcp.json (committable,
                                                       # for teams) + mcp__leina grant
```

`--mcp` on `activate`/`setup` **requires** a companion `--mcp-hosts <claude|cursor|windsurf>[,...]`.
`leina init <dir> --mcp` writes a project-level `.mcp.json` and needs no host list.

Host mechanics: Cursor (`~/.cursor/mcp.json`) and Windsurf
(`~/.codeium/windsurf/mcp_config.json`) are merged in place (only the `leina` entry is
owned; foreign servers and unknown keys survive; malformed JSON is never clobbered; a
host is only touched if its config directory already exists). Claude Code registration
delegates to `claude mcp add --scope user leina leina mcp` (its `~/.claude.json` is
host-owned state leina never writes) and grants `mcp__leina` (server-level, all tools) in
`~/.claude/settings.json`. `deactivate`/`disable` remove the user-global registrations;
`deinit` removes the project one. `leina doctor` reports registration state per host and
fails only when a registration exists but `leina` does not resolve on PATH.

---

## Install / lifecycle commands

leina exposes a **layered, fully reversible** command model — every install command has an
explicit inverse, and nothing acts in a repo without consent. Every host-touching command
takes an explicit `--hosts` (`devin`, `claude`) — leina never picks a host on its own.

| Layer | Command | Inverse | Blast radius |
|---|---|---|---|
| **Machine** (one-shot) | `setup` | `disable` | machine-wide: global share + symlinks + user-global config + blanket sentinel |
| **Global** (granular) | `activate` | `deactivate` | machine-wide: global share + symlinks + user-global `Exec` grant + hooks |
| **Repo** (granular) | `init` | `deinit` | one repo: consent flag (+ `AGENTS.md`/`.devin/*` when standalone) |
| **Repo** | `build` | — | one repo: `graph.db` (on-demand) |

**Blanket + tri-state consent.** `setup` turns on a machine-wide **blanket sentinel**
(`~/.leina/.blanket`). Independently, each repo carries a **local, git-ignored consent flag**
(`.leina/consent`) with three states:

- `unknown` (no flag) — the agent gate stays **silent** (no injection, no advisories); the
  `leina-setup` skill prompts the user once ("leina available — use this workspace?").
- `enabled` — leina acts: gate injects memory + graph stats, advisories fire, and (under
  blanket) the graph self-heals on `SessionStart`. Written by `init`.
- `disabled` — permanent silent no-op. Written by `deinit`.

A repo that has only a `.devin/hooks.v1.json` but no consent flag resolves to `unknown`, so it
is re-prompted once rather than silently silenced.

### `setup --hosts devin,claude [--no-user-hooks] [--mcp --mcp-hosts <...>]`
The one-shot "magic" command (once per machine). Composes `activate` (share + symlinks +
user-global `Exec` grant + hooks) **and** turns the blanket sentinel ON. Idempotent. After `setup`,
leina is available in every session and each repo is governed by its consent flag.
`--no-user-hooks` skips merging the user-global hooks. Add `--mcp --mcp-hosts <...>` to register
the MCP server during install.

### `disable`
Inverse of `setup` (once per machine). Turns the blanket sentinel OFF and runs the global
teardown (unlinks hosts, revokes the CLI `Exec` grant, removes the user-global hooks).
Strip-inverse only — removes leina's managed entries while preserving any third-party
symlinks/grants/hooks. Idempotent (a second `disable` exits 0).

### `init <dir> [--hosts devin,claude] [--profile devin|windsurf] [--freshness auto|refuse] [--build] [--name <project-name>] [--mcp] [--claude-hooks]`
Per-repo opt-in — **adaptive** on whether blanket is active. Always writes the consent flag
`enabled` and ensures the `.gitignore` block. Then:

- **LIGHT** (blanket active): nothing else, and it needs neither `--hosts` nor `--profile`. The
  machine-wide share/grant/hooks from `setup` already cover this repo, so `AGENTS.md` and
  `.devin/*` are redundant and are **not** written.
- **FULL** (standalone, no blanket): **requires** both `--hosts` and `--profile devin|windsurf`.
  Also writes the `AGENTS.md` protocol block, `.devin/hooks.v1.json`, and a **repo-local**
  `Exec(leina)` grant in `.devin/config.json` — making the repo self-contained. **Never** mutates
  the user-global `~/.config/devin/config.json`.

`init` does **no** auto-build. Pass `--build` to run a graph build **synchronously in the
foreground** (with progress) right after wiring. `--name <project-name>` writes a committable
`.leina/config.json` locking the project key. `--profile windsurf` adds the Windsurf
capabilities section to `AGENTS.md` (FULL only). `--mcp` writes a project-level `.mcp.json`.
`--claude-hooks` forces the Claude Code hooks even when the `claude` host isn't in `--hosts`.

Example (standalone full init):

```bash
leina init <dir> --hosts claude --profile devin
```

### `deinit [dir]`
Inverse of `init` (per repo). Writes the consent flag `disabled` and strip-inverse removes the
repo's managed artifacts: the `AGENTS.md` protocol block, the `.gitignore` block, the local
`Exec` grant, and `.devin/hooks.v1.json`. User content outside the managed markers is preserved.
Idempotent — when there is nothing to revert (e.g. after a LIGHT init) it exits 0 with a
"nothing to revert" note.

### `activate --hosts devin,claude [--mcp --mcp-hosts <...>]`
The global half of `setup` (once per machine), without flipping the blanket sentinel. Populate
`~/.leina/share/{skills,agents,workflows}` from bundled assets and symlink each entry into the
hosts' global dirs (`~/.config/devin/{skills,agents}`), and write the user-global config (the
`Exec(leina)` grant + hooks). Add `--mcp --mcp-hosts <...>` to register the MCP server too.

### `deactivate`
Inverse of `activate` (once per machine). Runs the global teardown (unlinks hosts, revokes the
CLI `Exec` grant, removes the user-global hooks) but **leaves the blanket sentinel untouched**
(that is `disable`'s concern). Strip-inverse, idempotent.

### `version` (aliases: `--version`, `-v`)
Print the installed package version and exit. No project or DB access.

### `help` (aliases: `--help`, `-h`)
Print the root usage text. The same text is printed for any unknown command.

### `doctor [dir] [--json]`
Diagnose install + project health. Each check reports at one of four severities — **ok** /
**info** / **warn** / **fail** — colourised, with optional or not-applicable items grouped in a
trailing **info** section, and a final summary line. With `--json` emits the full `DoctorReport`,
including the `repoIdentity` aggregate (`{projectKey, strategy, confidence: "high"|"medium"|"low",
pathHash, rootCommit?, normalizedRemote?}`). `pathHash` is a cross-OS-deterministic SHA-256 of the
normalised absolute path; `normalizedRemote` is the `host/org/repo` canonical form. `doctor` never
changes its exit code (it is informational).

### `verify [dir] [--json]`
Re-run the same checks as `doctor` but with an **actionable exit code** — exit `1` if any check
is `fail`, `0` otherwise (warn-only still exits 0). With `--json` returns the `DoctorReport`
(carrying the same `repoIdentity`) plus an `exitCode` field, for CI gating.

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

Never touches `graph.db` / `memory.db`. Ends by re-running doctor; remaining failures drive a
non-zero exit.

### `tui [dir]`
Interactive console. Menus for: status (doctor summary), install/update with **asset-group
selection** (catalog presets / individual skills & agents), init/deinit of the current repo,
repair, env-variable management (password-style prompt, masked listing), and uninstall. A thin
presentation layer **by design**: every action dispatches to the same handlers the flag-based
commands use, so the TUI can never drift from CLI behaviour. Requires a real interactive terminal
on stdin+stdout; otherwise it fails pointing at the non-interactive equivalents.

### `capabilities list [--json]`
List the **system capabilities** that expose core use cases as transport-agnostic contracts,
e.g. `graph.query`, `graph.status`, `memory.add`, `memory.search`, `context.build`, `audit.run` —
run the command for the full, current list, since the registry grows over time. With `--json`
prints an array of `{id, description, inputSchema, outputSchema, schemaVersion, transports}`. Each
output schema is versioned (`schemaVersion: 1`). This registry lets any transport (CLI, HTTP, SDK,
TUI, …) resolve the same use cases without duplicating logic.

### `agent-hook <Event>` (alias: `devin-hook`)
Host-neutral agent hook gate; reads the payload JSON on stdin (`devin-hook` is a compatibility
alias — existing `.devin/hooks.v1.json` installs invoke it). Events: `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `SessionStart`, `PostCompaction`, `Stop`. **Advisory only** — never blocks.
**Scope-aware**: the gate is a silent no-op unless the repo's consent flag is `enabled`, so a
user-global hook stays quiet in repos that haven't opted in (`unknown`/`disabled`).

**Auto-build self-heal (SessionStart)**: on every `SessionStart` **for a consented (`enabled`)
repo**, if `graph.db` is absent or the manifest is stale, a detached `leina build` is spawned
in the background before context injection runs. It never fires in `unknown`/`disabled` repos,
so leina never builds a graph in a workspace you haven't opted into. A freshness nudge remains the
fallback for the current session; the background build materialises a fresh graph for the next
session. This is advisory/fail-open — any spawn error is silently swallowed and context injection
proceeds normally. Suppress with `LEINA_DISABLE_AUTOBUILD=1`.

**Lock file**: both `init` and `SessionStart` auto-build coordinate via
`.leina/graph.build.lock` (JSON `{ pid, startedAt }`), written with `O_EXCL` to serialise
concurrent triggers. A stale lock (dead PID, or `startedAt` older than 15 min) is automatically
reclaimed.
