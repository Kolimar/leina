# SDD Phase — Common Protocol

Boilerplate shared across SDD phase skills. Each phase agent is an executor, not
an orchestrator: do the work yourself and do not launch sub-agents.

> All memory/graph access is through leina. Commands are shown as `leina ...` CLI; if
> `mcp__leina__*` tools are available, prefer the matching tool (same parameters —
> mapping in `skills/_shared/cli-utilities.md`). Phase-by-phase cheat sheet: that same file.

## 0. MANDATORY preamble (every phase, before anything else)

These two rules apply unconditionally to **every** SDD phase, whether launched by the
`leina-sdd` orchestrator or invoked directly. Do them before Section A.

### 0.1 Language

Detect the user's language from the brief / conversation / existing artifacts and **write all
user-facing prose and artifact CONTENT in that language** (default to it for any question you
ask the user too). KEEP in English, always: `topic_key`s and artifact slugs
(`sdd/{change}/proposal`), identifiers, file paths, CLI commands/flags, and code. Never
translate a `topic_key` — only the human-readable body.

### 0.2 Context bootstrap — never start blind

You are a stateless executor: you do NOT see the conversation that led here. Before asking the
user *anything*, reconstruct the brief yourself:

1. If the orchestrator (or `$ARGUMENTS`) gave you a brief, change-name and/or artifact ids, use
   them — that is your context. Skip to Section A.
2. Otherwise (direct/manual invocation with empty `$ARGUMENTS`), DERIVE the brief. Memory is
   AUTHORITATIVE — never guess from the filesystem/repo layout before you have searched it:
   - **MANDATORY FIRST ACTION** — run `leina memory search <dir> "<change-name>"` (and, if
     thin, `leina memory context <dir>`). Do this BEFORE forming any hypothesis about what
     the change is. A confident guess from the repo (e.g. "there's a `docs/` folder, so docs-index
     must mean a docs README") is a FAILURE mode: it produces a plausible-but-wrong artifact.
   - If the search returns a matching `sdd/{change}/*` (especially `explore` or a prior `proposal`)
     or a `backlog/{change}` entry, you MUST `leina memory get <dir> <id>` it and treat its
     content as the AUTHORITATIVE brief. Do NOT override it with your own interpretation of the
     repo. These artifacts ARE the change — your job is to advance them, not re-invent them.
   - Layer in whatever the user said in the current turn on top of that authoritative brief.
3. Decision gate before writing:
   - Memory HAD a matching artifact → proceed using it as the brief (no need to ask).
   - Memory returned NOTHING for the change → it is a genuinely NEW change. State that explicitly,
     give your one-line interpretation of the scope, and ask the user ONE focused confirming
     question (in their language) BEFORE writing the artifact. Do not silently invent scope.
   - Never open with a bare "what do you want to do?" when memory or the conversation already
     answers it.

## A. Skill Loading

1. If the orchestrator injected `## Project Standards (auto-resolved)`, follow
   those rules.
2. Otherwise use exact `SKILL: Load` instructions when present.
3. Otherwise search `skill-registry` through `leina memory search <dir> "skill-registry"`,
   retrieve its complete content through `leina memory get <dir> <id>`, then fall back
   to `.leina/skill-registry.md`.
4. If no registry exists, proceed with the phase skill only.

## B. Artifact Retrieval (Leina Memory Mode)

`leina memory search` returns previews. Call `leina memory get <dir> <id>` for
every artifact before acting on it. Run the searches you need, then batch-retrieve full
content in one call.

**Batch tip:** when a phase needs multiple artifacts (e.g. spec + design + tasks), run the
searches, collect each `#id`, then retrieve all of them in a single batch `get`:

```bash
leina memory search <dir> "sdd/{change-name}/spec"
leina memory search <dir> "sdd/{change-name}/design"
leina memory search <dir> "sdd/{change-name}/tasks"
```

After collecting all IDs from the hits, batch-retrieve with a JSON array of id strings on
stdin:

```bash
echo '["specId","designId","tasksId"]' | leina memory get <dir> --batch
```

To check remembered context against the live graph, use
`leina memory verified <dir> "<query>"` (USABLE / WARNING / DO-NOT-USE).

## C. Artifact Persistence

Every phase that produces an artifact must persist it. The modes below are
summaries — mode resolution, defaults, state persistence and the orchestrator
prompt templates live in `skills/_shared/persistence-contract.md`.

### Memory mode

```bash
leina memory save <dir> \
  --title "sdd/{change-name}/{artifact-type}" \
  --topic "sdd/{change-name}/{artifact-type}" \
  --type architecture \
  --content "{your full artifact markdown}"
```

### OpenSpec mode

Write the defined file.

### Hybrid mode

Write the file and save the Leina memory artifact.

### None mode

Return inline only.

## D. Return Envelope

Return a structured result with exactly these fields:

- `status`: `done` | `blocked` | `partial`
- `executive_summary`: one sentence on what the phase produced
- `artifacts`: memory topics and/or file paths written
- `next_recommended`: the next phase to run (or the same phase again if work remains)
- `risks`: deviations, open questions, or blockers
- `skill_resolution`: `injected` if compact rules were provided in the invocation message, otherwise `none`

Each phase's agent states only its phase-specific values for `executive_summary`
and `next_recommended`; the field set above is the single source of truth.

## E. Review Workload Guard

- Default PR review budget: 400 changed lines.
- Forecast risk before apply.
- Recommend chained PR slices for oversized work.
- Every slice must have clear scope, verification, and rollback.
