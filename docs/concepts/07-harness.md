# The harness — rules with executable gates

> **The employee:** the **site inspector**. The cartographer knows what the code IS, the
> librarian knows WHY it got that way — the inspector makes sure a job is **declared
> before it starts and verified before it is called done**. Unlike the concierge (the
> hooks, who only leave notes), the inspector can refuse to sign off.

---

## Why a harness

Instructions to an agent ("run the tests", "stay in scope", "don't commit secrets") are
text — the model can ignore, forget, or rationalize around them. The harness turns each
of those instructions into two coupled halves:

- a **markdown body** the model reads (the *why* and the *how*), and
- an optional **gate** the machine executes (the *proof*).

"The tests must pass" stops being prose and becomes `npm test` exiting 0, checked by a
process the model cannot argue with. That is the entire design in one sentence: **advice
for the model, evidence for the machine.**

## The model

### Rules

A rule is a markdown file with JSON frontmatter, resolved from three layers:

| layer | where | wins over |
|---|---|---|
| `builtin` | shipped with leina (`assets/harness/rules/`) | — |
| `project` | `<repo>/.harness/rules/` | builtin |
| `user` | `~/.leina/harness/rules/` | project — **except weakening** |

Each rule declares an `id` (`namespace/slug`), a lifecycle `phase`
(`intake → plan → execute → verify → deliver`), a `severity` (`blocking` | `advisory`),
an optional `scope` (`paths`, `taskTypes`, `languages`) and zero or more gates.

**The enforceability invariant:** a user-local layer can *replace* a project rule, but it
can never **disable** a blocking rule or **demote** it to advisory. The attempt is
ignored with a warning. Guardrails that any layer could switch off would not be
guardrails.

### Gates

Six executable gate types, run by an engine with a bounded parallel pool, per-gate
timeouts and **fail-closed** semantics (`fail`, `error` and `timeout` all count as a
blocking failure when the rule is blocking):

| gate | proves |
|---|---|
| `command` | a shell command exits with the expected code (and stdout matches, optionally) |
| `file` | a file exists / matches / has minimum size (e.g. `plan.md` before coding) |
| `diff` | the git diff stays inside the contract's declared scope |
| `diff-content` | no **added** line matches a forbidden pattern (secrets, `.only`/`.skip`) — including in files not yet `git add`-ed |
| `checklist` | every acceptance criterion is checked off |
| `js` | anything else — a repo-local module returns `{ pass, message }` |

`onlyIfChanged` globs let a gate skip itself when nothing relevant changed, which keeps
`verify` fast on docs-only tasks.

### The contract

The piece that inverts the burden of proof. Before a non-trivial task, the agent (or
you) declares:

```bash
leina harness contract new --goal "Add the export endpoint" --type feature \
  --scope "src/routes/**" --scope "test/**" \
  --criterion "endpoint covered by a failing-first test"
```

The contract records the git HEAD at declaration time (`baseRef`). From then on the
agent's **own declaration is the objective boundary**: the `diff` gate fails on any file
outside the declared scope, and widening the scope requires an explicit
`contract edit --add-scope` — visible, auditable, never silent. Closing the task
(`contract end`) archives the whole state to `.harness/state/history/`.

The declaration happens *before* the work, when there is no incentive to cheat; the
verification happens *after*, when there is no way to.

### Recipes

Golden-path procedures (`add-endpoint`, `fix-bug`) — parameterized step lists that start
with a contract and end with `verify` + `contract end`. Only their terminal gates are
enforceable; their value is variance reduction: the agent follows a known-good sequence
instead of improvising one.

## The completion wall

`leina harness verify` is the single oracle, with an exit-code contract every transport
shares:

- `0` — every blocking gate passed; the task may be called complete;
- `1` — blocking failure; the report says exactly what and why;
- `2` — the harness itself is misconfigured (invalid rule, broken config).

On hosts with hooks, the **stop hook** runs verify when the agent tries to end its turn:
failures come back as the agent's next instruction (block), up to `maxRetries` times —
and then it **yields honestly**: "allowing stop so a human can look", never a fake green.
The pre-bash hook refuses `git commit` / `git push` while blocking gates are failing, and
the pre-edit hook keeps the agent inside the contract scope.

