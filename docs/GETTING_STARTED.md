# Getting started — for a first-timer

This guide assumes you've never used leina before. Follow it top to bottom.

> 🌐 **Prefer a guided, Q&A-style walkthrough in Spanish?** See
> [`docs/guides/usage-guide.md`](guides/usage-guide.md) — same ground, different angle ("what
> can I ask the AI"), plus a full SDD walkthrough.

**leina is a CLI** — there is no server to wire up. You build a graph once, then
query it (and a local project memory) through `leina` commands. An AI host like Devin
runs those same commands through its shell; the committed `AGENTS.md` tells it to.

> **Placeholders used throughout this guide** — replace them with your real paths:
> - `<leina>` — the folder where you cloned/downloaded this repo (clone form only).
> - `<your-project>` — the absolute path to the codebase you want the AI to understand
>   (e.g. `D:\work\my-app` on Windows, `/home/you/my-app` on Linux/macOS).

---

## 1. Install Node 22.13+ (Node 24+ recommended)

```bash
node --version      # must be v22.13.0 or higher
```

leina uses the built-in `node:sqlite` (no native deps) and runs TypeScript
directly — no build step needed. Node 22.13.0 is the minimum (first 22.x Active LTS
where `node:sqlite` is available without the `--experimental-sqlite` flag).

**Node 24+ is strongly recommended.** On Node 22/23, memory search runs in degraded
LIKE mode (no porter stemming or BM25 ranking — substring match only). A warning is
printed to stderr on every `memory` command. To get full-text search quality, upgrade:

```bash
# with fnm
fnm install 24 && fnm use 24

# with nvm
nvm install 24 && nvm use 24
```

Or download from https://nodejs.org.

## 2. Install and set up leina (once per machine)

**Recommended — global install.** Puts the `leina` binary on your PATH, then `setup` does
everything machine-wide in one shot — populates the skills/agents share, symlinks it into Devin's
global dirs, writes the user-global `Exec` grant + hooks, and turns on **blanket mode**:

```bash
npm install -g leina
leina setup              # the one-shot "magic" command
```

After `setup`, leina is available in every Devin session. To undo everything machine-wide later,
run `leina disable`.

**Or from a clone** (contributors, or to run the latest unreleased code):

```bash
cd <leina>
npm install
npm run cli -- setup
```

> The commands below are written as `leina <cmd>` (global install). From a clone, use
> `npm run cli -- <cmd>` instead — e.g. `npm run cli -- build <your-project>`.

> **Prefer the granular pieces?** `setup` composes `activate` (global share/symlinks/user-config,
> without blanket); its inverse is `deactivate`. `install-global` is a deprecated alias of
> `activate`.

## 3. Build the graph of YOUR project

```bash
leina build <your-project>
```

This writes `<your-project>/.leina/graph.db`. That `.db` file *is* the graph. You rarely
rebuild by hand: `query`/`affected`/`path` auto-rebuild a stale graph before answering, and the
Devin hooks `init` installs run a `refresh` after edits.

> ✅ Sanity check: `leina stats <your-project>` should print a node/edge count. If it
> says 0 nodes, the path is wrong or the project has no supported files.

---

## 4. Opt a project in — `leina init` (usually automatic)

With blanket mode on (from `setup`), **you usually don't run this by hand**. The first time you use
Devin in a repo, the `leina-setup` skill asks once — "use leina here?" — and runs `init`
(Yes) or `deinit` (No) for you. Each repo keeps a **local, git-ignored consent flag**
(`.leina/consent`): `unknown` → asked once, `enabled` → on, `disabled` → silent. leina
never builds a graph in a repo you haven't opted into.

To do it manually:

```bash
leina init <your-project> [--profile devin|windsurf] [--freshness auto|refuse] [--build] [--name <project-name>]
leina deinit <your-project>    # opt out: consent=disabled + strip the wiring back out
```

`init` is **adaptive** — it always writes the `enabled` consent flag and the `.gitignore` block,
then writes only what's needed:

- **LIGHT (blanket on):** nothing else. The machine-wide share/grant/hooks from `setup` already
  cover the repo, so `AGENTS.md` and `.devin/*` would be redundant.
- **FULL (standalone, no blanket):** also writes the committable `AGENTS.md` protocol block, the
  project-scoped `.devin/hooks.v1.json`, and a **repo-local** `Exec(leina)` grant in
  `.devin/config.json` — making the repo self-contained. It **never** touches the user-global
  `~/.config/devin/config.json`.

`init` does **no** auto-build; pass `--build` to build the graph synchronously now (otherwise it
builds on demand the first time you query). `--name <project-name>` locks the project key in a
committable `.leina/config.json`. Use `--freshness refuse` for committed-graph / CI setups
(a stale read asks for a rebuild instead of triggering one).

---

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
posture they rebuild a stale graph before answering; under `refuse` they tell you to run
`refresh` first.

## 6. Project memory (the *why*)

Memory persists decisions, bug root-causes and discoveries to a **global** DB at
`~/.leina/memory.db` (honoring `$LEINA_HOME`), partitioned by a derived project
key — so it survives across sessions and is shared across all your repos. (A legacy per-repo
`<your-project>/.leina/memory.db` can be folded into the global DB with
`leina memory migrate <your-project>`.)

```bash
leina memory save <your-project> --title "..." --content "..." [--type decision] [--topic key] [--anchors Sym1,Sym2]
leina memory search <your-project> "a question"
leina memory verified <your-project> "a question"   # drift-checked: USABLE / WARNING / DO-NOT-USE
leina memory get <your-project> <id>
leina memory context <your-project>                 # recent sessions + latest observations
leina memory update <your-project> <id> [--content "..."]
leina memory session <your-project> --content "session summary"
```

`--anchors` links an observation to real graph symbols, so `memory verified` can later re-check
each saved note against the live graph (drift detection: if the anchored code changed, the note
is flagged stale/WARNING instead of trusted silently).

**Batch (stdin JSON).** `save`, `update` and `get` accept `--batch` to collapse many
writes/reads into one process (`--atomic` for save/update):

```bash
echo '[{"title":"a","content":"x"},{"title":"b","content":"y"}]' \
  | leina memory save <your-project> --batch --atomic
echo '["id1","id2"]' | leina memory get <your-project> --batch
```

---

## 7. Use it with Devin

There's nothing to register: the committed `AGENTS.md` is read by Devin automatically (cloud +
CLI), so the usage protocol travels with the repo, and the `.devin/hooks.v1.json` `init` writes
keeps the graph fresh after edits and nudges the agent toward the CLI. Just ask Devin questions
about the codebase — e.g. *"what's the blast radius of `GraphStore`?"* — and it will run
`leina affected` / `query` on its own.

