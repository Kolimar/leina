---
name: leina-setup
description: >
  Bootstrap leina in a workspace using the tri-state consent flag.
  Silent when consent is "enabled" or "disabled". Emits a one-time re-prompt
  when consent is "unknown" (fresh repo OR legacy repo with .devin/hooks.v1.json
  but no .leina/consent file). On user confirmation: Yes → `leina init .`
  (consent enabled); No → `leina deinit .` (consent disabled). Never
  auto-enables a repo without explicit user consent.
triggers:
  - user
  - model
license: MIT
---

> **Blanket model awareness**: If `~/.leina/.blanket` is present on this machine
> (set up via `leina setup`), `init` runs in **LIGHT mode** — only the consent flag
> and `.gitignore` block are written (AGENTS.md, hooks, and local grant are already
> machine-wide). Without the blanket, `init` runs in **FULL mode** and writes all
> project-scoped artifacts. Both modes are handled automatically by the CLI.

# leina-setup — Tri-state bootstrap

> Transport: `init` / `deinit` are install-admin commands — always run them via the
> `leina` CLI (they are not MCP tools). Read/query capabilities elsewhere may use the
> `mcp__leina__*` tools when available (mapping in `skills/_shared/cli-utilities.md`).

## Step 1 — Read the consent flag

Check the consent flag for the current project:

```bash
cat .leina/consent 2>/dev/null || echo "unknown"
```

Three possible states:

| State | Meaning | Action |
|-------|---------|--------|
| `enabled` | User opted in | **Stop. Do nothing. Stay completely silent.** |
| `disabled` | User opted out | **Stop. Do nothing. Stay completely silent.** |
| `unknown` | Flag file absent | Continue to Step 2 (one-time re-prompt) |

> **Legacy repos**: A repository that has `.devin/hooks.v1.json` but no
> `.leina/consent` file resolves to `unknown`. It is **never** auto-enabled —
> the user must explicitly consent. This is the correct behavior for the migration path.

**If the flag is `enabled` or `disabled` → stop here. Say nothing.**

## Step 2 — One-time re-prompt (unknown state only)

Ask the user exactly once per workspace session:

> **leina is available for this workspace.**
> The code-graph + project-memory CLI can help navigate this repo more efficiently.
>
> Would you like to initialize leina for this project?
> - **Yes** → run `leina init .`
> - **No** → run `leina deinit .` to record the opt-out

After the user answers, proceed to Step 3 or Step 4. Do **not** ask again in the same
session; the consent flag written by `init` or `deinit` will silence this skill permanently
for this repo.

## Step 3 — Initialize (user said Yes)

```bash
leina init .
```

This writes the consent flag as `enabled` and — depending on whether the blanket is active —
one of the following artifact sets:

**FULL mode** (standalone, no blanket):
- `.leina/consent` → `enabled`
- `AGENTS.md` — managed protocol block (`<!-- leina:protocol:start/end -->`)
- `.gitignore` — `.leina/*` exclusion block (re-includes `config.json`)
- `.devin/hooks.v1.json` — freshness refresh + advisory nudges
- `.devin/config.json` — pre-authorizes `Exec(leina)` (project-scoped grant)

**LIGHT mode** (blanket active — skills/agents/hooks/grant already machine-wide):
- `.leina/consent` → `enabled`
- `.gitignore` — `.leina/*` exclusion block only

All writes are **idempotent and merge-safe** — safe to re-run.

After `init`, the SessionStart hook will inject project memory + graph stats automatically
on the next session.

## Step 4 — Opt out (user said No)

```bash
leina deinit .
```

This writes the consent flag as `disabled` and strips any previously written project
artifacts (AGENTS.md block, gitignore block, `.devin/hooks.v1.json`). The user-global
config is **not** touched. This skill will be permanently silent for this repo after this.

## Step 5 — Build the knowledge graph (optional, after Step 3)

If the user wants structural navigation (dependencies, blast radius, shortest path):

```bash
leina build .
```

This may take a moment on large repos. Future queries (`leina query`, `affected`,
`path`) will use the cached graph.

---

## State-to-action table

| Consent state | Source | Action |
|--------------|--------|--------|
| `enabled` | `.leina/consent` = `enabled` | Silent no-op — project already initialized |
| `disabled` | `.leina/consent` = `disabled` | Silent no-op — user opted out |
| `unknown` (fresh) | Flag file absent | One-time re-prompt → `init .` or `deinit .` |
| `unknown` (legacy) | `.devin/hooks.v1.json` exists, no flag | One-time re-prompt → `init .` or `deinit .` |

---

## Summary: the 2-step model

| Step | Command | Frequency |
|------|---------|-----------|
| 1. Global activation (optional, blanket mode) | `leina setup` | Once per machine |
| 2. Project wiring | `leina init .` | Once per repo (after consent) |

After these steps, the AI can use `leina query/affected/memory ...` in any session
without further setup.