**Integrity boundary — and the threat model, stated honestly:** `.harness/rules/`,
`.harness/config.json` and the lockfile are agent-read-only: the pre-edit hook seals the
Edit/Write tool path in *every* strictness mode, and the pre-bash hook blocks the common
shell write forms (redirections, `sed -i`, `rm`, `tee`, …) against those paths. Task
state (`.harness/state/` — plan, checklist, contract) stays agent-writable: that is the
surface the workflow needs.

Be clear about what this is: the harness is a **guardrail against accidents and drift,
not a sandbox against an adversarial agent**. A model determined to cheat can still
reach the files through channels no hook can fully parse (variable expansion, exotic
quoting, a script it writes and runs). The guarantees that do **not** depend on agent
cooperation are the ones anchored outside the conversation: `verify`'s exit code, the
lockfile hashes, and `sync --check` in CI. If you need hard isolation, run the agent in
a sandbox — the harness will still be the thing that tells you *whether the work is
done*, which no sandbox does.

## One rule set, many hosts

`leina harness sync` compiles the canonical rules into whatever each platform can
enforce:

```mermaid
flowchart LR
    rules[".harness/rules/ + builtin<br/>(canonical, markdown + gates)"] --> sync["harness sync"]
    sync --> agents["AGENTS.md<br/>managed block"]
    sync --> claude["CLAUDE.md block<br/>+ .claude/skills/"]
    sync --> cursor[".cursor/rules/*.mdc<br/>+ hooks.json"]
    sync --> windsurf[".windsurf/ + .devin/<br/>rule mirrors"]
    sync --> opencode["opencode.json<br/>+ plugin"]
    sync --> lock[("harness.lock.json<br/>(hashes)")]
```

Three properties make this safe to re-run forever:

1. **Evidence-based targeting.** A platform is only written when config or flags name it,
   or the repo already carries its files. leina never elects an AI host for you.
2. **Managed blocks + lockfile.** Harness co-owns files like `CLAUDE.md` via marked
   blocks; everything outside the markers is never touched. Every artifact's hash lives
   in `.harness/harness.lock.json` — a hand-edited artifact **conflicts** (kept intact,
   reported) instead of being clobbered; `--force` is the explicit override.
3. **Symmetric removal.** `leina deinit` walks the same lockfile in reverse: owned files
   deleted only when untouched, blocks stripped only when their interior is untouched,
   harness entries removed from shared JSON files (user entries survive verbatim).

Enforcement differs per host — Claude Code and OpenCode get blocking hooks, Cursor gets
advisory hooks plus a commit guard, AGENTS.md-only hosts get instructions — but the
**oracle is identical everywhere**: whatever the host can or cannot enforce,
`leina harness verify` exits 0 or it does not.

## Where things live

```
.harness/
├── config.json          # platforms, strictness (guided|strict), rule overrides
├── rules/               # project rules (override builtin by id)
├── harness.lock.json    # artifact hashes — the sync parity ledger
├── generated/           # host files harness owns outright (e.g. opencode rules)
└── state/               # git-ignored task state
    ├── current/         #   contract.json · checklist.md · plan.md · verify-report.json · retries.json
    └── history/<ts>/    #   archived contracts, one dir per ended task
```

The leina-specific builtin rules (`leina-memory-first`, `leina-graph-consult`,
`leina-graph-fresh`, `leina-session-summary`) close the loop with the other two
employees: the inspector requires the agent to consult the librarian before starting,
keep the cartographer's map fresh, and leave the logbook entry before signing off.

## Rule presets — `generic` vs `leina-native`

Those four leina-coupled rules are **blocking by default**, and they only pass when leina
itself is adopted in the repo (graph built, memory in use). A team that wants the harness
for its *generic* value — tests-pass, no-secrets, diff-in-scope, lint-clean — should not
inherit four rules that fail unless they also run leina commands. Hence two presets
(defined in `application/harness/recipes.ts`):

| preset | what governs | `.harness/config.json` |
|---|---|---|
| `leina-native` | the full builtin suite, **including** the four `leina-*` rules — the historical default | `{}` (the same pristine seed `leina init` writes) |
| `generic` | only the host-agnostic rules (`tests-pass`, `no-secrets`, `diff-in-scope`, `lint-clean`, `typecheck`, `no-skipped-tests`, `plan-before-code`, `criteria-checklist`, `contract-interview`, `changelog-updated`) — **no rule requires a leina command** | the config below |

