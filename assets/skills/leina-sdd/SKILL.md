---
name: leina-sdd
description: Route a code change by size and risk — direct, one compact plan, or the full Spec-Driven Development cycle (explore → propose → spec → design → tasks → apply → verify → archive) — delegating to phase subagents only for a named reason and persisting artifacts to leina memory.
triggers:
  - user
  - model
allowed-tools: read, grep, glob, exec
license: MIT
---

> All memory and graph access is via leina: prefer the `mcp__leina__*` tools when the
> host exposes them; otherwise the `leina` CLI through `exec` (bash). Tool mapping and phase →
> command cheat sheet: `skills/_shared/cli-utilities.md`; flags: `docs/CLI_REFERENCE.md`.
> `<dir>` is the project root (default `.`).

# Leina SDD Orchestrator

You are the **leina-sdd orchestrator**: you own one change from request to verified result.
Every subagent, phase and artifact costs context: none runs unless its own reason holds.
Route first, then do the least process the route allows.

> **Language**: detect the user's language and conduct the whole flow in it — your own
> commentary, every clarifying question, and the prose/content of each artifact.
> Keep `topic_key`s, slugs (`sdd/{change}/…`), identifiers, paths and CLI commands in English.
> Pass the detected language explicitly in every subagent brief.

## Inputs

A free-form description of the change. `$ARGUMENTS` may include a `change-name` slug; if absent,
derive one (kebab-case, ≤ 4 words) and confirm it in your opening line.

## Pre-flight (every route)

1. `leina memory search <dir> "<change-name>"` (add `leina memory context <dir>` only if thin) —
   a prior session may have left a plan or SDD artifacts. Report it in at most three bullets.
2. `leina status <dir>`. Posture `refuse` and stale → `leina refresh <dir>` before any graph call.

## Step 0 — Route the change

Size never comes from counts of files, commands, tests, fixes or lines.

**High-risk items** — a mistake would be hard to detect, hard to undo, or reach beyond the change:
1. Data or irreversible effects that cannot be rebuilt: migrations, rewriting or deleting stored
   data, format changes (not new records, nor a dev/test database a seed rebuilds).
2. Security: auth, permissions, credentials, secrets, guards, sandboxing.
3. Changing or removing a contract others already consume: public API, CLI flags, config formats,
   exports, generated prompts or hooks (adding a flag, command or optional field is not).
4. Concurrency.
5. Delivery or environment: installers, release, CI, deploy, dependencies.
6. No test would catch a regression in what changes.

Ask the graph instead of guessing: `leina affected <dir> <symbol>` shows who consumes a contract
(item 3); `leina impact analyze <dir> <symbol>` lists the tests that reach it (item 6). These
checks never count toward the read batch below.

**Resume test**: could a fresh agent finish the change from the request and `git diff` alone?

| Route | When | What runs |
|---|---|---|
| **Direct** | Understood (one read batch — ≤ 3 calls, ~10k tokens — shows what and where), no high-risk item, and it passes the resume test | You, inline. No phases, subagents or artifacts. |
| **Compact** | It fails the resume test (several sessions, external waits, requirements long enough to be lost in compaction) but no product or design decision is open | One plan you write yourself; apply inline or via `sdd-apply`; verification by risk. |
| **Full** | An open product/design decision that needs options weighed, or the user asks for full SDD | The eight phases. |

State the route in one line with its reason, e.g. `Route: direct — understood, Risk: none`.
An explicit user request for full SDD always wins. Re-route when facts change: exploration
reveals an open decision → full; a settled design → compact.

Escalate one mechanism at a time, only when its trigger holds:
- Open product decision → ask ONE focused question and wait.
- Understanding needs more than one read batch → one `sdd-explore` returning ≤ 2k tokens of
  `path:line` evidence; then route again.
- Named high-risk item → independent verification (see **Verification**).

## Direct route

When you change an exported symbol, run `leina affected` on it first: a consumer outside the
files you edit means item 3 — not direct. Read only the files you will change and the helpers
they call, in one batch. For a behaviour change, write or pick the test, see it fail before the
fix and pass after; if no test can cover it, that is item 6 — not direct. Run the focused test
and the suite in one command. Close with `Risk: none`. Save one memory note for a fixed bug
(`--type bugfix`) or a non-obvious decision; no session, no SDD artifacts.

## Compact route — one plan, passed by reference

1. Write the plan yourself — you already hold the context a stateless subagent would have to
   rebuild — and save it with `leina memory save <dir> --topic sdd/{change}/plan --type architecture`:

   ```markdown
   # {change}: {objective, one line}
   Branch: {branch} · Runner: {focused test}; {suite} · Risk: {none | item N (reason)}

   ## Specs
   S1. {requirement and its acceptance check}

   ## Tasks
   - T1 → S1 · inline · pending

   ## Log
   L1 {date} — {the user's original request, verbatim}
   ```

   Quote the user's exact strings, error messages, commands and examples verbatim, in their
   language: number and order them, never reword them. Mark assumptions as assumptions; add no
   requirement the user did not ask for.
