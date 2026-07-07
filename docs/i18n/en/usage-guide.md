# Usage guide — leina

> **What is leina?** It's a **command-line (CLI)** tool that gives your AI assistants (Devin, Claude Code, Cursor, VS Code, Codex, Gemini CLI, LM Studio, and any other MCP-capable host) **two capabilities** they don't have by default:
>
> - a **knowledge graph** of the code — knowing what depends on what, what breaks if you touch something, how the pieces connect;
> - a **persistent memory** of the project — decisions, fixes, discoveries and context that survive across sessions.
>
> With leina installed, the AI stops re-reading the repo in every conversation and starts reasoning about the project's actual structure and history, running `leina` commands through its shell.

> ℹ️ **leina offers a command-line interface.** Each command operates on an explicit `<dir>`. The query path starts fast (~0.15s) because the heavy extraction stack (tree-sitter + ts-morph) only loads on `build`/`refresh`.

This guide has **three parts**:

1. **Requirements** — what needs to be installed on your machine before you start.
2. **Part 1 — Setup** — a single command (`setup`) once per machine; repos get onboarded on their own when the AI asks you.
3. **Part 2 — What you can ask the AI once it's installed** — the catalog of things it now knows how to do, including SDD (Spec-Driven Development).
4. **Part 3 — Daily use** — the flow of a typical session: automatic hooks, memory + graph + SDD in day-to-day work.

> 🧠 **Want to understand how it works under the hood?** The conceptual guide in
> [`docs/concepts/`](../concepts/README.md) explains the mechanics of the graph, the memory,
> search, *drift* and hooks, with diagrams and storytelling-style analogies. This guide is
> the *how to use it*; that one is the *how it works*.

---

## Requirements

You only need to verify these **once** on your machine:

| Requirement | What it's for | How to check |
|---|---|---|
| **Node.js ≥ 22.13** | The engine leina runs on. With Node 22/23 the `memory` commands work but search runs in degraded mode (LIKE, no stemming or BM25). **Node ≥ 24 is recommended** to get full full-text search (SQLite FTS5); the `leina doctor` command tells you if you need to upgrade. | `node --version` |
| **Git** *(optional)* | Only if you'll run leina from a clone (contributors). Not needed for normal use with `npm install -g`. | `git --version` |
| **An AI host** | The AI that consumes leina. Two ways to connect it: **MCP** (universal — Claude Code, Cursor, Windsurf, VS Code, Codex, Gemini CLI, LM Studio, Zed, …) or the auto-injection **hooks** (Devin and Claude Code only). See step 7 of [`getting-started`](../../GETTING_STARTED.md#7-connect-it-to-your-ai). | depends on the host |

> 💡 If you use a Node version manager (`fnm`, `nvm`, `Volta`, `scoop`), you don't need to change anything — leina runs like any other command on your PATH.

If you're missing any of these, install it before continuing.

---

## Part 1 — Setup

Setup is **a single command, once per machine**. After that you don't have to remember anything per project: when you use Devin or Claude Code in a repo, the AI itself asks you (via the `leina-setup` skill) whether you want to use leina there.

### The magic command (once per machine)

**Recommended option — install the binary on your PATH:**

```bash
npm install -g @kolimar/leina
leina tui                # interactive console: pick "install" → assets + hosts + MCP, no flags
```

`leina tui` is the easiest path: a menu walks you through which assets to install, which AI hosts
(Devin, Claude Code, Cursor, Windsurf), blanket mode, and MCP registration. Prefer a single command
with no prompts? `leina setup` does the recommended install in one shot (all assets + blanket; add
`--mcp` to register the MCP server too).

With that, leina becomes available in **any** AI session on the machine. Want to undo it all later? One command:

```bash
leina disable            # fully reverts setup (symlinks, user-global config, blanket)
```

> **Contributing to leina or running the latest unpublished code?** That's the only reason to work
> from a clone instead of the global install — the dev setup (`git clone`, `npm install`,
> `npm run cli -- <cmd>`) lives in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md), not here.

**Verify it worked:**

```bash
leina --help     # lists setup/disable, activate/deactivate, init/deinit, build, query, memory, doctor, ...
leina doctor     # diagnoses Node version, global share and symlinks
```

> **Want the pieces separately instead of the magic command?** `setup` composes two things, and each has its inverse: `activate` ⟷ `deactivate` (share + symlinks + user-global config, **without** turning on blanket). `install-global` remains as a deprecated alias for `activate`.