A preset never edits the rule files — it is realized entirely through config overrides
(the project layer may disable builtin rules; only *user-local* layers are barred from
weakening, see the enforceability invariant). The `generic` preset is exactly:

```json
{
  "rules": {
    "harness/leina-graph-consult": { "enabled": false },
    "harness/leina-graph-fresh": { "enabled": false },
    "harness/leina-memory-first": { "enabled": false },
    "harness/leina-session-summary": { "enabled": false }
  }
}
```

`presetConfig("generic")` in `application/harness/recipes.ts` generates this file — it
derives the `leina-*` list by scanning the builtin rules at call time, so a new
leina-coupled rule automatically joins the preset's exclusion list. To adopt the
`generic` preset today, write that JSON as your `.harness/config.json`; keep (or reset
to) `{}` for `leina-native`.

## Vocabulary map — two hook vocabularies, one brain, three "gates"

The harness arrived from an origin framework, and part of its vocabulary landed
duplicated or overloaded. This section is the disambiguation table.

### Two hook-event vocabularies for the same lifecycle

There are two event vocabularies because there are two **transports**, not two engines:

- `leina agent-hook <Event>` — the host-neutral **agent gate** (chapter 6), speaking the
  `.devin/hooks.v1.json` event shape (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PostCompaction`, `Stop`). Installed by `leina init` for Claude Code and
  Devin/Windsurf.
- `leina harness hook <event>` — the harness's own hook CLI, with its own event names
  (`session-start`, `pre-edit`, `pre-bash`, `stop`, `cursor-*`, `idle`). Wired by
  `harness sync` for Cursor and OpenCode.

Both converge on the **same decision functions** in `application/harness/hooks.ts` — the
vocabularies differ, the brain does not:

| lifecycle moment | agent-gate event (`leina agent-hook`) | harness hook event (`leina harness hook`) | shared decision |
|---|---|---|---|
| session opens | `SessionStart` | `session-start` | inject contract status + intake rules |
| before a file edit | `PreToolUse` (tool `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, or Devin `edit`/`write`) | `pre-edit` | `decidePreEdit` — contract scope + integrity boundary |
| before a shell command | `PreToolUse` (tool `Bash`, or Devin `exec`) | `pre-bash` | `decidePreBash` — commit/push guard + integrity boundary |
| agent tries to end the turn | `Stop` | `stop` | `decideStop` — run verify; block, or yield after `maxRetries` |
| after a tool ran | `PostToolUse` (advisory markers) | `cursor-after-edit` (edit ledger) | — |
| advisory-only moments | `UserPromptSubmit` / `PostCompaction` (context injection) | `cursor-stop` / `idle` | `advisoryVerifyFeedback` |
| Cursor shell permission | — | `cursor-shell` | `decideCursorShell` |

### Why enforcement is bifurcated per host

- **Claude Code and Devin/Windsurf** already run the agent gate that `leina init`
  installs. `harness sync` therefore ships them only rule **text** (the `CLAUDE.md`
  managed block + skills; `.devin/` + `.windsurf/` rule mirrors) — enforcement rides the
  gate that is already there. The gate blocks **only while a contract is active** (and
  leina consent is not disabled); without a contract it stays purely advisory.
- **Cursor and OpenCode** have no agent gate, so `harness sync` writes hook wiring that
  calls `leina harness hook <event>` directly. OpenCode's generated plugin turns a
  non-zero exit into a hard block; Cursor gets advisory hooks plus a shell permission
  guard.

One brain, two doors: whichever transport fires, the decision comes from the same
functions, so hosts cannot drift apart in behaviour.

### The word "gate" means three different things

| name to prefer | what it is | where it lives | can it refuse? |
|---|---|---|---|
| **verify gates** (rule gates) | the executable proofs (`command`, `file`, `diff`, `diff-content`, `checklist`, `js`) run by `leina harness verify` — the completion wall | rule frontmatter + `application/harness/gates/` | yes — exit 1 blocks completion |
| **agent gate** (hook bridge) | the host-hook entry point `leina agent-hook`: injects context, and relays the harness decisions above to the host | `cli/agent-gate.ts` | only while a contract is active; otherwise advisory |
| **freshness gate** (graph) | the staleness check the *graph* runs before answering a read — auto-rebuild or refuse (chapter 3); unrelated to the harness | graph read path | it refuses graph *reads*, never tasks |

In harness prose, a bare "gate" should mean a **verify gate**; qualify the other two.
