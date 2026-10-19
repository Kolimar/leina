# leina — CLI Reference

This is the canonical reference for the `leina` command-line interface: every
command, its flags, and what it prints.

**leina exposes a command-line interface.** Every per-project command takes an optional
`<dir>` (default: the current directory, resolved to the project root — see
[The project directory](#the-project-directory-dir)) and runs in a short-lived process.

- **Invocation:** `leina <command> [args]`.
- **Graph DB:** `<root>/.leina/graph.db` (per project, git-ignored).
- **Memory DB:** `~/.leina/memory.db` (global, keyed by derived project key).

### Help, usage errors and exit codes

One command table (`src/cli/commands.ts`) drives the help and the argument checks:

- `leina --help` (or `leina help`, or `leina` alone) prints the root help: the everyday
  commands first, then every command grouped by area.
- `leina <command> --help`, `leina <command> -h` and `leina help <command>` print that
  command's own help — usage forms, flags, positional rules and examples. Groups work the
  same way (`leina memory --help`, `leina harness contract --help`); a group run without a
  sub-command prints its help (except `mcp`, `sidecar`, `scip` and `audit`, which run bare).
- Before any handler runs, the dispatcher rejects an unknown command, sub-command or flag and
  a flag missing its value, with a suggestion for near misses (`did you mean 'memory'?`) and
  for a swapped order (`leina memory . context` → `the sub-command comes first`).
- `--flag=value` is accepted wherever `--flag value` is. Everything after `--` belongs to
  another program (`env exec -- <cmd...>`) and is never checked. The hook entry points
  (`agent-hook`, `harness hook`) are never validated: they fail open.

| Exit code | Meaning | Where it is printed |
|-----------|---------|---------------------|
| `0` | Success (help included) | stdout |
| `1` | Runtime failure: no graph, no match (`did you mean`), a failed check, I/O or DB error | stderr |
| `2` | Usage error: unknown command / sub-command / flag, a missing or invalid argument (`--limit six`) | stderr, as `leina <command>: <message>` plus `run 'leina <command> --help' for usage` |

Command-specific contracts keep their documented codes: `harness verify` (`0` complete, `1`
blocking failure, `2` engine or config error), `verify` (`1` when a check fails), `env exec`
(the child's code) and the hook entry points, which follow their host's hook contract.

### The project directory (`<dir>`)

Every per-project command takes an optional `<dir>`: any directory inside the project,
defaulting to the current directory. It is resolved to the **project root** — the nearest
enclosing directory that is already a leina project (it holds `.leina/graph.db`,
`.leina/consent` or a `.leina/config.json` name lock), else the git toplevel; outside git, the
directory itself unless an ancestor is a project (a multi-repo workspace root). The walk never
crosses a git toplevel, so a nested worktree or repo stays its own project, and a monorepo
package that was `init`ed (or name-locked) on its own stays separate. A command run from
`src/` therefore reads and builds the repo's graph and memory instead of creating a second
project there. `leina status` prints the resolved `root:` first.

An explicit `<dir>` that is not an existing directory is a usage error (exit `2`) — never
created. Flag values are never read as `<dir>` (`visualize --out x.html` writes `x.html`).
Positional rules:

| Command | Positionals |
|---------|-------------|
| `build`, `refresh`, `status`, `stats`, `visualize`, `graph serve`, `doctor`, `verify`, `repair`, `audit …`, `memory` (other sub-commands) | at most one: `<dir>` |
| `query`, `memory search`, `memory verified` | `[<dir>] <text...>`: the first word is `<dir>` only when more words follow **and** it is an existing directory or path-shaped (`.`, `./x`, `/x`, `~/x`; a missing one is an error); otherwise every word is text |
| `affected`, `impact analyze` | one = `<symbol>`; two = `<dir> <symbol>` |
| `path` | two = `<from> <to>`; three = `<dir> <from> <to>` |
| `memory get` / `update` / `resolve` / `reopen` | one = `<id>`; two = `<dir> <id>` (with `--batch`: at most `<dir>`) |
| `init`, `deinit`, `workspace …` | at most one `<dir>`, taken **as given** (never resolved upwards); `init` creates it when missing, the others require it |

`init`, `deinit` and `repair` also accept `--project <dir>` (the same argument; giving both with
different values is a usage error).

---

## Graph commands

All read commands (`query`, `affected`, `path`) route through the **freshness gate**:

- fresh → serve as-is;
- stale + posture `auto` → rebuild, then serve (prints a `rebuilding ...` note on stderr);
- stale + posture `refuse` → fail and tell you to run `refresh`.

Rebuilds of one project are serialized across processes by `.leina/graph.build.lock` — the
same lock `build`, `refresh`, the MCP server and the SessionStart self-heal take. When several
processes find the graph stale at once, one rebuilds and each of the others prints
`another leina process (pid N) is rebuilding it; waiting ...`, then re-checks: if the graph is
fresh by then it answers from it without rebuilding (N concurrent stale queries → one rebuild,
not N). The wait is bounded by `LEINA_BUILD_LOCK_WAIT_MS` (default `120000`); past it the
command exits `1` naming the holder's pid and the lock file to delete if it is stuck.
`build`/`refresh` wait the same way, then always rebuild.

### `build [<dir>] [--json]`
Build the graph for `<dir>` into `.leina/graph.db`. With `--json`, also export a
node-link dump to `.leina/graph.json`. Prints node/edge/file counts.

Sources are discovered through git inside a work tree (tracked + untracked-not-ignored files, so
`.gitignore` is honoured) and by walking the tree outside git. Nested repositories/worktrees,
hidden directories other than CI config dirs (`.github`, `.gitlab`, `.circleci`, …), dependency
and build dirs, minified bundles and symlinks are never sources — see
[The code graph](concepts/02-grafo.md#which-files-count-as-sources).

Source files larger than **4 MiB** are skipped (a `[build] skipped <file>` diagnostic on
stderr; listed in the build report's `oversizeSkipped`) and the freshness check ignores them
the same way, so a huge generated or vendored file can neither exhaust memory nor keep the
graph permanently stale.

When part of the project is extracted with reduced precision — C#/Java without a compiler
sidecar, Go/Rust/Python without a SCIP indexer, YAML without its grammar — `build`/`refresh`
print one `note:` line per case on stderr after `Done.`, naming the command that upgrades it.
Only product code counts: a language that appears only under test, fixture, vendor or example
paths gets no note. A stale auto-rebuild on
the read path prints only its `rebuilding ...` line — no notes, no extractor diagnostics.

`build` and `refresh` refuse a `<dir>` that does not exist or is not a directory: they exit `1`
with `cannot build the graph: no such directory: <abs>` and create, build and register nothing
(previously a mistyped argument created the directory and registered an empty project).

### `refresh [<dir>]`
Force a full rebuild now, ignoring freshness. Unlike `build`, it never reuses a per-file
extraction cached by a previous build (`.leina/extract-cache.db`) — every file is extracted
again — so it is the escape hatch from any incremental-cache problem. Prints node/edge/file
counts.

### `status [<dir>]`
Report freshness (`fresh`/`STALE` + reason), posture, last build time, and tracked file
count, then one `degraded: <note>` line per reduced-precision path of the last build (the same
notes `build` prints). No rebuild.

Besides a source being `added:`, `removed:` or `touched:`, the graph is stale when it was built
by another leina — `leina upgraded (2.1.0 → 3.0.0)`, `leina downgraded (…)`, `extractor changed
(schema 1 → 2)` — or when a resolution config was added, removed or edited since the build:
`config changed:<rel>` for `tsconfig*.json`, `jsconfig.json` or any `package.json` (an edited
`paths` map or `exports` field re-routes imports without touching a source). As for sources, an
mtime-only change of a config (checkout, save-without-edit) does not count.

### `stats [<dir>]`
Print node count, edge count, and an edge confidence breakdown. Read-only: a project without a
graph exits `1` with the `leina build` command to run (it no longer creates an empty
`graph.db`).

### `query [<dir>] <question...> [--json] [--include-tests]`
Relevance-ranked subgraph for a free-text question in English or Spanish (stopwords
dropped, camelCase split, stemmed, IDF-weighted — see
[Search and queries](concepts/03-busqueda-y-consultas.md)). Prints the seeds, every node of
the subgraph (at most 25) with its kind and `file:line`, and its semantic edges
(`source --relation--> target` plus the `file:line` where each happens; structural
`contains`/`method` edges are omitted). Test/mock/fixture nodes are penalised as seeds and left
out of the neighbourhood unless `--include-tests` is passed or the question is about tests.
With `--json` prints the result as one line of JSON — the same shape the MCP `graph_query`
tool returns. Flags may sit anywhere; they are never part of the question. With two or more
words the first is `<dir>` only when it is an existing directory or path-shaped (see
[The project directory](#the-project-directory-dir)) — `leina query . src layout` asks about
"src layout".

### Selecting a symbol (`affected`, `path`, `impact analyze`)
A symbol argument is matched **exactly** — never by substring. Accepted forms, tried in
this order:

| Form | Example |
|---|---|
| node id | `src_cli_doctor_ts:checkgraph` |
| `<path>:<symbol>` — the path is the file or a `/`-aligned suffix of it | `src/cli/doctor.ts:checkGraph`, `memory-repository.ts:SQLiteMemoryRepository.search` |
| name — `()` optional, case-insensitive allowed | `checkGraph`, `src/cli/doctor.ts` |
| `Class.method` (or `Class#method`) | `SQLiteMemoryRepository.search` |
| a `/`-aligned file path suffix (selects the module) | `handlers/graph.ts` |

When several nodes match, the best one is used — case-exact before case-insensitive,
production code before test/mock/fixture paths, function/method/class before
interface/type before anything else before modules, then file path and line — and a
`note:` on stderr lists the other matches, each with a selector that picks it. With no
exact match the command prints `no exact match for "X"; did you mean:` with up to 5
candidates (and their selectors) and exits 1.

### `affected [<dir>] <symbol> [--depth <n>]`
Blast radius — what (transitively, up to `--depth`, default 3) depends on `<symbol>` (see
[Selecting a symbol](#selecting-a-symbol-affected-path-impact-analyze)). **Run this before
renaming or migrating a symbol.** Prints one line per dependent — its label (methods qualified
as `Class.method()`), the relation, and the `file:line` where the dependency happens (the call
site or reference, not the dependent's definition line). Interfaces are followed: for a
method that implements an interface member (or overrides a base method), the callers of that
member are dependents too — code typed against the port runs the implementation — and are
labelled `[calls via Port.method()]`; for an interface member, its implementations are
listed (`[implements]`) along with their own callers.

### `path [<dir>] <from> <to>`
Shortest dependency path between two symbols (both resolved like `affected`'s). Prints the
start node with its definition site, then one line per hop with the edge's `file:line`. The
search ignores edge direction, the output does not: `--calls(EXTRACTED)--> b` means the
previous node calls `b`; `<--calls(EXTRACTED)-- b` means `b` calls the previous node.

### `impact analyze [<dir>] <symbol> [--json] [--depth <n>]`
First-level **impact analysis**: a bidirectional traversal from the node matching `<symbol>`
over the impact relation set (code relations plus infra relations `deploys|reads|configures|exposes`),
categorising every reached node into `{files, tests, services, configs}`. It crosses
code→test→config→service through **real graph edges** (e.g. a `docker-compose` service whose
`build.context` points at a module emits a `reads` edge to that code node). With `--json`
prints `{"impacted":{"files":[…],"tests":[…],"services":[…],"configs":[…]}}`. `<symbol>` is
resolved like `affected`'s; with no exact match it exits 1 after the did-you-mean message
(with `--json`, stdout still carries the empty shape plus `seed: null`, `note` and
`suggestions`). Routes through the freshness gate like the other graph reads.

### `visualize [<dir>] [--out <path>] [--drilldown] [--single|--workspace]`
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

### `graph gc [--dry-run] [--json]`
Housekeeping for the global project registry (`~/.leina/projects.json`): drop every entry
whose root no longer exists on disk (a deleted checkout, a moved repo). Reads already ignore
vanished roots, so stale entries are harmless — they just accumulate. `--dry-run` lists what
would be removed without rewriting the registry; `--json` prints
`{path, dryRun, kept, removed[]}`. Never touches any `graph.db` or the memory db.

---

## Workspace commands (multi-repo)

`leina workspace <build|status|detect|memory|visualize> [<dir>]` operates on a **multi-repo
workspace**: a directory that is either marked by a `workspace.json` at its root or contains
≥2 immediate child dirs with `.git` (source reported as `flag` / `workspace.json` /
`child-git-auto` / `git-root`). `<dir>` is the workspace root as given (default: the current
directory; never resolved upwards; it must exist). `--single` / `--workspace` override
detection for `build`, `status`, `detect` and `visualize`. A workspace is stale when **any**
member repo is stale.

### `workspace build [<dir>] [--json] [--single|--workspace]`
Build every member repo's graph and the merged workspace store. With `--json` also exports
`<dir>/.leina/workspace-graph.json` (node-link dump of the merged graph). Prints merged
node/edge counts.

### `workspace status [<dir>] [--single|--workspace]`
Report the detected mode; in workspace mode lists each member as `[fresh|STALE] <repoKey> (<dir>)`.

### `workspace detect [<dir>] [--single|--workspace]`
Print the detection result as JSON: `{mode, source, members[]}`.

### `workspace memory context [<dir>]` / `workspace memory search [<dir>] <query...>`
**Federated memory** across all member repos: `context` shows recent sessions + observations
from every member; `search` runs full-text search over all members' observations (limit 20).

### `workspace visualize [<dir>] [--out <path>] [--drilldown]`
Equivalent to `visualize <dir> --workspace` (see above).

---

## Memory commands

`leina memory <sub> <dir> [flags]`. Memory lives in the **global** DB
(`~/.leina/memory.db`), partitioned by the project key derived from the repo's git remote /
root / dir name. Anchor resolution and drift verification are backed by the live graph.

If the project key is ambiguous (multiple git repos), commands fail with guidance to create
`.leina/config.json` with `{"project_name":"<name>"}`.

Observation `--type` values: `decision`, `bugfix`, `discovery`, `pattern`, `architecture`,
`config`, `preference`, `manual` (default). `--scope` is one of nine values — `project` (default), `personal`,
`workspace`, `path`, `skill`, `process`, `technology`, `security`, `infra`. Search/`verified`
default to `--scope project`; pass an explicit `--scope` to retrieve observations saved under
the richer scopes. The live-row unique constraint is `(project_key, scope, topic_key)`.

Both sets are **closed**: every write (`save`, `update`, their `--batch` items, MCP
`memory_add`/`memory_update`) and the `search`/`verified` filters reject any other value with
an error that lists the accepted ones (a batch fails only the offending item). Older versions
stored `--type` unvalidated; opening the db with 3.0 migrates those rows once, in place:
`note`, `reference`, `suggestion` and `project` become `discovery`, any other unknown type
becomes `manual`, and an unknown scope becomes `project`. `memory import` / `sync` accept the
same legacy aliases, so an export taken before the upgrade still loads.

### `memory save [<dir>] --title "..." --content "..." [--type t] [--topic key] [--scope s] [--anchors a,b]`
Add (or upsert) an observation. Passing `--topic <key>` evolves the existing entry with that
topic in place (prints `evolved rev N`); otherwise creates a new one. `--anchors` is a
comma-separated list of graph symbols the observation is about (resolved against the live
graph on save).

**Batch:** `memory save <dir> --batch [--atomic]` reads a JSON array of
`{title, content, type?, topicKey?, scope?, anchors?}` from stdin.

### `memory update [<dir>] <id> [--title ..] [--content ..] [--type ..] [--anchors a,b] [--status s] [--resolution "..."]`
Update an observation in place by id (the revision is kept — evolve through `save --topic`
for a new revision). `--status active|resolved|obsolete` changes its lifecycle (see
`memory resolve`); `--resolution` is a short note that needs a non-active status. A
status-only change keeps `updated_at`, so it never reorders anything by recency. **Batch:**
`--batch [--atomic]` reads a JSON array of
`{id, title?, content?, type?, anchors?, status?, resolution?}`.

### `memory resolve [<dir>] <id> [--note "..."] [--obsolete]`
Close an observation without deleting it: status `resolved` (or `obsolete` with
`--obsolete`), stamped with today's date and the optional `--note`. A non-active note leaves
the SessionStart injection and `memory context`; `search`, `verified` and `get` still return
it, labelled (`(resolved)`, `status: resolved 2026-07-19 — note`) and ranked below active
notes. The drift verdict stays independent of the status. Re-saving the same `--topic` brings
the note back as active. **Batch:** `memory resolve <dir> --batch [--atomic]` reads a JSON
array of id strings or `{id, note?, obsolete?}` objects (`--note` / `--obsolete` set the
default for every item).

### `memory reopen [<dir>] <id>`
Set the status back to `active` and clear the resolution note.

### `memory search [<dir>] <query...> [--type t] [--scope s] [--limit N]`
Full-text search (default limit 10). Prints `#id [type] [topic] title` plus a snippet per hit.
The query is the positional words only (flag values such as `--limit 6` are never part of
it). Ranking — identical with FTS5 and the `LIKE` fallback, accent- and case-insensitive:
exact hits first (prefix-fallback hits only fill a short page, below them), active notes
before resolved/obsolete ones, then relevance plus boosts for an exact / family topic-key
match and the phrase in the title or content, with a small recency prior (details in
[concepts/04](./concepts/04-memoria.md#how-its-searched-bm25)).

### `memory verified [<dir>] <query...> [--type t] [--scope s] [--limit N]`
Search **plus drift classification** against the live graph. Buckets results into
`USABLE` / `WARNING` / `DO NOT USE` with a reason per hit. Prefer this over `search` when
you're about to act on remembered context. If the graph is unavailable, verdicts degrade to
unverified (still printed).

Anchors saved by 3.0 carry a **symbol fingerprint** (`sym1:`): a note goes `stale` when its
anchored symbol's own lines change, not when anything else in the file does. Whole-file anchors
(module/config nodes, other languages, anchors saved before 3.0) still compare the file — and a
whole-file anchor into a file whose symbols the same note pins does not count as stale. Drifted
`decision`/`preference` notes land in `WARNING` with `⚠ check-violation` (before 3.0 they were
`USABLE`). The lifecycle status is printed next to the drift state and caps the verdict:
`resolved` notes are at best `WARNING`, `obsolete` ones `DO NOT USE`. Details in
[concepts/05](./concepts/05-comunicacion-grafo-memoria.md).

### `memory get [<dir>] <id>`
Print the full observation (title, type, topic_key, status, timestamps, revision, content). Ids are
scoped to the current project: another project's id reads as not found (same for
`memory update`). Every id-keyed verb (`get`, `update`, `resolve`, `reopen`, and MCP
`memory_get` / `memory_update`) also accepts the **short id** `memory context` prints — the
first 8 hex chars of the id's uuid tail, or any unique prefix of at least 4; a prefix shared by
several observations is an error asking for more characters.
**Batch:** `memory get <dir> --batch` reads a JSON array of id strings from stdin.

### `memory context [<dir>] [--limit N]`
Recent sessions + the most relevant **active** observations for the project (resolved/obsolete
notes are left out). **Run this at the start of every session** to restore prior decisions.
It shows the same ranked view the SessionStart injection and MCP `memory_context` use:

- **Ranking:** type weight (`decision`/`preference` 1.0, `architecture` 0.9, `pattern` 0.85,
  `bugfix` 0.8, `config` 0.75, `discovery` 0.7, `manual` 0.6) × recency decay (45-day
  half-life, measured from the project's newest note, with a 10% floor); ties break by
  newest, then id — the same data always prints in the same order.
- **Diversity:** at most 2 notes per topic family — the first two segments of the topic key,
  never the leaf (`sdd/auth/*` → `sdd/auth`, a flat `backlog/x` → `backlog`).
- **Format:** `- [type] title (#shortid · YYYY-MM-DD · topic)` followed by up to three preview
  lines (~280 chars). `--limit` (default 10) sets how many notes are shown. The
  `RECENT SESSIONS` block keeps full session ids.

### `memory session [<dir>] --content "summary" [--title "..."]`
Save a session summary. Run at the **end** of a session.

### `memory session-start [<dir>] [--title "..."]`
Open a fresh session and print its id, to group later observations.

### `memory suggest-topic [<dir>] --title "..." [--type t]`
Suggest a normalized `topic_key` for a title, plus near-matches to existing topics.
Use before `add --topic` to avoid duplicate topics.

### `memory current-project [<dir>]`
Print the derived `project_key`, the detection `method`, and the raw name — no DB access.
Useful to debug ambiguous-project failures.

### `memory merge-projects [<dir>] --from <key> --to <key> [--dry-run]`
Move/merge all observations from one project key to another (after a remote rename, say),
including the superseded snapshots of their topics (the revision history moves with them),
and its sessions. On a topic collision the `--to` row wins and the `--from` row becomes one of
its snapshots. `--dry-run` reports what would move. Older versions moved only live rows; the
3.0 schema migration re-homes snapshots they stranded under the old key.

### `memory reanchor [<dir>] [--dry-run]`
Retro-anchor **existing** observations that reference a real file/symbol in prose but were
saved without an explicit `--anchors`. Extracts only EXPLICIT references (a backticked path
matching a node's `sourceFile`, or a symbol resolved with a functional-exact match against the
live graph; `` `path:symbol` `` resolves the symbol within that file only) — ambiguous (2+
matches) or unresolved candidates are discarded, never guessed. Identifiers shorter than 3
characters and generic words (`get`, `query`, `foo`, `npm`…) are not candidates; a bare name
that matches production code and tests anchors the production node, and one that matches only
test code is rejected (qualify it as `` `test/x.test.ts:helper` ``).
Minting is **additive** (unions with any anchors the observation already has) and
**idempotent** per `(observation_id, node_id)`: re-running never duplicates a row.

It also **upgrades whole-file anchors** (every anchor saved before 3.0) to symbol fingerprints
without moving their baseline: the symbol is fingerprinted in the file version the anchor was
saved against — the working tree when unchanged, else the commit found in that file's git
history (any ref, last 300 commits). Anchors whose version is not found, and module/config
anchors, stay file-level.
`--dry-run` reports what would be minted/rejected/upgraded without writing. Prints a summary
(`{processed, minted, rejected, upgraded}`) plus a per-observation breakdown.

### `memory compact [<dir>] [--keep N] [--sessions-older-than DAYS] [--keep-sessions N] [--dry-run]`
Garbage-collect this project's **superseded snapshots** — the prior revisions every
`--topic` upsert keeps — then `VACUUM` so the freed pages go back to the OS. The live row of
every topic (and every non-topic observation) is always kept; anchors of deleted snapshots
are removed in the same transaction. `--keep N` retains the N newest snapshots per topic
(default 0). Sessions are untouched unless `--sessions-older-than DAYS` purges the ones idle
for longer than that; even then the project's `--keep-sessions N` newest sessions (default 5;
`0` lets the age cutoff alone decide) always survive, so a project left idle for months keeps
its last summaries to resume from. `--dry-run` reports the counts without writing. Only the current
project is compacted; re-running is idempotent. Prints the removal counts and the db size
before/after — or, when another leina process holds the db open, that the space is
reclaimed once it closes. If the memory db is locked the command exits 1 with a one-line
message (safe to re-run); if `VACUUM` cannot run, the removals are already committed, so it
prints the counts plus a warning and exits 1.

### `memory export [<dir>] [--out file.jsonl]`
Dump this project's observations + anchors as JSONL (to `--out` or stdout).

### `memory import [<dir>] [--in file.jsonl]`
Merge an export from stdin (or `--in file.jsonl`); newer revision wins. The file is untrusted
input (it can ship with a cloned repo), so every line is validated first — known scope and
type values, positive integer revision, `supersededBy` shape, anchor shape, title ≤ 1000 and
content ≤ 256 KiB characters — and any invalid line fails the whole import, naming the line.
Imported timestamps are clamped to the import time. An id that belongs to **another
project** is never touched: it is skipped and reported (`N skipped (id belongs to another
project)`). Superseded snapshots the store has already moved past (or compacted away) are
not re-imported.

### `memory sync [<dir>]`
Two-way merge with a committable `.leina/memory-export.jsonl` snapshot, with the same
validation and skip rules as `import`.

---

## Audit, findings & artifacts

`leina audit [<sub>] [dir] [flags]` runs source→sink candidate-path analysis over the
(possibly merged) graph. Output is **evidence for triage** — candidate data-flow routes, never
confirmed vulnerabilities (a disclaimer banner is always printed). The audit pack carries
`schemaVersion` and a `findings[]` array.

### `audit [<dir>] [--format md|json|html] [--json] [--from <id,...>] [--max-pack-kb <N>]`
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

### `audit catalog|reachability|pack|visualize [<dir>] [flags]`
Multi-repo / workspace audit subcommands: `catalog` (repos/nodes/edges grouped by repo),
`reachability --from <id,...> [--backward]` (reachable set from entry points), `pack` (full
report = catalog + reachability), `visualize` (offline HTML audit subgraph). Run
`leina workspace build` first for a fresh workspace-level graph.

---

## Events (local outbox)

An append-only local **event outbox** records domain events (`schemaVersion: 1`). It is
**off by default** — stdout/UX are unchanged unless you opt in.

### `events tail [<dir>] [--json]`
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
`~/.leina/.env` (0600, plain text). Every write replaces the file atomically (a 0600 temp
file renamed over it), so a crash or a full disk never truncates the store and a new value
is never written into a file that had loosened permissions. `env list` warns if the file's
permissions are group/other-readable. Keys match by name even on hand-edited lines
(`KEY =value`); a repeated key resolves to its last value, and `set` collapses duplicates.

### `env set <KEY>`
Store a value. Interactive: hidden TTY prompt (input not echoed). Non-interactive: first line
of piped stdin (`echo "$V" | leina env set KEY`). Never via argv — argv lands in shell
history and agent transcripts. Key names must match `[A-Za-z_][A-Za-z0-9_]*`.

### `env list`
Print stored variable names with **masked** values.

### `env get <KEY> [--reveal]`
Masked by default. `--reveal` prints the plain value **only when stdout is a TTY** — piping
or redirecting fails with a pointer to `env exec`. Honest limit: a TTY is not proof of a
human — an agent runner that allocates a pseudo-terminal passes the check, so agents must
never run `--reveal` (see the `authenticated-api` skill's residual-risks section).

### `env unset <KEY>`
Remove the variable (every line that defines it).

### `env exec [--only K1,K2] -- <cmd...>`
Run `<cmd>` with the stored variables injected into its environment (all of them, or only the
`--only` subset). The secret travels **process-to-process**: with single quotes, the *child*
shell expands the var and the parent (and the model) never sees the value:

```bash
leina env exec --only MY_TOKEN -- sh -c 'curl -H "Authorization: Bearer $MY_TOKEN" https://api...'
```

Exits with the child's exit code. The contract ends at the child's **output**: the child
inherits the terminal, so anything it prints (`curl -v` tracing the `Authorization` header,
a crash dumping its environment, a plain `env`) reaches the transcript — keep child output
minimal (`curl -sf`).

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
- `sidecar verify <java|csharp>` — run the configured sidecar (built, installed, or set through
  `LEINA_<LANG>_SIDECAR`) over a minimal fixture shipped with leina (`assets/fixtures/<lang>`),
  so it works from an npm install, and report `ok` with node/edge counts. An empty graph is a
  `FAIL` (exit `1`). **Honest skip**: with no sidecar it prints `<lang>: skip — …` naming
  `leina sidecar build <lang>` (toolchain present) or `leina sidecar install <lang>` (toolchain
  missing) and exits `0`. A prebuilt sidecar is verified even without dotnet/JDK on `PATH`.

All extractors (ts-morph, the two sidecars, tree-sitter, and the YAML-infra extractor) implement
a common extractor contract and each extraction returns a versioned result
(`schemaVersion: 1`, with diagnostics, duration, and errors).

The YAML-infra extractor (docker-compose services, CI jobs, generic config files) parses with
tree-sitter, using the maintained `tree-sitter-yaml` grammar bundled under `assets/wasm/`. A file
tree-sitter cannot parse cleanly — templated YAML such as Helm charts, syntax errors — falls back
to a tolerant line-based reader, file by file. (Before 3.0.0 the bundled grammar could not be
loaded by the tree-sitter runtime, so every YAML file silently took the line-based path.)

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
- `scip verify [go|rust|python]` — verify the extractor against a minimal fixture shipped with
  leina (`assets/fixtures/scip/<lang>`, so it works from an npm install). **Honest skip**: if the
  indexer isn't found it prints `<lang>: skip — …` and exits `0` (never a spurious failure);
  with the indexer present it runs a real index + parse and reports `ok`/`fail` plus node/edge
  counts.

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

## Harness commands (rules + executable gates)

The harness turns "agent best practices" into machine-checkable **gates**. It lives in
`<dir>/.harness/`: markdown **rules** (JSON frontmatter) anchored to a lifecycle phase
(`intake → plan → execute → verify → deliver`) with severity `blocking` | `advisory`,
optionally carrying an executable **gate** (`command`, `file`, `diff`, `diff-content`,
`checklist`, `js`). Rules resolve across three layers — builtin < `.harness/rules/`
(project) < `~/.leina/harness/rules/` (user) — and a local layer can **never weaken** a
blocking project rule. See [concepts/07-harness.md](concepts/07-harness.md) for the model.

All subcommands run against the repo root found upward from cwd (`.harness/` or `.git`).
Usage errors — a flag without its value, an unknown sub-command — exit 2. Everything that
runs unattended (the hooks, MCP `harness_verify`) and the `js`/`command` gates of
project-layer rules only run in a workspace **trusted** on this machine by `leina init`
(see [workspace trust](concepts/07-harness.md#workspace-trust--what-may-run-unattended)).

### `harness contract new --goal "<t>" [--type <t>] [--scope <glob>]... [--out-of-scope <glob>]... [--criterion <text>]... [--max-retries <n>]`
Declare the task contract **before** starting a non-trivial task: goal, allowed scope
globs, explicit out-of-scope globs, acceptance criteria, and the retry budget for the
stop-hook loop — `--max-retries`, the blocks one stop chain may take before the stop gate
yields: an integer 1–10, default 3 (anything else is rejected, as in MCP
`harness_contract_new`). Records the current git HEAD as `baseRef` — the diff gates
compare against it. Writes `.harness/state/current/contract.json` + `checklist.md`.
Refuses to overwrite an active contract. Exit 2 on invalid usage.

### `harness contract show`
Print the active contract. Exit 1 when none is active.

### `harness contract edit [--goal <t>] [--add-scope <g>]... [--add-out-of-scope <g>]... [--add-criterion <t>]... [--check-criterion <t>]...`
Amend the active contract. Scope widening is **explicit, never silent** — the diff gate
fails until the new paths are declared here. `--check-criterion` marks a criterion done.

### `harness contract end`
Archive `state/current/` to `state/history/<timestamp>/` and close the contract.

### `harness verify [--json] [--phase p1,p2] [--rule <id>]`
Run the gates (default phases: `verify,deliver`). **The exit code is the completion
contract**: `0` = every blocking gate passed, `1` = blocking failure, `2` = engine/config
error or usage error (an unknown `--rule` id; MCP reports it as `isError`). A `--rule`
that exists but does not apply to the run is a warning. Gates honor `onlyIfChanged` (skip
when nothing relevant changed) and run in a bounded parallel pool. Changed files come from
`git diff --relative`, so they are relative to the harness root (a monorepo package
harness ignores changes outside its package). Outside a git repository verify warns and
**fails closed**: `onlyIfChanged` gates run, path/language scoping is skipped, and blocking
`diff-content` gates (and `diff` gates with a scope to check) report an error — a non-git
directory must disable `harness/no-secrets`. Only a **full** run (no `--rule`, phases
including `verify` and `deliver`) writes `.harness/state/current/verify-report.json`,
with the `worktree` fingerprint the commit guard checks; a filtered run prints a stderr
note and is not recorded. `--json` prints the report to stdout, `loadErrors` included.

### `harness sync [--check] [--force] [--platforms a,b]`  *(alias: `compile`)*
Regenerate platform artifacts from the canonical rules: managed blocks in
`AGENTS.md`/`CLAUDE.md`, Claude Code skills, Cursor `.mdc` rules + hooks, Windsurf/Devin
rule mirrors, an OpenCode plugin. Detection is **evidence-based** (a platform is targeted
only when `config.platforms` names it, `--platforms` selects it, or the repo already
carries its files — leina never elects a host for you). `--platforms a,b` regenerates
only the named platforms (`agentsmd`, `claude-code`, `cursor`, `windsurf`, `opencode`)
and leaves the others' artifacts alone; an unknown id exits 2 listing the valid ones. Only
the committed layers are compiled (builtin + project rules, `.harness/config.json`): user
rules/config and `config.local.json` apply to verify and the hooks, never to synced files.
A lockfile (`.harness/harness.lock.json`) hashes every artifact: hand-edited files
**conflict** instead of being clobbered (`--force` overrides). Its paths must be
repo-relative — an absolute, `..`, NUL or `.git` path invalidates the whole lockfile, and a
path resolving outside the repo through a symlink is refused, never followed. `--check`
computes drift without writing — exit 1 on drift (CI mode). Orphans (a rule or platform
removed) are deleted or stripped and reported as `removed` — orphaned harness entries in
shared JSON (Cursor hooks, OpenCode instructions) included. A hand-edited **orphaned**
artifact keeps conflicting on every run, including `--check`, until a human resolves it:
delete the file/markers to keep the edits, or `--force` to discard them.

### `harness list [--phase <p>] [--tag <t>] [--json]`
Resolved rules with source layer, phase, severity, gate types and enabled state.

### `harness hook <event>`
Platform hook entry point (reads the event JSON on stdin): `session-start` (context
injection), `pre-edit` / `pre-bash` (hard blocks, exit 2), `stop` (completion gate: every
stop judges the current tree — the last full verify when HEAD, the working tree, rules,
config, contract and trust are unchanged since, a fresh verify otherwise — blocking up to
`maxRetries` times per stop chain, then it **yields honestly**), `cursor-shell` / `cursor-after-edit` / `cursor-stop` (Cursor
protocol), `idle`. In a workspace not trusted on this machine it is a silent no-op
(`cursor-shell` answers `allow`). An unreadable config makes `pre-edit` and the commit/push
guard fail closed. Wired by `harness sync` for Cursor and OpenCode — including the sync
`leina init` runs, when the repo already targets them; Claude Code and Devin/Windsurf get
no such wiring, their enforcement rides the `agent-hook` gate. You rarely run it by hand.

---

## MCP server & tools (dual transport)

Every read/write capability is exposed twice: as the CLI commands above **and** as MCP
tools served by `leina mcp` (stdio). Both transports call the same use cases through the
capability registry, so they cannot diverge. Agents should prefer the MCP tools when the
host exposes them (structured JSON, no shell round-trip); every tool takes an optional
`root` — the `<dir>` argument of the CLI form (default: the cwd the host launched the
server in, i.e. the workspace root).

**Root confinement.** `root` comes from the model, so under prompt injection it is
attacker-controlled. Every tool's `root` must resolve **inside the server cwd** — after
resolving symlinks (`realpath`), so a link inside the workspace that points elsewhere does
not escape; a root that cannot be resolved safely (dangling link, loop, no access) is
rejected. To allow other roots on purpose, launch the server with
`LEINA_MCP_ALLOW_ROOTS=/abs/path[:/abs/path...]` (`:`/`;` per platform, or `,` separated);
listed paths and their subdirectories are accepted, resolved the same way. The tools return
the resolved real path.

**Numeric arguments** are integers, truncated and clamped to fixed bounds (`depth` 1–20,
`maxNodes` 1–200, `limit` 1–100, `sessionLimit` 1–50); a non-numeric value falls back to
the tool's default.

**Graph read payloads** (`graph_query`, `graph_affected`, `graph_path`, `impact_analyze`) are
compact, unindented JSON. Every node is `{id, label, kind, at}` — `label` qualified with its
class for members (`Store.search()`), `at` the `file:line` of its definition, `id` a selector
the next call accepts; `repo` is added in workspace mode. Every edge is
`{source, target, relation, at}` in its real direction, `at` being where it happens (the call
site); `confidence` appears only when it is not `EXTRACTED`, `context` only when set.
Signatures, community ids, `fileType` and `weight` are left out — `leina build --json` still
exports the full graph.

The **memory tools** (`memory_*`) answer in compact, unindented JSON too (same fields as
before 3.0, about 10% fewer characters on a `memory_context` or `memory_search` answer).

| CLI | MCP tool | Notes |
|---|---|---|
| `query` | `graph_query` | builds the graph on first use; `includeTests` mirrors `--include-tests`; `maxNodes` defaults to 25; returns `{seeds: [id], nodes, edges, testsExcluded}` (seeds lead `nodes`; no `contains`/`method` edges) |
| `affected` | `graph_affected` | `symbol` takes the CLI selectors; returns `{seed, dependents}`, each dependent `{id, label, kind, at, depth, relation, target, via?}` with `at` = the call site and `target` = the node it depends on; ambiguous → best match + `note` + `alternatives`; no exact match → `seed: null` + `note` + `suggestions` |
| `path` | `graph_path` | `from`/`to` resolved like `graph_affected`; returns `{path: {nodes, edges}}` (`edges[i]` joins `nodes[i]` and `nodes[i+1]`, real direction) or `path: null`; `endpoints` (per-endpoint `note`/`alternatives`/`suggestions`) only when an endpoint is ambiguous or unresolved |
| `stats` | `graph_stats` | |
| `status` | `graph_status` | |
| `build` / `refresh` | `graph_build` | concurrent calls for the same root share one build; reads wait for it |
| `impact analyze` | `impact_analyze` | resolves `symbol` like the CLI; honours `depth`; returns `{seed, impacted, note?, alternatives?, suggestions?}` with `seed` a compact node (`seed: null` + `suggestions` when nothing matches exactly) |
| `visualize` | `graph_visualize` | returns the PATH of the generated HTML; `out` is resolved against `root`, confined like `root`, and must end in `.html` |
| `audit` | `audit_run` | |
| `doctor` | `doctor_run` | consent-exempt (diagnosis always allowed) |
| `memory save` | `memory_add` | batch: `items[]` + `atomic` |
| `memory search` | `memory_search` | |
| `memory verified` | `memory_verified` | honours `type` |
| `memory context` | `memory_context` | same ranked selection as the CLI (default `limit` 20); previews by default (budget-safe; `contentChars` counts code points) with `shortId`, `status` and `activeTotal`; `sessionLimit`, `full:true` (whole bodies, same order) |
| `memory get` | `memory_get` | batch: `ids[]`; ids of other projects read as not found |
| `memory update` / `resolve` / `reopen` | `memory_update` | current project's ids only; `status` (`active`/`resolved`/`obsolete`) + `resolution` |
| `memory suggest-topic` | `memory_suggest_topic` | |
| `memory session` | `memory_session` | |
| `agent-hook SessionStart` | `context_build` | |
| `harness contract new` | `harness_contract_new` | |
| `harness contract show` | `harness_contract_show` | |
| `harness contract end` | `harness_contract_end` | |
| `harness verify` | `harness_verify` | full report + exit-code contract; returns `{skipped: true, reason}` in a workspace not trusted on this machine (see `init`) |
| `harness list` | `harness_rules_list` | |

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
| **Repo** (granular) | `init` | `deinit` | one repo: consent flag + workspace trust record (+ `AGENTS.md`/`.devin/*` when standalone) |
| **Repo** | `build` | — | one repo: `graph.db` (on-demand) |

**Blanket + tri-state consent.** `setup` turns on a machine-wide **blanket sentinel**
(`~/.leina/.blanket`). Independently, each repo carries a **local, git-ignored consent flag**
(`.leina/consent`) with three states:

- `unknown` (no flag) — the agent gate stays **silent** (no injection, no advisories); the
  `leina-setup` skill prompts the user once ("leina available — use this workspace?").
- `enabled` — leina acts (once the workspace is also trusted, see below): gate injects
  memory + graph stats, advisories fire, and (under blanket) the graph self-heals on
  `SessionStart`. Written by `init`.
- `disabled` — permanent silent no-op. Written by `deinit`.

A repo that has only a `.devin/hooks.v1.json` but no consent flag resolves to `unknown`, so it
is re-prompted once rather than silently silenced.

**Workspace trust.** The consent flag lives in the repo, so a clone could ship it `enabled`.
What actually lets anything run — the agent gate's injection, advisories and self-heal, the
harness hooks and their enforcement, MCP `harness_verify`, project-layer `js`/`command`
gates — is an **out-of-repo** record, `$LEINA_HOME/trust/<sha256 of the repo root's
realpath>`. `init` (FULL and LIGHT) writes it once consent is `enabled`, `deinit` removes
it, `repair` never grants it. A workspace is trusted when the record exists and consent is
not `disabled`; anywhere else the automated paths are silent no-ops (never errors) and
project-layer executable gates are skipped with a visible result. A committed
`.leina/consent` grants nothing, and a moved or re-cloned repo must be initialized again on
that machine. `leina doctor` reports it as **workspace trust**.

### `setup --hosts devin,claude [--no-user-hooks] [--preset minimal|sdd|full] [--skills a,b|all|none] [--agents a,b|all|none] [--mcp --mcp-hosts <...>]`
The one-shot "magic" command (once per machine). Composes `activate` (share + symlinks +
user-global `Exec` grant + hooks) **and** turns the blanket sentinel ON. Idempotent. After `setup`,
leina is available in every session and each repo is governed by its consent flag.
`--no-user-hooks` leaves the user-global hooks out (and strips ours). Add `--mcp --mcp-hosts <...>`
to register the MCP server during install. The asset-selection flags work as in `activate`.

### `disable`
Inverse of `setup` (once per machine). Turns the blanket sentinel OFF and runs the global
teardown (unlinks hosts, revokes the CLI `Exec` grant, removes the user-global hooks from the
Devin config and `~/.claude/settings.json`). Strip-inverse only — removes leina's managed entries while preserving any third-party
symlinks/grants/hooks. Idempotent (a second `disable` exits 0).

### `init [<dir>] [--hosts devin,claude] [--profile devin|windsurf] [--freshness auto|refuse] [--build] [--name <project-name>] [--mcp] [--claude-hooks] [--harness] [--harness-preset generic|leina-native]`
Per-repo opt-in — **adaptive** on whether blanket is active. Always writes the consent flag
`enabled`, ensures the `.gitignore` block, and records **workspace trust** for this machine
(a `workspace trust (<record path>)` line in the report). Then:

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
The task harness is **opt-in**: `--harness` seeds `.harness/config.json` and runs the harness
sync; without it `init` leaves `.harness/` alone, except in a repo that already carries
`.harness/config.json`, which every `init` keeps synced.
`--harness-preset` (implies `--harness`) chooses the seed for a **new** `.harness/config.json`: `generic` disables the
four leina-coupled builtin rules (`leina-*`) so the harness works without adopting the rest of
leina; `leina-native` (the default) keeps the full builtin suite. An existing
`.harness/config.json` is never overwritten — the flag is then ignored with a note. See
[concepts/07-harness.md](concepts/07-harness.md#rule-presets--generic-vs-leina-native).
With the harness on, `init` then runs the harness sync. With `--hosts` (FULL) in a repo whose config has no
`platforms`, it pins `platforms` to those hosts' platforms plus whatever the lockfile and
auto-detection already govern, so previously synced or detected platforms are kept.

Example (standalone full init):

```bash
leina init <dir> --hosts claude --profile devin
```

### `deinit [<dir> | --project <dir>]`
Inverse of `init` (per repo; defaults to the current directory). Writes the consent flag
`disabled`, removes this machine's workspace trust record, and strip-inverse removes the
repo's managed artifacts: the `AGENTS.md` protocol block, the `.gitignore` block, the local
`Exec` grant, and `.devin/hooks.v1.json`. User content outside the managed markers is preserved.
Harness artifacts go through the lockfile (owned files and blocks only while untouched;
harness entries stripped from shared JSON — a file without any stays byte-identical, an
edited one keeps its formatting — and every rewrite is atomic). The `.harness/config.json`
`init` wrote is removed only while unchanged (provenance sha256 in
`.leina/harness-config.sha256`) or `{}`, and an emptied `.harness/` is pruned. Idempotent —
when there is nothing to revert (e.g. a second `deinit`) it exits 0 with a "nothing to
revert" note.

### `activate --hosts devin,claude [--no-user-hooks] [--preset minimal|sdd|full] [--skills a,b|all|none] [--agents a,b|all|none] [--mcp --mcp-hosts <...>]`
The global half of `setup` (once per machine), without flipping the blanket sentinel. Populate
`~/.leina/share/{skills,agents,workflows}` from bundled assets and symlink each entry into the
hosts' global dirs (`~/.config/devin/{skills,agents}`, `~/.claude/{skills,agents}`), and write
the user-global config: the `Exec(leina)` grant in `~/.config/devin/config.json`, plus the
managed hooks of each **selected** host — Devin's in that same file, Claude Code's
(`agent-hook <Event> --host claude --scope user`) in `~/.claude/settings.json`. Both merges are
idempotent and keep every other key; the first content-changing write to an existing file
leaves a `<file>.bak-<ISO>` copy. A host that is not selected — or every host, with
`--no-user-hooks` — gets leina's managed hooks stripped instead. These hooks fire in every
project but stay silent without consent + workspace trust, and defer to a project's own
wiring. Add `--mcp --mcp-hosts <...>` to register the MCP server too.

**Asset selection.** `--preset` picks a group bundle from `assets/catalog.json` (`minimal` =
core, `sdd` = core + SDD, `full` = everything); `--skills` / `--agents` take a comma-separated
list of asset names, `all` or `none`. Required assets and dependencies are auto-included (noted
on stderr), and an unknown name is a hard error. Omit all three to keep the previously
persisted selection; `--hosts` alone changes *where* assets are linked without changing *which*.

### `deactivate`
Inverse of `activate` (once per machine). Runs the global teardown (unlinks hosts, revokes the
CLI `Exec` grant, removes the user-global hooks from the Devin config and
`~/.claude/settings.json`) but **leaves the blanket sentinel untouched**
(that is `disable`'s concern). Strip-inverse, idempotent.

### `version` (aliases: `--version`, `-v`)
Print the installed package version and exit. No project or DB access.

### `help [<command>]` (aliases: `--help`, `-h`)
Print the root help, or one command's help (`leina help memory search` is the same as
`leina memory search --help`). An unknown command is a usage error (exit `2`), not the root
help.

### `doctor [<dir>] [--json]`
Diagnose install + project health. Each check reports at one of four severities — **ok** /
**info** / **warn** / **fail** — colourised, with optional or not-applicable items grouped in a
trailing **info** section, and a final summary line. With `--json` emits the full `DoctorReport`,
including the `repoIdentity` aggregate (`{projectKey, strategy, confidence: "high"|"medium"|"low",
pathHash, rootCommit?, normalizedRemote?}`). `pathHash` is a cross-OS-deterministic SHA-256 of the
normalised absolute path; `normalizedRemote` is the `host/org/repo` canonical form. `doctor`
exits `1` when any check is `fail` (warn-only exits `0`), like `verify`. The project group includes a **workspace trust**
check: ok when trusted on this machine; warn when consent is `enabled` but there is no trust
record (hint: re-run `leina init <root>`); info when consent is `disabled` or the repo was
never initialized. The **hooks** group checks every managed entry in the four hook files
(`.devin/hooks.v1.json`, `.claude/settings.json`, `~/.config/devin/config.json`,
`~/.claude/settings.json`): warn when an entry launches a missing CLI or another leina install
than the one running doctor ("hooks run another leina install (X, running Y) — run leina
activate / leina repair"), or when a pre-3.0 Devin `refresh` entry remains; and, per selected
host, warn when consent is enabled but no hooks are wired anywhere that host loads them.
**injection readiness** is ok only with consent enabled, a trusted workspace and hooks wired
for at least one host (plus memory.db, a resolvable key and graph.db). A committable
`.leina/config.json` / `.leina/memory-export.jsonl` that exists but is git-ignored warns,
naming the rule.

### `verify [<dir>] [--json]`
Re-run the same checks as `doctor` but with an **actionable exit code** — exit `1` if any check
is `fail`, `0` otherwise (warn-only still exits 0). With `--json` returns the `DoctorReport`
(carrying the same `repoIdentity`) plus an `exitCode` field, for CI gating.

### `repair [<dir>] [--no-user-hooks]`
The **write-side counterpart of `doctor`**: re-runs the idempotent install writers for
whatever doctor finds broken, scoped strictly by **evidence of a previous install** — it
never installs something the user never asked for:

- **Global** (share + symlinks + user-global grant/hooks): only when activation evidence
  exists (share populated or blanket sentinel on). Never a first-time install.
- **Project** (`AGENTS.md` / `.gitignore` / `.devin/*` wiring / consent): only when init
  evidence exists (consent flag, managed hooks file, or `AGENTS.md` protocol block) **and**
  consent is not `disabled` — a `deinit` opt-out is always respected. The original profile
  (Devin/Windsurf) is preserved. Hook files the repo already carries are rewritten for this
  install even outside the host selection, and the `.gitignore` writer turns a bare `.leina/`
  line (which hides the committable `.leina` files) into `**/.leina/*` — same reach, nested
  `.leina/` dirs stay ignored — or an anchored `/.leina/` into `/.leina/*`.

Never touches `graph.db` / `memory.db`, and deliberately never grants workspace trust (only
an explicit `init` does). Ends by re-running doctor; remaining failures drive a non-zero exit.

### `tui [<dir>]`
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

### `agent-hook <Event> [--host claude|devin] [--scope user]` (alias: `devin-hook`)
Host-neutral agent hook gate; reads the payload JSON on stdin (`devin-hook` is a compatibility
alias — pre-3.0 `.devin/hooks.v1.json` installs invoke it). The installers write `--host` on
every entry (it selects the host's output protocol) and `--scope user` on the user-global copy;
an entry without `--host` is treated as Claude Code when `CLAUDE_PROJECT_DIR` is set and as
Devin otherwise. One answer per event: when a higher-priority copy of the wiring the running host
also loads wires the same event — the project's own files over the user-global ones, and under
Devin (which also loads Claude Code's files) Devin's own over Claude Code's — the lower copy
exits 0 silently. Events: `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `SessionStart`, `PostCompaction`, `Stop`. The advisory gate never blocks; it
answers in the host's documented channel — for Claude Code every advisory is
`hookSpecificOutput.additionalContext` JSON on stdout (Claude Code never shows a hook's stderr
on exit 0), Devin gets additionalContext on `PostToolUse` and stderr elsewhere. The `Stop` save
nudge fires at most once per session and never when the payload says `stop_hook_active: true`.
**Scope-aware**: the gate is a silent no-op unless the repo's consent flag is `enabled` **and**
the workspace is trusted on this machine (see *Workspace trust* above), so a user-global hook
stays quiet in repos that haven't opted in (`unknown`/`disabled`) or that only carry a
committed consent flag.

**Harness enforcement branch**: in a trusted workspace the same entry point relays the
harness decisions (see [concepts/07-harness.md](concepts/07-harness.md)). Writes to the
harness rules/config/lockfile, `$LEINA_HOME/harness/` or `$LEINA_HOME/trust/` are always
refused (`PreToolUse` exit 2); with an active contract, strictness `strict`, or an
unreadable config, out-of-scope edits and `git commit`/`git push` over a failing verify
(in strict mode: any edit without a contract, any commit without a fresh report) are
refused too, `Stop` may return `{"decision":"block"}`, and `SessionStart` also injects the
contract status and intake rules. A `UserPromptSubmit` opens a new stop chain.

**Auto-build self-heal (SessionStart)**: on every `SessionStart` **for a consented (`enabled`),
trusted repo**, if `graph.db` is absent or the manifest is stale, a detached `leina build` is
spawned in the background before context injection runs. It never fires in `unknown`/`disabled`
or untrusted repos, so leina never builds a graph in a workspace you haven't opted into on this
machine. A freshness nudge remains the fallback for the current session; the background build
materialises a fresh graph for the next session. This is advisory/fail-open — any spawn error is
silently swallowed and context injection proceeds normally. Suppress with
`LEINA_DISABLE_AUTOBUILD=1`.

**Lock file**: both `init` and `SessionStart` auto-build coordinate via
`.leina/graph.build.lock` (JSON `{ pid, startedAt }`), written with `O_EXCL` to serialise
concurrent triggers. A stale lock (dead PID, or `startedAt` older than 15 min) is automatically
reclaimed.