### Per project: nothing to remember

With blanket mode on, **you don't need to initialize each repo by hand**. The first time you use Devin in a repo, the `leina-setup` skill asks you once:

> *"leina is available — do you want to use it in this workspace?"*

- If you say **yes**, it runs `init` (leaves a local `enabled` flag) and from then on leina acts: the graph builds itself the first time you query it, memory becomes available, and hooks inject context.
- If you say **no**, it runs `deinit` (`disabled` flag) and won't bother you again in that repo.

Consent is **tri-state** and lives locally (git-ignored, in `.leina/consent`): `unknown` → asks once · `enabled` → active · `disabled` → total silence. leina **never** starts building a graph in a repo you haven't accepted.

If you want to do it by hand:

```bash
leina init <dir>          # adaptive (see below)
leina init <dir> --build  # also builds the graph now, in foreground
leina deinit <dir>        # removes this repo (consent=disabled) and reverts the wiring
```

**`init` is adaptive** — it writes only what's needed depending on whether blanket is on:

- **With blanket** (the normal case after `setup`): just the `enabled` flag + the block in `.gitignore`. It doesn't write `AGENTS.md` or `.devin/*` because the global share/grant/hooks already cover the repo.
- **Standalone** (without `setup`, when you want leina only in this repo without touching the machine): it also writes `AGENTS.md` (protocol), `.devin/hooks.v1.json` and a **local** `Exec(leina)` grant in `.devin/config.json`. The repo becomes self-sufficient and the user-global config is **never** touched.

**Try it:**

> "Using leina, give me the blast radius of `<a function or class in the project>` and show me what memory it has loaded."

If it responds with real results from the project → **leina is working**.

#### Other projects

You don't have to repeat anything: with blanket, the AI offers it the first time on every new repo. The magic command is done for life.

---

## Part 2 — What you can ask the AI once it's installed

With leina active, your AI (Devin) gains new capabilities that it executes as `leina` commands. Here's the catalog.

> 💡 **Subagent tip for SDD.** Hosts with subagents (Devin, Claude Code) can delegate each SDD phase to a dedicated subagent with its own clean context. For serious changes (features, refactors, migrations) this improves quality: the orchestrator integrates results without "getting dirty" with intermediate details.

### 2.1 — Understanding the code without grepping it

**"What would break if I change this function / class / module?"** — The AI uses the graph (`leina affected`) to compute the real _blast radius_: everything that depends on that symbol, directly or indirectly. It's the first thing you want to ask **before renaming or refactoring**.

**"How do these two modules connect?"** — Shortest path between two pieces of code (`leina path`), useful for flows that cross many layers.

**"Where is this symbol used? / Who calls this function?"** — Answers based on the graph, not on `grep`: it doesn't miss dynamic calls or get confused by false positives.

**"Explain what this module does and what it interacts with."** — Combines file reading with the graph's structural view (`leina query`).

### 2.2 — Project memory across sessions

**"What did we decide about <X> last time?"** — The AI queries persistent memory (`leina memory search`) and brings back saved decisions, bugfixes and discoveries.

**"Save this decision / this discovery for future sessions."** — The AI persists something important (`leina memory save`). It becomes available to you and to anyone who opens the project in the future.

**"Remind me what we were working on."** — At the start of a session, the AI retrieves recent context (`leina memory context`): what was touched, what was decided, what's still pending.

**"Is this note still valid against the current code?"** — `leina memory verified` reclassifies each result against the live graph: **USABLE**, **WARNING** (the anchored code changed — stale) or **DO-NOT-USE** (a claim that the code now contradicts).

### 2.3 — Spec-Driven Development (SDD) with `leina-sdd`

For significant changes — new features, large refactors, migrations — you can invoke the **SDD** flow:

> **"Apply leina-sdd for <description of the change>."**

#### What is SDD?

**Spec-Driven Development** is a structured way to approach a non-trivial change. Instead of jumping straight into coding, the change goes through **eight ordered phases**:

| Phase | What happens |
|---|---|
| **1. Explore** | Investigate the area of the code, technical options, constraints. |
| **2. Propose** | Write a short proposal: intent, scope, approach. |
| **3. Spec** | Define the formal requirements and scenarios for the change. |
| **4. Design** | Decide the architecture and technical approach. |
| **5. Tasks** | Break the work down into an ordered list of concrete tasks. |
| **6. Apply** | Implement the tasks in code. |
| **7. Verify** | Validate that the result meets the spec and the design. |
| **8. Archive** | Close the change: merge specs, leave everything persisted. |

