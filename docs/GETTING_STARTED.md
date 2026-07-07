# Getting started

New to leina? Follow this top to bottom — the whole thing is three commands and a couple of
questions.

> 🌐 **Prefer a Q&A-style walkthrough in Spanish** ("what can I ask the AI"), plus a full SDD
> tour? See [`docs/guides/usage-guide.md`](guides/usage-guide.md).

**leina is a CLI.** There's no server to run. You install it once, point it at a codebase to
build a **knowledge graph** (what depends on what, what breaks if you touch something), and get a
**project memory** (decisions, bug root-causes, discoveries) that survives across sessions. Your AI
host — Devin, Claude Code, Cursor, Windsurf — then reasons over that structure instead of re-reading
the repo every conversation.

> **One placeholder used below** — replace it with your real path:
> - `<your-project>` — the absolute path to the codebase you want the AI to understand
>   (e.g. `/home/you/my-app`, or `D:\work\my-app` on Windows).

---

## Quickstart

Three commands and you're done:

```bash
npm install -g @kolimar/leina        # 1. install (needs Node 22.13+, 24+ recommended)
leina tui                            # 2. pick "install" → choose your AI host + MCP
leina build <your-project>           # 3. build the graph of your code
```

That's it — your AI now knows your codebase. Optionally, `leina visualize <your-project>` to
*see* the graph in your browser. The rest of this guide explains each step and what to ask your AI.

---

## 1. Install Node 22.13+ (Node 24+ recommended)

```bash
node --version      # must be v22.13.0 or higher
```

leina uses the built-in `node:sqlite` (no native deps) and runs TypeScript directly — no build
step. Node 22.13.0 is the minimum; **Node 24+ is strongly recommended** — on 22/23 memory search
runs in degraded LIKE mode (substring match, no BM25 ranking) and prints a warning on every
`memory` command. Upgrade with `fnm install 24 && fnm use 24`, `nvm install 24 && nvm use 24`, or
download from https://nodejs.org.

## 2. Install leina and run the setup console

```bash
npm install -g @kolimar/leina
leina tui
```

`leina tui` is the interactive home base — you drive the whole setup from a menu instead of
memorizing flags. Pick **install** and it walks you through:

- **which asset groups** to install (skills, agents, hooks — `core` is always included);
- **which AI hosts** to link the skills/agents into — **Devin** and **Claude Code**, the two hosts
  that consume leina's skill/agent files natively;
- **blanket mode** — every repo auto-wires itself with a one-time consent prompt, so you never
  set up a project by hand again;
- **MCP registration** — expose leina's tools (`graph_affected`, `memory_search`, …) as native
  tools to **Claude Code, Cursor, Windsurf** — and, by hand, to *any* MCP-capable AI (Codex, Gemini
  CLI, LM Studio, …; see step 7).

The same TUI later manages everything: **status** (health summary), **this project**
(init/deinit + per-repo `.mcp.json`), **repair**, **env vars** (masked credentials for skills),
and **uninstall**. Every action maps to a non-interactive command, so nothing here is TUI-only.

> **Prefer one command with no prompts?** `leina setup` does the recommended install
> (all assets + blanket mode) in one shot; add `--mcp` to register the MCP server too. Undo it
> all later with `leina disable`.

Verify it landed:

```bash
leina --help
leina doctor        # checks Node version, the global share, and host links
```

## 3. Point leina at your project

```bash
leina build <your-project>
```

This writes `<your-project>/.leina/graph.db` — that `.db` file **is** the graph. You rarely
rebuild by hand: queries auto-rebuild a stale graph before answering, and the installed hooks
refresh it after edits.

> ✅ Sanity check: `leina stats <your-project>` should print node/edge counts. `0 nodes` means the
> path is wrong or the project has no supported files.

**Opting a project in.** With blanket mode on (from step 2), you don't do this by hand — the first
time you use your AI in a repo it asks once, *"use leina here?"*, and wires it for you. Each repo
keeps a local, git-ignored consent flag (`.leina/consent`): `unknown` → asked once, `enabled` → on,
`disabled` → silent. leina never builds a graph in a repo you haven't opted into. To do it
manually: `leina init <your-project>` (add `--build` to build now) / `leina deinit <your-project>`.

## 4. See your code as a graph

Two **different** tools render the graph — they look alike (same viewer) but are not
interchangeable. Pick by what you need:

