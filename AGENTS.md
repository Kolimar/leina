# AGENTS.md — leina project conventions

This file documents conventions and tooling for AI agents working on the leina
codebase itself. **leina exposes a command-line interface.** Its supported install
targets are your AI host(s) — Devin and Claude Code (`--hosts devin,claude`); the
Windsurf editor uses the same `.devin/` on-disk shape as Devin.

---

## Memory (CLI)

Memory lives in the global DB `~/.leina/memory.db` (honoring `$LEINA_HOME`), keyed by a
stable project key, and is accessed through the `leina memory <sub>` CLI. Anchors resolve against the
live graph on save, and `memory verified` re-checks them (drift detection).

### Memory subcommands

| Command | Purpose |
|------|---------|
| `memory save <dir> --title --content [--type] [--topic] [--anchors]` | Save/upsert an observation |
| `memory update <dir> <id> [--title] [--content] [--type]` | Update an observation in place |
| `memory search <dir> "<query>"` | Full-text search |
| `memory verified <dir> "<query>"` | Search + drift classification (USABLE/WARNING/DO-NOT-USE) |
| `memory get <dir> <id>` | Full observation content by id |
| `memory context <dir>` | Recent sessions + latest observations |
| `memory session <dir> --content` | Save a session summary |
| `memory session-start <dir>` | Open a new session, print its id |
| `memory suggest-topic <dir> --title` | Suggest a normalized topic_key |

`save`, `update` and `get` also accept `--batch` (JSON array on stdin; `--atomic` for save/update).

**Always-on injection**: the `SessionStart` hook automatically injects the top-10 memory
observations + graph stats into the agent's context — no manual `memory context` call needed
at session start. `PostCompaction` re-injects the same context after compaction events.
`Stop` emits a one-time stderr advisory to run `leina memory session <dir>` if no save
was detected this session (advisory only — never blocks, stdout always empty).

**Run `leina memory context <dir>`** for mid-session supplementary reloads or targeted
searches. **Run `leina memory save` proactively** after architectural decisions, bug
fixes and non-obvious discoveries — do not wait to be asked.

---

## Graph commands

Use the graph CLI before grepping or re-deriving structural context:

- `leina query <dir> "<question>"` — term-scored subgraph (auto-rebuilds if stale)
- `leina affected <dir> <symbol>` — blast radius (call before rename/migrate)
- `leina path <dir> <a> <b>` — shortest path between two symbols
- `leina visualize <dir> [--out <path>] [--drilldown]` — export offline HTML graph viewer (folder colours, degree sizing, god nodes; click a node for a detail drawer). Workspace-aware: on a workspace root it builds/merges (does NOT clobber the merged graph) and renders the two-level constellation by default (`--drilldown` for the merged graph coloured by repo)
- `leina status <dir>` — check if the graph is stale (no rebuild)
- `leina refresh <dir>` — force a rebuild

`query`/`affected`/`path` route through the freshness gate (`openFreshStore` in `src/cli/wiring.ts`,
using `isStale` from `src/application/graph/manifest.ts`):
stale + posture `auto` rebuilds before answering; `refuse` instructs you to run `refresh`.

---

## Workspace & Audit commands (multi-repo)

These commands are available when working with a workspace root (directory containing
multiple child repos with `.git`). A `workspace.json` file at the root forces workspace mode;
without it, `≥2` child repos with `.git` are auto-detected.

### Workspace commands

| Command | Purpose |
|---------|---------|
| `leina workspace build [dir]` | Build/reuse each member repo and merge into a single graph |
| `leina workspace status [dir]` | Show mode + per-member fresh/stale status |
| `leina workspace detect [dir]` | Print the detected workspace structure as JSON |
| `leina workspace visualize [dir] [--out <path>] [--drilldown]` | Render the merged workspace graph (constellation by default; `--drilldown` for repo-coloured merged graph). Never clobbers the merged graph.db |

