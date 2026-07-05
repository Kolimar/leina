---
name: authenticated-api
description: >
  Call token-authenticated service APIs (SonarQube, Jira, internal REST) through the
  leina env store, under the names-not-values contract: the agent only ever handles
  variable NAMES — values never enter the chat, argv, or the model context.
  Trigger: When a task needs to call an external service that requires a credential —
  querying a quality gate, posting a comment to a tracker, hitting an internal API.
license: MIT
metadata:
  version: "1.0"
---

# authenticated-api — call authenticated services without seeing the credential

> Transport: `leina env exec` is **CLI-only, by design** — even when `mcp__leina__*`
> tools are available. The names-not-values contract injects secret values
> process-to-process via `env exec`; an MCP tool result would pull them into the model
> context. Other leina capabilities may use the MCP tools; credentials never do.

## When to use

Any task that needs to call an API with a token/credential: querying the SonarQube
quality gate, commenting on a Jira issue, consuming an internal API. This skill defines
HOW the credential is obtained and consumed; the WHAT (endpoint, payload) comes from
your task.

## The contract (NON-NEGOTIABLE)

1. **NEVER ask for the token in chat.** A token pasted into the conversation stays in
   the transcript forever. If it is missing, ask the human to store it themselves (once):

   ```
   I need SONAR_TOKEN to query SonarQube. Store it with:

       leina env set SONAR_TOKEN

   (hidden prompt — I never see the value). Let me know when it's done.
   ```

2. **NEVER pass the value through argv** (`curl -H "Authorization: Bearer squ_abc..."` is
   forbidden: it lands in the shell history and in your transcript).
3. **Check presence by NAME, never by value:** `leina env list` shows
   `SONAR_TOKEN=squ****` (masked). `leina env get X --reveal` will refuse if you try to
   capture it through a pipe — that is by design; do not work around it.
4. **Consume only via `leina env exec --only <KEY> -- <cmd>`.** The value travels
   process-to-process into the child command; `--only` limits the injection to the one
   variable the task needs (never inject the whole store).

## GET pattern (tier 1 — expansion in the child shell)

**Single quotes** are the key: your shell does not expand `$SONAR_TOKEN` (it does not
have it); the child `sh` — which receives the injected variable — does.

```bash
leina env exec --only SONAR_TOKEN -- sh -c \
  'curl -sf -u "$SONAR_TOKEN:" "https://sonar.example.com/api/qualitygates/project_status?projectKey=my-app"'
```

## POST pattern (the general case: token in header + body)

**Tier 1 — simple** (the token appears in the child curl's argv — visible in local `ps`
while it runs; acceptable on your machine, not on a shared one):

```bash
leina env exec --only SONAR_TOKEN -- sh -c \
  'curl -sf -X POST -u "$SONAR_TOKEN:" -d "issue=ABC-123&text=triaged: false positive" \
   "https://sonar.example.com/api/issues/add_comment"'
```

**Tier 2 — strict** (clean argv: `printf` is a shell builtin — it never shows in `ps` —
and `curl -K -` reads the header from stdin):

```bash
leina env exec --only SONAR_TOKEN -- sh -c \
  'printf "header \"Authorization: Bearer %s\"\n" "$SONAR_TOKEN" \
   | curl -sf -K - -X POST -d @payload.json "https://api.example.com/v1/things"'
```

**Tier 3 — consumer script** (the cleanest; prefer it when the POST has logic or a
complex body — zero shell, zero argv, the token lives only in the memory of the process
that uses it):

```bash
leina env exec --only SONAR_TOKEN -- node scripts/report.mjs
```

```js
// scripts/report.mjs — the token arrives via the injected environment, never via code
const res = await fetch("https://sonar.example.com/api/issues/add_comment", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.SONAR_TOKEN}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ issue: "ABC-123", text: "triaged" }),
});
if (!res.ok) throw new Error(`sonar: ${res.status}`);
```

## Failures and how to respond

| Symptom | Action |
|---|---|
| `SONAR_TOKEN: not set` / missing from `leina env list` | Ask the human for contract step §1. Never invent values. |
| HTTP 401/403 | Token expired or lacks permissions. Ask the human to run `leina env set SONAR_TOKEN` again (upsert in place). Never ask for the value in chat. |
| `--reveal requires an interactive terminal` | Correct behaviour: you are trying to capture the value. Go back to the `env exec` pattern. |
| The service requires the credential in a config file | Generate the file INSIDE the child: `sh -c 'printf "token=%s\n" "$TOK" > .tool-auth && tool run; rm -f .tool-auth'` — never write it from your own context. |

## Why not something else

- `~/.leina/.env` is 0600 plain text **by documented design** (no keychain = no native
  dependencies). The threat model is leakage into the agent/argv/logs, not an attacker
  with access to your disk.
- Session variables (`export SONAR_TOKEN=...`) look equivalent but land in the shell
  history and die with the session; the store survives and never went through argv.