**`leina visualize`** — exports a **static, self-contained HTML file** you can share, commit, or
open offline forever:

```bash
leina visualize <your-project>          # writes <your-project>/.leina/graph.html
```

Nodes grouped and coloured by layer, sized by how connected they are, the top "god nodes" labelled.
Click a node for its detail drawer; search, filter by folder, freeze the physics. It's a *snapshot*
of one project — great for onboarding or sending someone the real architecture.

**`leina graph serve`** — runs a **live, local server** with things a static file can't have: a
**multi-project selector** and each node's **anchored memory** (drift-badged):

```bash
leina graph serve <your-project>        # read-only HTTP explorer at http://127.0.0.1:7423 (Ctrl+C to stop)
```

|  | `leina visualize` | `leina graph serve` |
|---|---|---|
| Output | a `.html` **file** | a running **server** (`:7423`) |
| Lives | forever, offline | only while the process runs |
| Scope | the one project you pass | every built project (a selector) |
| Shows memory | no | yes — per node, drift-badged |
| Share / commit | yes (it's a file) | no (loopback-only) |
| Reach for it when | sharing a snapshot, onboarding, offline | browsing live, inspecting memory, many repos |

## 5. Query the graph

```bash
leina affected <your-project> "GraphStore"      # blast radius: who depends on it
leina query <your-project> "how does the CLI reach the database"
leina path <your-project> "run" "GraphStore"    # shortest path between two symbols
leina status <your-project>                     # is the graph stale vs the code?
leina stats <your-project>                      # node/edge counts + confidence
leina refresh <your-project>                    # force a full rebuild
```

`query` / `affected` / `path` route through the **freshness gate**: under the default `auto`
posture they rebuild a stale graph before answering; under `refuse` they tell you to run `refresh`
first (use `refuse` for committed-graph / CI setups).

## 6. Project memory (the *why*)

Memory persists decisions, bug root-causes and discoveries to a **global** DB at
`~/.leina/memory.db` (honoring `$LEINA_HOME`), partitioned by a derived project key — so it survives
across sessions and is shared across all your repos.

```bash
leina memory save <your-project> --title "..." --content "..." [--type decision] [--anchors Sym1,Sym2]
leina memory search <your-project> "a question"
leina memory verified <your-project> "a question"   # drift-checked: USABLE / WARNING / DO-NOT-USE
leina memory context <your-project>                 # recent sessions + latest observations
leina memory session <your-project> --content "session summary"
```

`--anchors` links a note to real graph symbols, so `memory verified` can re-check it against the
live graph later — if the anchored code changed, the note is flagged stale instead of trusted
silently.

## 7. Connect it to your AI

leina reaches your AI two ways. **MCP is the universal path — start there, and wire only the
host(s) you actually use.**

### A. MCP server — works with any MCP-capable AI (recommended)

leina ships a standard MCP server, launched over stdio as `leina mcp`. Any host that speaks MCP
calls its tools (`graph_affected`, `memory_search`, `graph_visualize`, …) natively — no shell
protocol needed.

**Hosts leina wires for you** — one command (or pick "MCP" in `leina tui`, or `leina setup --mcp`):

```bash
leina mcp register --hosts claude,cursor,windsurf   # list only the ones you use
leina mcp status                                    # per-host: registered or not
leina mcp unregister --hosts cursor                 # inverse
```

**Any other host** — add leina to that host's own MCP config. The server entry is always the same
command; only the file and the wrapping key differ. Most hosts use the standard `mcpServers` shape:

```json
{ "mcpServers": { "leina": { "command": "leina", "args": ["mcp"] } } }
```

| Host | Add it with | Config file · key |
|---|---|---|
| Claude Code | `leina mcp register --hosts claude` (or `claude mcp add --scope user leina -- leina mcp`) | `~/.claude.json` / project `.mcp.json` · `mcpServers` |
| Cursor | `leina mcp register --hosts cursor` | `~/.cursor/mcp.json` or `.cursor/mcp.json` · `mcpServers` |
| Windsurf | `leina mcp register --hosts windsurf` | `~/.codeium/windsurf/mcp_config.json` · `mcpServers` |
| VS Code (Copilot) | `code --add-mcp '{"name":"leina","command":"leina","args":["mcp"]}'` | `.vscode/mcp.json` · **`servers`** † |
| OpenAI Codex CLI | `codex mcp add leina -- leina mcp` | `~/.codex/config.toml` · **`[mcp_servers.leina]`** (TOML) † |
| Gemini CLI | `gemini mcp add leina leina mcp` | `~/.gemini/settings.json` or `.gemini/settings.json` · `mcpServers` |
| LM Studio | edit config, then restart the app | `~/.lmstudio/mcp.json` · `mcpServers` |
| Zed | Agent Panel → Add Custom Server, or edit settings | `~/.config/zed/settings.json` or `.zed/settings.json` · **`context_servers`** † |
| Cline (VS Code) | MCP Servers icon → Configure | Cline's `cline_mcp_settings.json` · `mcpServers` |
| JetBrains AI Assistant / Junie | Settings → Tools → AI Assistant → MCP, or Junie's `mcp.json` | `~/.junie/mcp/mcp.json` / `.junie/mcp/mcp.json` · `mcpServers` |

† Three hosts wrap it differently — same command/args, different shape:

```jsonc
// VS Code — key is `servers`, add "type": "stdio"
{ "servers": { "leina": { "type": "stdio", "command": "leina", "args": ["mcp"] } } }
```
```toml
# OpenAI Codex — ~/.codex/config.toml
[mcp_servers.leina]
command = "leina"
args = ["mcp"]
```
```jsonc
// Zed — key is `context_servers`, add "source": "custom"
{ "context_servers": { "leina": { "source": "custom", "command": "leina", "args": ["mcp"], "env": {} } } }
```

Once registered, just ask — *"what's the blast radius of `GraphStore`?"* — and the AI calls
`graph_affected` on its own. Each tool takes a `root` argument, defaulting to the directory the host
launched the server in. (Config formats move fast — if a host rejects the entry, check its current
MCP docs; the launch command `leina mcp` never changes.)

### B. Hooks — automatic session context (Devin & Claude Code only)

On top of MCP, two hosts can auto-**inject** recent memory + graph status at the start of every
session (and keep the graph fresh after edits), so the AI knows the project before you type — no
tool call needed:

- **Devin** reads the committed `AGENTS.md` + `.devin/hooks.v1.json` automatically (cloud + CLI).
  For Devin cloud (a VM), make `leina` available in the snapshot via Repository Setup →
  *Install Dependencies* (`npm install -g @kolimar/leina`).
- **Claude Code** gets the same via `.claude/settings.json` — `leina init <your-project>
  --claude-hooks` (or when you pick Claude Code during install).

Every other host lacks a hooks mechanism, so it can't auto-inject — but through MCP the agent pulls
the same context on demand (`memory_context`, `graph_status`). That's why MCP is the path we
recommend for everyone.

For a committed graph (CI, or sharing with Devin cloud), run `leina build . --json` and commit
`.leina/graph.json` — the `.db` is git-ignored; the portable `.json` is what you commit — then
`init` with `--freshness refuse`.

---

> **Contributing to leina itself, or running unreleased code?** That's the only reason to work
> from a clone instead of the global install — the dev setup (`git clone`, `npm install`,
> `npm run cli -- <cmd>`) lives in [`CONTRIBUTING.md`](../CONTRIBUTING.md), not here.

---

## Troubleshooting

**`command not found: leina`**
- The global install isn't on PATH; reinstall with `npm install -g @kolimar/leina`, or use the
  clone form (`npm run cli -- <cmd>`).

**`No graph at <...>` when running a query**
- You didn't `build` that project yet (step 3): `leina build <your-project>`.

**`Graph is stale (...) but freshness posture is "refuse"`**
- You ran `init --freshness refuse`. Rebuild explicitly: `leina refresh <your-project>`.

**`No node matches "..."` from `affected`/`path`**
- Labels are matched by display label; functions show as `name()`. Check `leina stats` or try a
  different casing, e.g. `affected . "GraphStore"`.

**C# / Java calls look syntactic / low EXTRACTED**
- These get compiler-grade resolution from the semantic sidecars (Roslyn for C#, JavaParser for
  Java). Build one on demand with `leina sidecar build [csharp|java]`, which caches a self-contained
  binary under `~/.leina/sidecars/<lang>/dist` (no .NET/JVM needed to run it afterwards). Without a
  sidecar the language falls back to tree-sitter and still builds — just syntactically. See the
  README's "Semantic sidecars" section.