Options:
- `--json` (build) — also export the merged graph as JSON
- `--single` / `--workspace` — override detection (single-repo or workspace mode)

### Audit commands

| Command | Purpose |
|---------|---------|
| `leina audit catalog [dir] [--json]` | Show repos/nodes/edges grouped by repo |
| `leina audit reachability [dir] --from <id,...> [--backward] [--json]` | Compute reachable nodes from entry points |
| `leina audit pack [dir] [--from <id,...>] [--json]` | Full audit report (catalog + reachability) |
| `leina audit visualize [dir] [--from <id,...>] [--out <path>] [--max-pack-kb <N>]` | Render the audit subgraph as an offline HTML viewer: source→sink candidate paths, nodes coloured by role (source/sink/synthetic/waypoint), edges by confidence, clickable path list. Writes `audit-graph.html` |

`audit` commands read from the current (possibly merged) graph.db. Run
`leina workspace build` first for a fresh workspace-level graph.

---

## Development conventions

- All install writers must be **pure functions** (`FileArtifact {path, content}` — defined in
  `src/domain/install/artifact.ts`); no file I/O inside the writer; the CLI does all I/O.
- Writers must be **idempotent**: re-running on already-processed output returns identical output.
- Tests use `node:test` (no external test framework). Run: `npm test`.
- TypeScript strict mode — `npx tsc --noEmit` must be clean before committing.
- Conventional commits (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`).
- Layering (hexagonal; enforced by `test/architecture.test.ts` + eslint): domain imports
  nothing outward; application never touches `node:sqlite`/`node:child_process` directly;
  infrastructure never imports `cli/`. **Known deliberate exception:** the install vertical —
  `infrastructure/install/global.ts` calls the pure application writers (catalog, port,
  devin-skills) to populate the share, and `application/activate.ts` orchestrates the
  infrastructure installers. Keep that coupling inside `*/install/`; do not extend it to
  other verticals.

### Local global install (dev): `npm link`, not a copy

The `bin` (`leina`) points at `./dist/cli/index.js`, so the global CLI runs **built**
output, never `src/`. For local development install via **`npm link`** from the repo root so
the global binary symlinks to this working tree (`npm i -g .` installs a frozen copy that
silently drifts — the version string does NOT bump per commit, so `--version` can falsely
match while the code is dozens of commits behind).

- After editing anything under `src/`, run `npm run build` (`tsc -p tsconfig.build.json`)
  so `dist/` — and therefore the linked global binary — picks up the change. The link does
  NOT recompile on its own.
- `dist/cli/index.js` is intentionally tiny (~2.5 KB): it is the thin entry that lazy-imports
  the heavy extractor stack. A small size is expected, not a broken build.
- Verify the link resolves to the repo: `readlink -f "$(which leina)"` should land in
  this repo's `dist/cli/index.js`, and `npm ls -g --depth=0 | grep leina` should show a
  single `-> .../leina` arrow (no stray copies or old `leina`
  links from sibling repos).

## Global install surface

> The global install mechanics below (share versioning, symlinks, permission grants) are
> what `leina activate` runs today. (`install-global`, an older alias, was removed in 2.0.0.)

`leina activate` populates a single source of truth under
`~/.leina/share/{skills,agents,workflows}` and symlinks each entry into each selected
host's global dir:

- Devin: `~/.config/devin/skills/<name>/` and `~/.config/devin/agents/<name>/`
- Claude Code: `~/.claude/skills/<name>/` and `~/.claude/agents/<name>.md`

The share is versioned via `share/.version`: when the running package version differs from
the sentinel, the share is rebuilt from bundled `assets/`. macOS/Linux use symlinks; Windows
falls back to a recursive copy with a stderr notice (`linkOrCopy` in `src/infrastructure/install/symlinks.ts`).

`leina init` invokes `activate` implicitly. It also cleans up any leftover legacy
config (see `src/application/install/migrate.ts`): a stale `leina` entry in
`.devin/config.json` is stripped, dead hook matchers are removed, and the legacy global
registry (`~/.leina/projects.json`) is moved aside.

It also pre-authorizes the CLI so the agent never gets a permission prompt for `leina ...`:
`grantCliExecPermission` (`src/application/install/permissions.ts`) adds `Exec(leina)` to
`permissions.allow` (merge-safe + idempotent — the additive inverse of
`migrate.ts#stripMcpPermissions`). It is written in **two** places:

- **Project-scoped** `.devin/config.json` (committable) — the grant travels with the repo, so
  anyone who clones it gets a zero-prompt CLI.
- **User-global** `~/.config/devin/config.json` — applied by `init` (always, even without
  `--write-user-config`) and by `activate` via `ensureUserConfigCliGrant` (global.ts), so a
  single machine-wide grant covers every repo. Unlike the user-global *hooks* (still opt-in,
  because a hook fires in every project), the permission grant is benign and so is unconditional.

## Agent hooks (advisory, scope-aware)

`leina init` writes a project-scoped `.devin/hooks.v1.json`. The hooks are merge-safe
and idempotent; a `.bak-<ISO>` is dropped on the first content-changing write to a
pre-existing file. The user-global flavour (`~/.config/devin/config.json` `hooks` key) is
**opt-in** via `--write-user-config` — by default `init` only writes project-scoped files
because a user-global hook fires in every Devin project on the machine.

- Subcommand: `leina agent-hook <Event>` (compat alias: `devin-hook`), payload on stdin. Managed events:
  `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `PostCompaction`, `Stop`.
- **SessionStart**: deletes **both** markers (`session.memory-loaded` + `session.memory-saved`),
  calls `buildActiveContext(cwd)` → injects real memory observations + graph stats as
  `additionalContext` (including end-of-session save reminder); re-writes load marker if
  delivered=true, falls back to SESSION_START_CONTEXT (static advisory) if injection fails.
- **PostCompaction**: re-injects context after compaction (same as SessionStart but does NOT
  reset the markers first — re-arms the load marker). `summary` field is intentionally ignored.
- **Stop**: advisory nudge to persist session memory. Checks `<cwd>/.leina/session.memory-saved`
  (`SAVE_MARKER_REL` in `src/cli/agent-gate.ts`); emits `STOP_SAVE_NUDGE` on stderr (naming
  `leina memory session` and `leina memory save`) when the marker is absent.
  stdout is ALWAYS empty. Never blocks (exit 0 on all paths).
- Load marker is per-project at `<cwd>/.leina/session.memory-loaded` — `PostToolUse` on
  an `exec` whose command runs `leina memory (context|search|verified)` writes it
  (`MEMORY_LOAD_CMD_RE` in `src/cli/agent-gate.ts`); marker is re-written on successful injection, never on
  fallback. The marker short-circuits all advisories once memory has been loaded.
- Save marker is per-project at `<cwd>/.leina/session.memory-saved` — `PostToolUse` on
  an `exec` whose command runs `leina memory (save|session|update)` writes it
  (`MEMORY_SAVE_CMD_RE` in `src/cli/agent-gate.ts`; lookahead excludes `session-start`). Deleted at
  SessionStart alongside the load marker (per-session semantics). Only the Stop branch reads it.

**Advisory only.** The gate **never** returns `exit 2` / `{"decision":"block"}` — a non-empty
`reason` is emitted on stderr as a one-time nudge, and the agent always proceeds. Honest
scope: this is a workflow nudge, not a security control, and never an obstacle to the user.

**Scope-aware silent no-op.** If `<cwd>/.devin/hooks.v1.json` does not exist (the project
is not leina-initialized), `runAgentGate` returns 0 silently — no stderr nudge, no
`SessionStart`/`PostCompaction` additionalContext. This is what lets the opt-in user-global
hook stay quiet in unrelated repos.

**Fail OPEN** on every error path (empty/invalid stdin, missing fields, fs errors) → exit 0.

The grep/find branch (`rg|grep|find` in an `exec` command) emits an advisory steering the
agent toward `leina query` / `leina affected`. The `git commit` branch (anchored
to exclude `commit-tree` / `commit-graph`) emits a memory-load advisory.

## Hook launch form

The hooks call back into THIS CLI on disk via `deriveCliCommand` (`src/application/install/command.ts`):
`{ command: "<abs-node>", args: ["<abs-cli.{js,ts}>"] }` (plus `--experimental-strip-types`
for a `.ts` dev entry). Absolute paths are used so the hook resolves regardless of PATH — GUI
hosts on macOS (Devin.app) and Windows do not inherit the shell PATH from launchd / Services.

**Project root resolution.** The `agent-hook` (alias `devin-hook`) events are NOT pinned to a baked dir (a single
user-global hook fires in every repo, so it must resolve the project at runtime). It resolves
via `resolveHookProjectRoot(process.env, process.cwd())` (`src/cli/agent-gate.ts`): it prefers
Devin's documented `DEVIN_PROJECT_DIR` env var — the contract for telling a hook its workspace
root; no hook stdin payload carries a `cwd` — and falls back to `process.cwd()` when the var is
absent/blank. Everything downstream of the hook keys off this root: the scope guard
(`isLeinaProject`), the session markers, and `buildActiveContext` (project key + graph.db +
freshness). The PostToolUse `refresh` hook is the exception — it carries the project dir baked
at init time, so it is unaffected by the runtime root resolution.

<!-- leina:protocol:start -->
## leina — code graph + project memory (use the CLI)

This repo ships a leina knowledge graph (what the code IS) and project memory
(WHY it is that way). Prefer the `leina` CLI
over grepping or re-deriving context.

CLI-FIRST (startup rules — trigger these BEFORE reaching for grep, glob or read)
- **Structural or multi-hop question** ("what calls X?", "what imports Y?", "where is pattern Z?"):
  run `leina query <dir> "<question>"` BEFORE grepping or reading files. The graph
  answers structural questions without spending read-tool budget.
- **Before renaming or migrating** any symbol, function, type or file: run
  `leina affected <dir> <symbol>` first — know the blast radius before touching anything.
- **Before re-deriving context** that may already be in memory (decisions, conventions, SDD
  artifacts): run `leina memory search <dir> "<query>"` first. Re-deriving saved
  knowledge wastes turns and risks contradicting what's already there.

GRAPH
- For structural / dependency / "what depends on or relates to X" questions, query the graph
  instead of reading or grepping files: `leina query <dir> "<question>"`, and
  `leina affected <dir> <symbol>` BEFORE renaming or migrating a symbol (blast radius).
- The graph keeps itself fresh: `query`/`affected`/`path` auto-rebuild when sources changed
  before answering (`leina status <dir>` to check, `leina refresh <dir>` to force).
  Under the "refuse" posture a stale query asks you to run `refresh` first.
- Other reads: `leina path <dir> <a> <b>` (shortest path), `leina stats <dir>`.
- To SEE the graph: `leina visualize <dir> [--out <path>] [--drilldown]` exports an offline HTML
  viewer (folder colours, degree sizing, god nodes, click-through detail drawer). On a workspace root it
  is workspace-aware: builds/merges without clobbering the merged graph and renders the constellation
  (two-level) view by default; `--drilldown` shows the merged graph coloured by repo. Equivalent explicit
  form: `leina workspace visualize <dir>`.
- If anything looks broken (stale graph, missing hooks, install drift): run
  `leina doctor <dir>` to diagnose install + project health before guessing.
- C#/Java repos: by default these extract with tree-sitter (SYNTACTIC — call edges are
  best-effort). For compiler-grade precision run `leina sidecar status` then
  `leina sidecar build <csharp|java>` once (needs the local toolchain: dotnet SDK for
  C#; JDK 17+ with `jpackage` for Java; behind a private mirror set `LEINA_MAVEN_BASE`).
  Without a sidecar the graph still builds — just don't trust Java/C# call edges as exhaustive.

MEMORY (always-on injection + global DB, keyed by project — advisory, never blocks)
- **Automatic injection**: the `SessionStart` hook injects the top-10 project memory
  observations + graph stats directly into the agent's system context before the first turn —
  no manual `memory context` call required. The `PostCompaction` hook re-injects the same
  context after a compaction event so the agent never starts a compacted session cold.
- Memory is always-on: no project init required. All observations land in a single global DB
  (`~/.leina/memory.db`), scoped by a stable project key derived from the git remote /
  repo root / dir name. Use `leina memory current-project <dir>` to see your key.
- Run `leina memory context <dir>` (or `memory search` / `memory verified`) for a
  supplementary mid-session reload or when you want to search / verify specific observations.
  The hooks DO NOT block prompts, edits, writes or `git commit`.
- Run `leina memory search <dir> "<query>"` (or `memory verified` for context checked
  against the live graph) BEFORE re-deriving something that may already be saved.
- Run `leina memory save <dir> --title "..." --content "..."` PROACTIVELY right after a
  decision, bug fix or non-obvious discovery — don't wait to be asked. Pass `--topic <key>` to
  evolve an existing entry in place.
- Run `leina memory get <dir> <id>` to read a single observation in full, and
  `leina memory update <dir> <id> [--title] [--content] [--type]` to correct one in place.
- Run `leina memory session-start <dir>` to open a fresh session id, and
  `leina memory suggest-topic <dir> --title "..."` to get a normalized topic_key.
- Run `leina memory session <dir> --content "<summary>"` at the END of a session.
- To lock a project name permanently: `leina init --name <name>` (writes
  `.leina/config.json`, committable, takes priority over all other detection steps).
- To move memories under a new key: `leina memory merge-projects <dir> --from <old> --to <new>`.

SHELL
- Prefer `bash` for any command execution when the host offers a choice (`interactive_shell`,
  shell selectors, etc.). The hooks, scripts and CLI examples in this repo are bash-first; running
  them under PowerShell or `sh` works on a best-effort basis but is not the supported path. Fall
  back to PowerShell only on Windows when bash is genuinely unavailable.

SDD (spec-driven changes)
- For a non-trivial change, work the flow: explore → propose → spec → design → tasks →
  apply → verify → archive. Don't jump straight to code on a substantial feature.
- ALWAYS drive SDD through the `leina-sdd` orchestrator skill — it does the memory
  pre-flight, opens a session, and front-loads each phase's brief + the user's language so the
  stateless phase subagents never start blind. Do NOT invoke the individual `/sdd-*` phase
  skills directly via the skill tool: that spawns the executor with empty arguments, so it loses
  the conversation context and stops to re-ask what the change is about. (A human typing
  `/sdd-explore <args>` at the prompt is the only exception.)
- Conduct SDD in the user's language: phase prose and artifact CONTENT follow the user's
  language; `topic_key`s and slugs (`sdd/{change}/…`) stay in English.
- At DESIGN and TASKS, scope the change against the graph before you decide: run
  `leina affected <dir> <symbol>` on every symbol the change touches to get the real
  blast radius. Let it drive the file-change list, the task ordering, and the size estimate —
  don't guess what depends on what.
- Persist each artifact in project memory under a stable topic_key `sdd/{change}/{artifact}`
  (e.g. `sdd/auth-rework/proposal`) via `leina memory save --topic`. Re-running a phase
  upserts the same topic_key in place. The plan lives in the repo's own memory — no external store.
<!-- leina:protocol:end -->
