# AGENTS.md — leina project conventions

This file documents conventions and tooling for AI agents working on the leina
codebase itself. **leina exposes a command-line interface.** Its supported install
targets are your AI host(s) — Devin and Claude Code (`--hosts devin,claude`); the
Windsurf editor uses the same `.devin/` on-disk shape as Devin.

---

## Memory (CLI)

Memory lives in the global DB `~/.leina/memory.db` (honoring `$LEINA_HOME`), keyed by a
stable project key, and is accessed through the `leina memory <sub>` CLI (`[<dir>]` defaults to the
current directory and resolves to its project root). Anchors resolve against the
live graph on save (fingerprinting the anchored symbol's own lines), and `memory verified` re-checks
them (drift detection). `memory reanchor` upgrades pre-3.0 whole-file anchors from git history.

### Memory subcommands

| Command | Purpose |
|------|---------|
| `memory save [<dir>] --title --content [--type] [--topic] [--anchors]` | Save/upsert an observation |
| `memory update [<dir>] <id> [--title] [--content] [--type] [--status]` | Update an observation in place |
| `memory resolve [<dir>] <id> [--note] [--obsolete]` | Close a note (hidden from injection/context, kept in search) |
| `memory reopen [<dir>] <id>` | Set a resolved/obsolete note back to active |
| `memory search [<dir>] "<query>"` | Full-text search |
| `memory verified [<dir>] "<query>"` | Search + drift classification (USABLE/WARNING/DO-NOT-USE) |
| `memory get [<dir>] <id>` | Full observation content by id |
| `memory context [<dir>]` | Recent sessions + latest observations |
| `memory session [<dir>] --content` | Save a session summary |
| `memory session-start [<dir>]` | Open a new session, print its id |
| `memory suggest-topic [<dir>] --title` | Suggest a normalized topic_key |

`save`, `update` and `get` also accept `--batch` (JSON array on stdin; `--atomic` for save/update).

**Always-on injection**: the `SessionStart` hook automatically injects the top-10 ranked active
memory observations (type × recency, short ids) + graph stats into the agent's context — no manual `memory context` call needed
at session start. `PostCompaction` re-injects the same context after compaction events.
`Stop` emits a once-per-session advisory to run `leina memory session [<dir>]` if no save
was detected this session (advisory only — never blocks; Claude Code receives it as Stop
`additionalContext`, Devin on stderr).

**Run `leina memory context [<dir>]`** for mid-session supplementary reloads or targeted
searches. **Run `leina memory save` proactively** after architectural decisions, bug
fixes and non-obvious discoveries — do not wait to be asked.

---

## Graph commands

Use the graph CLI before grepping or re-deriving structural context:

- `leina query [<dir>] "<question>"` — relevance-ranked subgraph (auto-rebuilds if stale; test/mock/fixture nodes only with `--include-tests`)
- `leina affected [<dir>] <symbol>` — blast radius (call before rename/migrate; `--depth <n>`, default 3)
- `leina path [<dir>] <a> <b>` — shortest path between two symbols
- `leina visualize [<dir>] [--out <path>] [--drilldown]` — export offline HTML graph viewer (folder colours, degree sizing, god nodes; click a node for a detail drawer). Workspace-aware: on a workspace root it builds/merges (does NOT clobber the merged graph) and renders the two-level constellation by default (`--drilldown` for the merged graph coloured by repo)
- `leina status [<dir>]` — check if the graph is stale (no rebuild)
- `leina refresh [<dir>]` — force a full rebuild (re-extracts every file, ignoring the extraction cache)

`query`/`affected`/`path` route through the freshness gate (`openFreshStore` in `src/cli/wiring.ts`,
using `isStale` from `src/application/graph/manifest.ts`):
stale + posture `auto` rebuilds before answering; `refuse` instructs you to run `refresh`.

Every command and sub-command answers `--help` (`leina <command> --help`). Exit codes: `0`
success, `1` runtime failure, `2` usage error (unknown command or flag, missing or extra
argument, invalid flag value, an explicit `<dir>` that does not exist). The command table in
`src/cli/commands.ts` is the single source for help, flag validation and dispatch.

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
- `dist/cli/index.js` is intentionally tiny (under 1 KB): it is the thin entry that lazy-imports
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

`leina init` does NOT run `activate`: when global activation is missing it only prints a
hint to run `leina activate` (skipped under `leina setup` blanket mode, where setup already
ran it). `init` never touches the user-global `~/.config/devin/config.json`.

The CLI is pre-authorized so the agent never gets a permission prompt for `leina ...`:
`grantCliExecPermission` (`src/application/install/permissions.ts`) adds `Exec(leina)` to
`permissions.allow` (merge-safe + idempotent — the additive inverse of
`revokeCliExecPermission`). It is written in **two** places:

- **Project-scoped** `.devin/config.json` (committable) — written by a full `leina init`
  when the Devin host is selected, so the grant travels with the repo and anyone who clones it
  gets a zero-prompt CLI.
- **User-global** `~/.config/devin/config.json` — written by `activate`/`setup` through
  `writeUserGlobalConfig` (`src/application/activate.ts`), so a single machine-wide grant
  covers every repo. Unlike the user-global *hooks* (`--no-user-hooks` opts out, because a
  hook fires in every project), the permission grant is benign and so is unconditional.

The MCP-era cleanup helpers in `src/application/install/migrate.ts` (stale `mcpServers`
entry, dead `mcp__leina__*` hook matchers and permission grants) are no longer wired into
any command; only their tests exercise them.

## Agent hooks (advisory, scope-aware)

`leina init` writes the project-scoped hooks of the selected hosts (`.devin/hooks.v1.json`,
`.claude/settings.json`). The user-global flavour is written by `activate`/`setup` (default
ON, `--no-user-hooks` opts out) for each selected host: the `hooks` key of
`~/.config/devin/config.json` and of `~/.claude/settings.json` (`writeUserGlobalConfig` /
`writeClaudeUserSettings` in `src/application/activate.ts`). Those writes are merge-safe and
idempotent; a `.bak-<ISO>` copy is dropped on a content-changing write to a pre-existing file. A
deselected host (or `--no-user-hooks`) gets our entries stripped; `deactivate`/`disable` strip
both files. `init` never writes user-global hooks.

- Subcommand: `leina agent-hook <Event>` (compat alias: `devin-hook`), payload on stdin. Managed events:
  `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `PostCompaction`, `Stop`.
- **SessionStart**: on a NEW session (`isNewSession`: payload `source` is `startup`/`clear`, or
  absent as on Devin) deletes the per-session markers (`session.memory-loaded`,
  `session.memory-saved` and the one-shot nudge/fallback markers); `resume`/`compact` keep them.
  Always calls `buildActiveContext(cwd)` → injects real memory observations + graph stats as
  `additionalContext` (including end-of-session save reminder); re-writes load marker if
  delivered=true, falls back to SESSION_START_CONTEXT (static advisory) if injection fails —
  `UserPromptSubmit` delivers that fallback at most once per session (`FALLBACK_MARKER_REL`).
- **PostCompaction**: re-injects context after compaction (same as SessionStart but does NOT
  reset the markers first — re-arms the load marker). `summary` field is intentionally ignored.
- **Stop**: advisory nudge to persist session memory. Checks `<cwd>/.leina/session.memory-saved`
  (`SAVE_MARKER_REL` in `src/cli/agent-gate.ts`); emits `STOP_SAVE_NUDGE` (naming
  `leina memory session` and `leina memory save`) when the marker is absent — at most once per
  session (`STOP_NUDGE_MARKER_REL`) and never when the payload has `stop_hook_active: true`.
  Never blocks (exit 0 on all paths).
- Load marker is per-project at `<cwd>/.leina/session.memory-loaded` — `PostToolUse` on
  an `exec` whose command runs `leina memory (context|search|verified)` writes it
  (`MEMORY_LOAD_CMD_RE` in `src/cli/agent-gate.ts`); marker is re-written on successful injection, never on
  fallback. The marker short-circuits all advisories once memory has been loaded.
- Save marker is per-project at `<cwd>/.leina/session.memory-saved` — `PostToolUse` on
  an `exec` whose command runs `leina memory (save|session|update)` writes it
  (`MEMORY_SAVE_CMD_RE` in `src/cli/agent-gate.ts`; lookahead excludes `session-start`). Deleted at
  SessionStart alongside the load marker (per-session semantics). Only the Stop branch reads it.

**Advisory only.** The advisory gate (`runAgentGate`) **never** returns `exit 2` /
`{"decision":"block"}` — a non-empty `reason` is a one-time nudge, and the agent always
proceeds. It goes out in the channel the host shows the agent (`emitAdvisoryText`): Claude
Code never sees a hook's stderr on exit 0, so for `--host claude` every advisory is
`hookSpecificOutput.additionalContext` JSON on stdout; Devin documents additionalContext for
PostToolUse (used there) and keeps the stderr nudge for PreToolUse/Stop. Honest scope: this is a workflow nudge, not a security control,
and never an obstacle to the user. The harness enforcement branch that runs first on the
same entry point (`runHarnessAgentGate`) is the exception, and only in a trusted workspace:
it always refuses writes to the harness rules/config/lockfile and to `$LEINA_HOME/harness`
/ `$LEINA_HOME/trust`, and with an active contract, strictness `strict` or an unreadable
config it applies the contract scope, the commit guard and the Stop gate
(docs/concepts/07-harness.md).

**Scope-aware silent no-op.** Unless `.leina/consent` is `enabled` (`isLeinaProject`) **and**
the workspace is trusted on this machine (`isWorkspaceTrusted`,
`src/application/install/trust.ts`: the out-of-repo record `leina init` writes under
`$LEINA_HOME/trust/`, consent not `disabled`), `runAgentGate` returns 0 silently — no stderr
nudge, no `SessionStart`/`PostCompaction` additionalContext, no background self-heal build.
A committed consent flag alone grants nothing. This is what lets the opt-in user-global
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
Every managed entry then runs `agent-hook <Event> --host <claude|devin>`, plus `--scope user`
for the user-global copy (`agentHookCommand` / `parseManagedHookCommand` in
`src/application/install/hook-command.ts`). `--host` picks the output protocol; `--scope user`
lets the machine-wide copy defer to a project's own wiring. Entries without the flags (written
before 3.0, including the `devin-hook` alias) are still recognised and rewritten by the next
`init`/`activate`/`repair`.

**One answer per event.** A host fires every copy of the wiring it reads (Claude Code: its
project and user settings; Devin: its own two files AND Claude Code's two). `handleAgentHook`
first asks `shouldDeferInvocation` (`src/cli/agent-gate.ts`, pure rule in
`src/application/install/hook-scope.ts`): for the event at hand, the highest-priority copy the
running host loads answers — Devin: own project > Claude Code project > own user > Claude Code
user; Claude Code: project > user — and every lower copy exits 0 silently. The running host is
recognised by `DEVIN_PROJECT_DIR` / `CLAUDE_PROJECT_DIR`; project files are looked up at Claude
Code's project dir, or from Devin's up to the repo root. Entries without `--host` never stand
down.

**Project root resolution.** The `agent-hook` (alias `devin-hook`) events are NOT pinned to a baked dir (a single
user-global hook fires in every repo, so it must resolve the project at runtime). It resolves
via `resolveHookProjectRoot(process.env, process.cwd())` (`src/cli/agent-gate.ts`): the first
non-blank of Claude Code's documented `CLAUDE_PROJECT_DIR` and Devin's documented
`DEVIN_PROJECT_DIR` — the hosts' contract for telling a hook its workspace root; no hook stdin
payload carries a `cwd` — falling back to `process.cwd()` when both are absent/blank. That
directory may be a subdirectory or a worktree, so `resolveHookRoots` walks up from it
(`src/application/project/root.ts`): the advisory gate keys off the consent root
(`findConsentRoot` — the scope guard `isLeinaProject` + `isWorkspaceTrusted`, the session
markers, and `buildActiveContext`), the harness off the checkout's own root
(`findHarnessRoot`), trusted through `isTrustedWorkspaceDir` only within the same repository —
a nested independent clone or submodule never inherits its parent's trust. `leina harness
hook` and verify's project-gate policy use the same trust check. No hook rebuilds the graph: the pre-3.0 Devin
PostToolUse `refresh <project>` entry (a full synchronous rebuild per agent edit) is no longer
emitted, and the Devin writers still own its `^(edit|write)$` matcher so re-running
`init`/`repair` strips it.

<!-- leina:protocol:start -->
## leina — code graph + project memory (MCP tools or CLI)

This repo ships a leina knowledge graph (what the code IS) and project memory
(WHY it is that way). Prefer leina over grepping or re-deriving context.

TRANSPORT (pick once, at session start)
- If tools named `mcp__leina__*` are in your tool list, PREFER them: same capabilities,
  structured JSON, no shell round-trip. Every tool takes an optional `root` — it is the
  `[<dir>]` argument of the CLI forms below (default: the workspace the server was launched
  in; roots that resolve outside it are rejected).
- Otherwise run the `leina` CLI as written below. `[<dir>]` is optional everywhere: it
  defaults to the current directory and resolves to the project root, so commands work the
  same from any subdirectory. `leina <command> --help` prints a command's arguments and
  flags; a usage error (unknown flag, missing argument) exits 2 with a one-line hint.
- Mapping (CLI → tool): query→graph_query · affected→graph_affected · path→graph_path ·
  stats→graph_stats · status→graph_status · build/refresh→graph_build · impact→impact_analyze ·
  visualize→graph_visualize · audit→audit_run · doctor→doctor_run · memory save→memory_add ·
  memory search→memory_search · memory verified→memory_verified · memory context→memory_context ·
  memory get→memory_get · memory update→memory_update · memory suggest-topic→memory_suggest_topic ·
  memory session→memory_session. Batch: pass `items`/`ids` arrays to memory_add/memory_get.
- CLI-ONLY (never via MCP, by design): `leina env exec` — the names-not-values contract
  injects secrets process-to-process; a tool result would pull the values into model context.

LEINA-FIRST (startup rules — via MCP tool or CLI, per TRANSPORT; trigger these BEFORE grep, glob or read)
- **Structural or multi-hop question** ("what calls X?", "what imports Y?", "where is pattern Z?"):
  run `leina query [<dir>] "<question>"` BEFORE grepping or reading files. The graph
  answers structural questions without spending read-tool budget.
- **Before renaming or migrating** any symbol, function, type or file: run
  `leina affected [<dir>] <symbol>` first — know the blast radius before touching anything.
- **Before re-deriving context** that may already be in memory (decisions, conventions, SDD
  artifacts): run `leina memory search [<dir>] "<query>"` first. Re-deriving saved
  knowledge wastes turns and risks contradicting what's already there.

GRAPH
- For structural / dependency / "what depends on or relates to X" questions, query the graph
  instead of reading or grepping files: `leina query [<dir>] "<question>"` (test/mock/fixture
  nodes are left out unless `--include-tests` or the question is about tests), and
  `leina affected [<dir>] <symbol> [--depth <n>]` BEFORE renaming or migrating a symbol.
- Symbol arguments (`affected`, `path`, `impact analyze`) match EXACTLY, never by
  substring: a name, `path/to/file.ts:name`, `Class.method`, a raw node id or a file path.
  Several matches → the best one is used and a note on stderr lists the others with the
  selector that picks each; no match → "did you mean" candidates and exit 1.
- The graph keeps itself fresh: `query`/`affected`/`path` auto-rebuild when sources changed
  before answering (`leina status [<dir>]` to check, `leina refresh [<dir>]` to force a
  full re-extraction). Under the "refuse" posture a stale query asks you to run `refresh` first.
- Other reads: `leina path [<dir>] <a> <b>` (shortest path), `leina stats [<dir>]`,
  `leina impact analyze [<dir>] <symbol>` (files, tests, services, configs it reaches).
- To SEE the graph: `leina visualize [<dir>] [--out <path>]` exports an offline HTML viewer
  (folder colours, degree sizing, god nodes, click-through detail drawer).
- If anything looks broken (stale graph, missing hooks, install drift): run
  `leina doctor [<dir>]` to diagnose install + project health before guessing.
- C#/Java repos: by default these extract with tree-sitter (SYNTACTIC — call edges are
  best-effort). For compiler-grade precision run `leina sidecar status` then
  `leina sidecar build <csharp|java>` once (needs the local toolchain: dotnet SDK for
  C#; JDK 17+ with `jpackage` for Java; behind a private mirror set `LEINA_MAVEN_BASE`).
  Without a sidecar the graph still builds — just don't trust Java/C# call edges as exhaustive.

MEMORY (always-on injection + global DB, keyed by project — advisory, never blocks)
- **Automatic injection**: in a repo initialized with `leina init` and trusted on this machine,
  the `SessionStart` hook injects the top-10 project memory observations + graph stats into
  the agent's context before the first turn — no manual `memory context` call required. The
  `PostCompaction` hook re-injects the same context after a compaction event.
- Memory itself needs no init: all observations land in a single global DB
  (`~/.leina/memory.db`), scoped by a stable project key derived from the git remote /
  repo root / dir name. Use `leina memory current-project [<dir>]` to see your key.
- Run `leina memory context [<dir>]` (or `memory search` / `memory verified`) for a
  supplementary mid-session reload or when you want to search / verify specific observations.
  The memory hooks DO NOT block prompts, edits, writes or `git commit`.
- Run `leina memory search [<dir>] "<query>"` (or `memory verified` for context checked
  against the live graph) BEFORE re-deriving something that may already be saved.
- Run `leina memory save [<dir>] --title "..." --content "..."` PROACTIVELY right after a
  decision, bug fix or non-obvious discovery — don't wait to be asked. Pass `--topic <key>` to
  evolve an existing entry in place.
- Run `leina memory get [<dir>] <id>` to read a single observation in full, and
  `leina memory update [<dir>] <id> [--title] [--content] [--type]` to correct one in place.
- When a saved note is done or no longer true (a shipped backlog item, a landed fix), run
  `leina memory resolve [<dir>] <id> [--note "..."]` (`--obsolete` when it no longer applies;
  `leina memory reopen [<dir>] <id>` undoes it). Resolved notes leave the injection; search
  still finds them.
- Run `leina memory session-start [<dir>]` to open a fresh session id, and
  `leina memory suggest-topic [<dir>] --title "..."` to get a normalized topic_key.
- Run `leina memory session [<dir>] --content "<summary>"` at the END of a session.
- To lock a project name permanently: `leina init --name <name>` (writes
  `.leina/config.json`, committable, takes priority over all other detection steps).
- To move memories under a new key: `leina memory merge-projects [<dir>] --from <old> --to <new>`.

HARNESS (opt-in)
- Opt in per repo with `leina init --harness`: it seeds `.harness/` (rules + executable
  gates, synced to the host hooks); a plain `leina init` leaves it alone. In a repo that uses
  it, declare the task with `leina harness contract new --goal "..."` and finish with
  `leina harness verify` (exit 0 = complete, 1 = a blocking gate failed — fix it, never
  weaken the gate).

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
  `leina affected [<dir>] <symbol>` on every symbol the change touches to get the real
  blast radius. Let it drive the file-change list, the task ordering, and the size estimate —
  don't guess what depends on what.
- Persist each artifact in project memory under a stable topic_key `sdd/{change}/{artifact}`
  (e.g. `sdd/auth-rework/proposal`) via `leina memory save --topic`. Re-running a phase
  upserts the same topic_key in place. The plan lives in the repo's own memory — no external store.
<!-- leina:protocol:end -->
