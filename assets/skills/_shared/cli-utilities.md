# leina CLI Utilities — per-SDD-phase cheat sheet

Single source of truth for **which `leina` commands each SDD phase should use**, for
both the **graph** (what the code IS) and **memory** (WHY it is that way). All SDD skills and
agents reference this file instead of duplicating command lists.

> **Dual transport**: every command below exists as `leina` CLI **and**, when the host exposes
> them, as an `mcp__leina__*` tool — **prefer the MCP tool when present** (same parameters;
> the tool's `root` = the `<dir>` argument, default: workspace root). CLI-only, by design:
> `env exec` (names-not-values), `memory session-start`, `merge-projects`, `migrate`.
> `<dir>` is the project root (default `.`). Full command/flag reference:
> `docs/CLI_REFERENCE.md`. Memory naming/upsert rules: `leina-memory-convention.md`.

## Always, at session start

```bash
leina memory context <dir>          # restore recent sessions + observations
```

(MCP: `memory_context`.)

## Graph utilities (all phases)

| Need | Command | MCP tool |
|---|---|---|
| "What relates to / depends on X?" | `leina query <dir> "<question>"` | `graph_query` |
| Blast radius before rename/migrate | `leina affected <dir> <symbol> [depth]` | `graph_affected` |
| How are A and B connected? | `leina path <dir> <a> <b>` | `graph_path` |
| Is the graph stale? | `leina status <dir>` | `graph_status` |
| Force a rebuild | `leina refresh <dir>` | `graph_build` |
| Node/edge counts + confidence | `leina stats <dir>` | `graph_stats` |
| Export the offline HTML viewer | `leina visualize <dir> [--out ..]` | `graph_visualize` (returns the file path) |

`query` / `affected` / `path` auto-rebuild a stale graph under posture `auto` before answering
(the MCP graph tools also build on first use).

## Memory utilities (all phases)

| Need | Command | MCP tool |
|---|---|---|
| Search prior context | `leina memory search <dir> "<query>"` | `memory_search` |
| Search + drift check | `leina memory verified <dir> "<query>"` | `memory_verified` |
| Read full observation | `leina memory get <dir> <id>` | `memory_get` |
| Save / upsert (by `--topic`) | `leina memory save <dir> --title .. --content .. --type .. --topic ..` | `memory_add` (`topic` param) |
| Update by id | `leina memory update <dir> <id> [--content ..]` | `memory_update` |
| Suggest a topic key | `leina memory suggest-topic <dir> --title ".."` | `memory_suggest_topic` |
| Save session summary (end) | `leina memory session <dir> --content ".."` | `memory_session` |

## Phase → recommended commands

Each phase persists its artifact with topic `sdd/{change}/{artifact}` (see
`leina-memory-convention.md`). "Read deps" = `memory search` → `memory get`.

| Phase | Graph | Memory (read) | Memory (persist) |
|---|---|---|---|
| **explore** | `query`, `affected`, `stats` to map the area | `context`, `verified "<topic>"` | `save --topic sdd/{change}/explore` |
| **propose** | `affected` on touched symbols (scope/risk) | `get` explore artifact | `save --topic sdd/{change}/proposal` |
| **spec** | `query` to ground requirements in real symbols | `get` proposal | `save --topic sdd/{change}/spec` |
| **design** | `affected` on EVERY symbol the change touches (real blast radius drives the file list) | `get` spec | `save --topic sdd/{change}/design` |
| **tasks** | `affected` + `path` to order work by dependency | `get` spec + design | `save --topic sdd/{change}/tasks` |
| **apply** | `affected` before each rename/migrate; `query` to find call sites | `get` spec + design + tasks | `save --topic sdd/{change}/apply-progress`; `save` decisions/bugfixes proactively |
| **verify** | `verified` to confirm remembered context still matches the graph | `get` spec + tasks + apply-progress | `save --topic sdd/{change}/verify-report` |
| **archive** | `stats` / `status` as a final sanity check | `get` all phase artifacts (lineage) | `save --topic sdd/{change}/archive-report` |

## Batch (any phase needing N artifacts)

```bash
# Retrieve many observations at once — JSON array of id strings on stdin:
echo '["specId","designId","tasksId"]' | leina memory get <dir> --batch

# Save many at once (--atomic = all-or-nothing):
echo '[{"title":"...","topicKey":"sdd/X/spec","type":"architecture","content":"..."}]' \
  | leina memory save <dir> --batch --atomic
```

Via MCP: `memory_get` accepts an `ids` array; `memory_add` accepts an `items` array
(plus `atomic: true` for all-or-nothing) — no stdin piping needed.