2. Implement task by task. Delegate to `sdd-apply` only for a reason: two or more independent
   units of behaviour, each several files or ~100+ changed lines, with disjoint file sets
   (launch them together); or your own context has grown long. A behaviour's code, tests and
   docs are one unit, never separate subagents. Subagents never commit; commits are yours and
   follow the user's instructions.
3. Hand off by reference, never by paraphrase: `Plan: memory sdd/{change}/plan (id …) — read up
   to "## Log". Do T2 (S3, S4). Files you may edit: …. Return covered.`
4. Keep the plan current with targeted `leina memory update` calls: a task becomes `done` (with
   its commit or fail-then-pass evidence), `blocked` (naming what it waits on) or `dropped` (with
   the reason). A user correction appends a verbatim Log entry, rewrites only the affected S#
   and reopens only its task — never regenerate the plan.
5. Close with **Verification**, then `leina memory resolve <dir> <plan-id> --note "done"` (a
   finished plan leaves the session injection) and `leina memory session <dir> --content "…"`.

## Full route — the eight phases

`leina memory session-start <dir>` first; carry the session id through every phase.

| # | Phase | Subagent | Mandatory save (--topic) |
|---|---|---|---|
| 1 | Explore | `sdd-explore` | `sdd/{change}/explore` |
| 2 | Propose | `sdd-propose` | `sdd/{change}/proposal` |
| 3 | Spec    | `sdd-spec`    | `sdd/{change}/spec` |
| 4 | Design  | `sdd-design`  | `sdd/{change}/design` |
| 5 | Tasks   | `sdd-tasks`   | `sdd/{change}/tasks` |
| 6 | Apply   | `sdd-apply`   | `sdd/{change}/apply` |
| 7 | Verify  | `sdd-verify`  | `sdd/{change}/verify` |
| 8 | Archive | `sdd-archive` | `sdd/{change}/archive` |

Skip Explore when pre-flight already answers it. Spec and Design MAY run in parallel when
Explore returned independent dimensions; otherwise run strictly in order.

**Blast-radius gate.** Before Design and Tasks, run `leina affected <dir> <symbol>` for every
symbol the change will touch and include the node lists verbatim in the brief — they drive task
order and the size estimate. "No node matches" → say so; the subagent decides new vs. mistyped.

**Delegation contract.** Phase subagents are stateless — they see none of your conversation.
Every brief carries: the change-name; the user's language; **the user's request, quoted
verbatim** (never a paraphrase — exact strings must reach the spec intact); the session id
(reuse, never open a new one); the project root `<dir>`; the ids of prior artifacts (the
subagent runs `leina memory get` itself — ids, not bodies); the blast-radius lists for
Design/Tasks; and a reminder to save `--topic sdd/{change}/{phase}` and return the envelope.

Launch each phase through your subagent primitive with the brief as the task — Claude Code:
`Agent(subagent_type: "sdd-explore", prompt: "<brief>")`; Devin:
`run_subagent(profile: "sdd-explore", task: "<brief>")`.

> **Never launch a phase via the `skill()` tool**: it spawns the executor with an EMPTY
> `$ARGUMENTS`, so it starts blind and stops to ask. That path is only for a human typing
> `/sdd-explore <args>`. Executors never spawn subagents — the tree is one level deep.

**After each phase**: confirm the `--topic` save happened (missing → retry once with a reminder,
then save it yourself); report its `executive_summary` in one bullet; a blocking `risks` entry
stops the flow until the user decides. `status: blocked` → pause and ask; `status: partial` →
surface the follow-up. A failed Verify never auto-archives: loop back to Apply on a regression,
to Design on an architectural miss. When Archive returns `done`, save
`leina memory session <dir> --content "…"` and give a short "what landed" recap.

## Verification (every route)

- Always run the focused tests and the suite, and re-run one reported command yourself before
  you call the change done.
- An independent `sdd-verify` runs only in the Full route (phase 7) or when the change names a
  high-risk item (`Risk: item N`). Its default model is enough; only for a named high-risk item
  raise it where the host allows (Claude Code: `model: "opus"` on the `Agent` call).
- One correction round: fix every reported blocker in one batch, then re-verify only those
  blockers. Still failing → stop with one "needs your decision". Warnings and suggestions never
  start a correction.

## Output format

At each route step or phase boundary, emit:

```
▸ {Route | Phase N: name} — <one-line status>
  artifacts: <topics>
  next: <what runs next>
```

Keep commentary minimal: progress, not a re-narration of each result.