For Devin (cloud, runs in a VM), make `leina` available in the VM snapshot via
Repository Setup → *Install Dependencies* (e.g. `npm install -g leina`). For a committed
graph, run `leina build . --json` and commit `.leina/graph.json` (the `.db` is
git-ignored; the portable `graph.json` is what you commit) and `init` with `--freshness refuse`.

---

## Troubleshooting

**`command not found: leina`**
- The global install isn't on PATH; reinstall with `npm install -g leina`, or use the
  clone form (`npm run cli -- <cmd>` from `<leina>`).

**`No graph at <...>` when running a query**
- You didn't `build` that project yet (step 3): `leina build <your-project>`.

**`Graph is stale (...) but freshness posture is "refuse"`**
- You ran `init --freshness refuse`. Rebuild explicitly: `leina refresh <your-project>`.

**`No node matches "..."` from `affected`/`path`**
- Labels are matched by display label; functions show as `name()`. Check `leina stats`
  or try a different casing, e.g. `affected . "GraphStore"`.

**C# / Java calls look syntactic / low EXTRACTED**
- These get compiler-grade resolution from the semantic sidecars (Roslyn for C#, JavaParser for
  Java). Their sources ship as `.tmpl` templates; build one on demand with
  `leina sidecar build [csharp|java]`, which caches a self-contained binary under
  `~/.leina/sidecars/<lang>/dist` (no .NET/JVM needed to run it afterwards). Without a
  sidecar the language falls back to tree-sitter and still builds — just syntactically (~23% of
  C# / ~15% of Java call edges stay AMBIGUOUS). Override the binary location with
  `LEINA_CSHARP_SIDECAR` / `LEINA_JAVA_SIDECAR`. See the README's "Semantic
  sidecars" section.
