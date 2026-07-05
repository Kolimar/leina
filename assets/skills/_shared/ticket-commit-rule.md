# Mandatory Ticket Prefix (NON-NEGOTIABLE)

Single source of truth for the ticket-first commit rule. Referenced by the
`branch-pr`, `work-unit-commits`, and `github-pr` skills — do not restate the
full rule there; link here instead.

**BEFORE running `git commit`, ALWAYS ask the user for the ticket identifier
(e.g. `PROJ-293`, `DEVOPS-42`).** Never assume, omit, or invent the ticket.
If the user already provided it during the session, confirm it before committing.

The commit message MUST start with the ticket:

```
TICKET-123 Description of the change
```

Valid examples:

```
PROJ-293 Add graph export skill
DEVOPS-42 Fix CI pipeline timeout on quality step
```

Invalid examples (the agent must NEVER produce these):

```
feat(auth): add OAuth2 login          ← missing ticket
Add graph export skill                ← missing ticket
PROJ Add skill                        ← missing number
```

If the user declines to give a ticket or says there is none, **do not commit**;
explain that the organization requires a ticket on every commit.