#### Why use it?

- **You don't skip steps**: the AI doesn't start coding before understanding what needs to be done and why.
- **Everything stays documented** in the project's memory under stable keys (`sdd/<change-name>/<phase>`). If someone picks up the change tomorrow, all the reasoning is right there.
- **Design decisions before code**: architecture mistakes get caught in Design, not after everything has been implemented. In Design and Tasks, scope is measured against the graph (`leina affected`) so dependencies aren't guessed at.
- **Verification against the spec**: at the end there's a formal check that what was implemented meets what was requested.
- **Resumable**: if you get interrupted mid-phase, you can come back tomorrow and the AI picks up where you left off.

#### When to use it?

- **Yes**: new features, architecture refactors, migrations, changes that touch several modules.
- **No**: trivial fixes, cosmetic changes, single-file tweaks. For those, a normal conversation with the AI is enough.

### 2.4 — Working with graph health

**"Is the project's graph up to date?"** — `leina status`. If it's outdated, queries rebuild it on their own (`auto` mode, the default) or notify you to refresh it explicitly (`refuse` mode, recommended in CI).

**"Rebuild the graph."** — `leina refresh` regenerates the graph from scratch after major changes.

---

## Part 3 — Daily use

Once installed, daily use is mostly about **doing nothing**: the hooks work on their own and
you talk to the AI as usual. This part covers the flow of a typical session and the
habits that make the system truly pay off.

### The flow of a session

**At startup**, **on Devin and Claude Code** you don't have to prepare anything: there the
`SessionStart` hook has already done two things for you (only in repos with `enabled` consent):

- **injected context**: the AI starts out knowing the project's recent decisions and sessions
  (the equivalent of `leina memory context`) and the graph's status;
- **auto-repaired the graph**: if it didn't exist or was outdated, it triggered a build in the
  background — the next query already finds it fresh.

> **On every other host (via MCP)** there are no hooks, so auto-injection doesn't happen — but you
> get the same effect by asking: the AI calls the `memory_context` / `graph_status` tools on demand.
> On any host, force the recap with: _"What do we already know about this project? Where did we
> leave off last time?"_ — that translates into `memory context` + `memory verified`.

**During the session**, the two habits that pay off the most:

1. **Ask before touching.** _"What breaks if I change the signature of `PaymentService`?"_
   (→ `affected`), _"how does the CLI reach the database?"_ (→ `path`), _"which parts of the
   code deal with retries?"_ (→ `query`). These are millisecond queries against the graph,
   not re-reads of the repo — use them freely, all the time.
2. **Save the why as soon as you discover it.** When the AI (or you) finds the root cause of
   a bug or makes a design decision, ask it: _"save this to memory, anchored to
   `<symbol>`"_. The anchor is what later lets `memory verified` warn you if the
   code changed underneath that decision.

**For large changes**, invoke the SDD flow: _"let's approach this with SDD"_. The AI orchestrates
explore → propose → spec → design → tasks → apply → verify, and in the design and
tasks phases it **measures the real impact with `leina affected`** before deciding. The artifacts of
each phase stay in memory, so you can pause and resume in another session without losing anything.

**When wrapping up**, if the session had substance, ask for a summary: _"close the session and save a
summary of what we did"_ (→ `memory session`). That's what the next session will read at
startup.

### What the hooks do without being asked (Devin and Claude Code)

