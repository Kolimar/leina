# Leina Memory Artifact Convention

Critical leina memory commands (`memory search`, `memory save`, `memory get`) are
inlined directly in each skill's `SKILL.md`. This document is supplementary reference.

> **CLI.** Memory is accessed exclusively through the `leina memory <sub>` CLI.
> Every command takes an explicit `<dir>` (the project root,
> default `.`). The full command/flag reference lives in `docs/CLI_REFERENCE.md`.

## Naming Rules

All SDD artifacts persisted to memory follow deterministic naming:

```text
--title  sdd/{change-name}/{artifact-type}
--topic  sdd/{change-name}/{artifact-type}
--type   architecture
--scope  project
```

`--topic` (the topic key) is what enables upserts: saving again with the same `--topic`
evolves the existing entry in place instead of duplicating it.

### Artifact Types

| Artifact Type | Produced By | Description |
|---------------|-------------|-------------|
| `explore` | sdd-explore | Exploration analysis |
| `proposal` | sdd-propose | Change proposal |
| `spec` | sdd-spec | Delta specifications |
| `design` | sdd-design | Technical design |
| `tasks` | sdd-tasks | Task breakdown |
| `apply-progress` | sdd-apply | Implementation progress |
| `verify-report` | sdd-verify | Verification report |
| `archive-report` | sdd-archive | Archive closure with lineage |
| `state` | orchestrator | DAG state for recovery after compaction |

### State Artifact

```bash
leina memory save <dir> \
  --title "sdd/{change-name}/state" \
  --topic "sdd/{change-name}/state" \
  --type architecture \
  --content "change: {change-name}\nphase: {last-phase}\nartifact_store: memory\n..."
```

Recovery: `leina memory search <dir> "sdd/{change-name}/state"` → take the `#id` →
`leina memory get <dir> <id>` → parse YAML → restore state.

## Recovery Protocol

`memory search` returns snippets. Retrieve complete content before acting:

```text
Step 1: leina memory search <dir> "sdd/{change-name}/{artifact-type}"  → #id
Step 2: leina memory get <dir> <id>                                    → full content
```

When verifying remembered context against the live graph, prefer
`leina memory verified <dir> "<query>"` — it classifies each hit as
USABLE / WARNING / DO-NOT-USE (drift detection).

## Writing Artifacts

```bash
leina memory save <dir> \
  --title "sdd/{change-name}/{artifact-type}" \
  --topic "sdd/{change-name}/{artifact-type}" \
  --type architecture \
  --content "{full markdown content}"
```

Use `leina memory update <dir> <id>` when you have the exact id. Use
`memory save` with the same `--topic` for upserts.

## Batch Calls

When saving, reading, or updating N observations, **prefer a single batch call** over N
sequential round-trips. The CLI batch form is the `--batch` flag with a JSON array on
**stdin**:

```bash
# Save multiple at once (--atomic for all-or-nothing). Each item:
#   {title, content, type?, topicKey?, scope?, anchors?}
echo '[{"title":"sdd/X/spec","topicKey":"sdd/X/spec","type":"architecture","content":"..."},
       {"title":"sdd/X/design","topicKey":"sdd/X/design","type":"architecture","content":"..."}]' \
  | leina memory save <dir> --batch --atomic

# Read multiple at once — JSON array of id strings on stdin:
echo '["id1","id2","id3"]' | leina memory get <dir> --batch

# Update multiple at once — items: {id, title?, content?, type?, anchors?}
echo '[{"id":"id1","content":"..."}]' | leina memory update <dir> --batch --atomic
```

For graph reads there is no per-node batch API; use `leina query`,
`leina affected`, or `leina path` (each returns the relevant subgraph).

### Typical SDD artifact loading pattern

Run the searches you need, collect the `#id`s from the hits, then batch-retrieve full content:

```bash
# Step 1: search each artifact, note the #id from each result
leina memory search <dir> "sdd/{change}/spec"
leina memory search <dir> "sdd/{change}/design"
leina memory search <dir> "sdd/{change}/tasks"

# Step 2: batch-retrieve full content in one call
echo '["specId","designId","tasksId"]' | leina memory get <dir> --batch
```

## Upsert Behavior

The same `--topic` + project + scope updates the working-memory entry. For iteration history
or team collaboration, use `openspec` or `hybrid` mode.

## Why This Convention

- Deterministic titles make recovery reliable.
- `--topic` (topic key) enables upserts without duplicates.
- The `sdd/` prefix namespaces SDD artifacts.
- Two-step recovery prevents truncated snippets from being treated as full data.
- Archive reports preserve lineage.
