# Persistence Contract (shared across all SDD skills)

## Mode Resolution

The orchestrator passes `artifact_store.mode` with one of:
`memory | openspec | hybrid | none`.

Ask the user which mode they want when `/sdd-new`, `/sdd-ff`, or
`/sdd-continue` is invoked for the first time in a session. Cache the choice for
the session.

Default: if Leina memory is available, use `memory`. Otherwise use `none`.

## Mode Roles

- **`memory`**: Leina working memory between sessions. Upserts overwrite.
- **`openspec`**: Files in repo with git history and a full team audit trail.
- **`hybrid`**: Leina memory plus OpenSpec files. Higher token cost.
- **`none`**: Ephemeral. Lost when the conversation ends.

| Mode | Read from | Write to | Project files |
|------|-----------|----------|---------------|
| `memory` | Leina memory | Leina memory | Never |
| `openspec` | Filesystem | Filesystem | Yes |
| `hybrid` | Leina memory, then filesystem fallback | Both | Yes |
| `none` | Orchestrator prompt context | Nowhere | Never |

## Leina Memory Limitation

Leina memory uses `--topic`-based upserts. Re-running a phase for the same
change overwrites its working-memory artifact. For full iteration history or
team collaboration, use `openspec` or `hybrid`.

## Hybrid Mode

Persist every artifact to BOTH Leina memory and OpenSpec. Read Leina
memory first and fall back to filesystem. Both writes must succeed.

## State Persistence

| Mode | Persist State | Recover State |
|------|---------------|---------------|
| `memory` | `leina memory save <dir> --topic "sdd/{change-name}/state" ...` | `leina memory search <dir> "sdd/{change-name}/state"` → `memory get <dir> <id>` |
| `openspec` | Write `openspec/changes/{change-name}/state.yaml` | Read that file |
| `hybrid` | Both | Leina memory first; filesystem fallback |
| `none` | Not possible | Not possible |

## Common Rules

- `none`: do not create or modify project files.
- `memory`: persist to Leina memory; do not write project files.
- `openspec`: write only paths defined in `openspec-convention.md`.
- `hybrid`: persist to BOTH Leina memory and filesystem.
- Never force `openspec/` creation unless the orchestrator passed `openspec` or
  `hybrid`.

## Sub-Agent Context Rules

All memory access is through leina memory: the `mcp__leina__memory_*` tools when the
host exposes them, else the `leina memory` CLI (same parameters — mapping in
`cli-utilities.md`). See `docs/CLI_REFERENCE.md` for the full command/flag surface.

- Non-SDD tasks: orchestrator searches Leina memory and passes relevant
  context. Sub-agent saves discoveries through `leina memory save`.
- SDD tasks with dependencies: sub-agent reads artifacts through
  `leina memory search` → `leina memory get`, then saves its artifact.
- SDD tasks without dependencies: sub-agent saves its artifact.

## Orchestrator Prompt Instructions for Sub-Agents

```text
PERSISTENCE (MANDATORY):
If you make important discoveries, decisions, or fix bugs, save them before
returning:
  leina memory save <dir> \
    --title "{short description}" \
    --type {decision|bugfix|discovery|pattern} \
    --content "{What, Why, Where, Learned}"
(If mcp__leina__* tools are available, use memory_add instead of the CLI form.)
```

```text
Artifact store mode: {memory|openspec|hybrid|none}
Read dependencies with:
  leina memory search <dir> "<query>"  →  leina memory get <dir> <id>
Persist SDD artifacts with:
  leina memory save <dir> --topic "sdd/{change-name}/{artifact-type}" ...
(If mcp__leina__* tools are available, use memory_search / memory_get / memory_add
instead of the CLI forms.)
```

**Batch tip:** when retrieving multiple artifact IDs, prefer a single
`echo '["id1","id2",...]' | leina memory get <dir> --batch` over N sequential
`memory get` calls. When saving N observations, pipe a JSON array to
`leina memory save <dir> --batch` (add `--atomic` for all-or-nothing).
Via MCP: pass `ids` to `memory_get`, or `items` (+`atomic`) to `memory_add`.

## Skill Registry

The orchestrator injects compact project standards into sub-agent prompts.
Generate or update the registry with `sdd-init` (see the skill-registry scan
rules in its `references/init-details.md`).