> Hooks are the **Devin and Claude Code** integration — the two hosts with a hooks mechanism. On
> every other host leina connects over **MCP**: the same capabilities as tools, which the AI calls
> on demand (no auto-injection). See step 7 of
> [`getting-started`](../../GETTING_STARTED.md#7-connect-it-to-your-ai).

| Moment | What happens |
|---|---|
| `SessionStart` | Injects recent memory + graph stats; auto-build in background if the graph is missing or stale. |
| During the session | Non-blocking advisories: freshness nudges, relevant memory suggestions. |
| Always | Everything is **advisory and fail-open**: a hook never blocks your work, and in repos without opt-in (`unknown`/`disabled`) it's a silent no-op. |

Can be disabled: `LEINA_DISABLE_AUTOBUILD=1` turns off auto-build; `leina deinit` turns
everything off for a repo; `leina disable` for the whole machine.

### Credentials for skills that call services

When a task needs to call an authenticated API (SonarQube, Jira, an internal API), the
credential is handled under the **names-not-values** contract: the AI only knows the *name* of
the variable, never the value. The flow:

1. **You, once**: `leina env set SONAR_TOKEN` (hidden prompt — it doesn't stay in the
   shell history or in the conversation). Also available from `leina tui` → "env vars".
2. **The AI, every time**: verifies that the name exists (`leina env list` shows
   `SONAR_TOKEN=squ****`, masked) and consumes it via process injection:
   `leina env exec --only SONAR_TOKEN -- sh -c 'curl -u "$SONAR_TOKEN:" https://sonar.../api/...'`
   — the single quotes make the value expand in the child process, never in the
   model's context.

If the AI ever asks you to paste a token into the chat, refuse: the correct pattern is
for it to ask you to run `leina env set`. The included `authenticated-api` skill teaches it this
full contract, including POST requests with a token in the header and the stricter variants.

### Visual tools for you (not for the AI)

- `leina visualize <dir>` — exports a static, offline, self-contained **HTML file** of the graph
  (search, filters, communities). Being a file, you can share/commit it and open it whenever. Ideal
  for onboarding: _seeing_ the real architecture, not the old wiki diagram.
- `leina graph serve <dir>` — **not the same thing**: it starts a **live local server** (read-only,
  `:7423`, Ctrl+C to stop) with what a static file can't have — a **multi-project selector** and each
  node's **anchored memory** (drift-badged). Use it to browse live or inspect memory; use `visualize`
  to share a snapshot.
- `leina audit <dir> --format html` — candidate source→sink paths for security
  triage.
- In monorepos / folders with several repos: `leina workspace visualize` shows the
  constellation of repos and their cross-dependencies.

---

## Appendix — Technical reference

> This section is for more technical users or for troubleshooting. You don't need it for normal use with the AI.

### A.1 — CLI commands

| Command | What it's for |
|---|---|
| `leina setup` | **Magic command** (once per machine): activate + turns on blanket. |
| `leina disable` | Fully reverts `setup` (symlinks, user-global config, blanket). |
| `leina activate` / `deactivate` | Global piece of `setup` (share/symlinks/user-global config) and its inverse. `install-global` = deprecated alias for `activate`. |
| `leina init <dir>` | Onboards the repo (consent `enabled`). Adaptive: LIGHT with blanket, FULL standalone. `--build` builds the graph now. |
| `leina deinit <dir>` | Removes the repo (consent `disabled`) and reverts the wiring (reverse-strip). |
| `leina build <dir>` | Builds / rebuilds the project's graph. |
| `leina refresh <dir>` | Forces a full rebuild of the graph. |
| `leina status <dir>` | Indicates whether the graph is up to date. |
| `leina stats <dir>` | Counts nodes and edges of the graph. |
| `leina affected <dir> <symbol>` | Blast radius of a symbol (auto-rebuild if stale). |
| `leina path <dir> <from> <to>` | Shortest path between two symbols. |
| `leina query <dir> "<question>"` | Relevant subgraph for a question. |
| `leina impact analyze <dir> <symbol>` | Impact crossing code→tests→configs→services. |
| `leina visualize <dir>` | Exports an interactive, offline HTML viewer of the graph. |
| `leina memory <dir> <sub>` | Local memory (`save`/`update`/`search`/`verified`/`get`/`context`/`session`/`session-start`/`suggest-topic`/`current-project`/`merge-projects`/`migrate`). |
| `leina workspace <sub> [dir]` | Multi-repo: `build`/`status`/`detect`/`memory context\|search`/`visualize`. |
| `leina audit [dir]` | Candidate source→sink paths + findings (`--format md\|json\|html`). |
| `leina env <sub>` | Credentials for skills (names-not-values): `set`/`list`/`get`/`unset`/`exec`. |
| `leina sidecar <sub>` | Compiler-precision C#/Java sidecars: `build`/`status`/`clean`/`verify`. |
| `leina doctor [<dir>]` | Health diagnostics (Node, share, symlinks, project). Read-only. |
| `leina repair [<dir>]` | Fixes what `doctor` found broken (only on previous installations). |
| `leina verify [<dir>]` | Same checks as `doctor` with an actionable exit code (CI gate). |
| `leina tui` | Interactive console: install/update, init/deinit, status, repair, env. |
| `leina events tail [dir]` | Local event outbox (off unless `LEINA_EVENTS_PERSIST=1`). |
| `leina capabilities list` | The 17 transport-agnostic capabilities with their schemas. |

`memory save`/`update`/`get` accept `--batch` (JSON array via stdin; `--atomic` on save/update).

### A.2 — Troubleshooting

If something isn't working — command not found, "No graph at ...", stale graph, failing tests — the recipe is always the same:

1. Position yourself at the **root of the leina repository** (where you cloned/installed the tool).
2. Open your AI right there and **tell it the problem with the exact error message**.

With the tool pointed at its own repo, the AI has the code, the skills and the project's memory at hand, so in the vast majority of cases it diagnoses and fixes it on its own (Node version, binary not on PATH, project without a `build`, `refuse` posture, etc.).

Quick fixes at hand:

- `command not found: leina` → not on the PATH; reinstall with `npm install -g @kolimar/leina` or use `npm run cli -- <cmd>` from the clone.
- `No graph at <...>` → you haven't run `leina build <dir>` for that project.
- `Graph is stale (...) posture "refuse"` → run `leina refresh <dir>`.

#### Windows + Git Bash — `Cannot find module '...\dist\cli\index.js'`

Typical symptom on Windows when the command is run **from Git Bash**: after a correct `npm i -g`, `leina` dies with a `MODULE_NOT_FOUND` pointing to a path with the Git root prepended, for example:

```
Error: Cannot find module 'C:\Program Files\Git\Users\<user>\AppData\Roaming\npm\node_modules\leina\dist\cli\index.js'
```

**This is not a package problem** (`leina doctor` confirms this with the _CLI entrypoint_ check). It's that the POSIX shim npm generates resolves its own `$0` incorrectly under MSYS/Git Bash, and MSYS expands it by prepending `C:\Program Files\Git`. Solutions (any of them works):

1. **Run it from cmd.exe or PowerShell** (not Git Bash). There, npm uses the `.cmd`/`.ps1` shims, which resolve the path correctly:
   ```cmd
   leina --help
   ```
2. **Call node directly** on the installed file (skips the shim entirely):
   ```cmd
   node "%APPDATA%\npm\node_modules\leina\dist\cli\index.js" --help
   ```
3. **Wrapper in `~/.bashrc`** if you want to keep using Git Bash:
   ```bash
   leina() { node "$APPDATA/npm/node_modules/leina/dist/cli/index.js" "$@"; }
   ```

> Lifecycle commands (`leina setup`/`activate`/`init`) detect Git Bash on Windows, and `leina doctor` adds a _shell interop_ check (warn) that reprints this same recipe with the exact path of your installation. (The package intentionally doesn't use `postinstall`: pnpm and bun skip dependency scripts by default.)

### A.3 — How information flows (short mental model)

- **The graph** is built **locally** and lives at `<your-project>/.leina/graph.db`. It's a structural index of the code (what calls what, what imports what, what inherits from what). When you ask the AI _"what breaks if I touch this?"_, it isn't re-reading the repo: it runs `leina affected`, which queries that graph. It rebuilds itself automatically when it detects the sources changed.
- **The memory** lives in a **global** DB, at `~/.leina/memory.db` (respects `$LEINA_HOME`), partitioned by a derived project key — meaning it's shared across all your repos, not per-project. That's where decisions, bugfixes, discoveries and SDD artifacts are stored. The AI writes with `leina memory save` and reads with `leina memory context`/`search`/`verified`. (A legacy per-repo `memory.db` can be migrated to the global one with `leina memory migrate <dir>`.)
- **There's no intermediate bridge**: the AI runs the `leina` binary through its shell, receives a bounded response (a subgraph or a handful of observations) and stops grepping the entire repo.

#### What about team memory? Is it committed or not?

The project's `.leina/` folder (which contains `graph.db`) **is not committed by default** — it's runtime, it's heavy, and the graph regenerates itself. The memory **doesn't live there**: it's in the global DB `~/.leina/memory.db`. What **is** committed is the configuration (`AGENTS.md`, `.gitignore`, `.devin/hooks.v1.json`) so that anyone who clones the repo starts out with leina active. If you want to share the graph with the Devin cloud VM, you can commit the portable artifact: `leina build . --json` generates `.leina/graph.json` (committable, unlike the `.db`).
