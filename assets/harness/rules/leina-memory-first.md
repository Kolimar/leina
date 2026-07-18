---
{
  "id": "harness/leina-memory-first",
  "phase": "intake",
  "severity": "blocking",
  "enabled": true,
  "summary": "Consult leina project memory BEFORE answering or acting on anything project-related.",
  "tags": [
    "leina",
    "context"
  ]
}
---

# Consult leina memory first

Before answering any question about this project, or starting any task in it,
query the leina project memory — it holds prior decisions, architecture notes
and session summaries that are NOT visible in the code:

- MCP: `memory_context` (task-relevant recall) or `memory_search <terms>`.
- CLI fallback: `leina query . "<question>"` for the code graph.

Do not answer from the code or from your own assumptions alone when memory may
hold a prior decision on the topic. If memory contradicts the code, say so
explicitly instead of silently picking one.

**Memory can be stale.** Memory tells you WHAT was done and WHY; the repo tells
you what is true NOW. Before repeating a memory's factual claims about repo
state (commits, test counts, "pending" items), cross-check the cheap evidence —
`git log --oneline | head`, `git status` — and prefer the newest memory
revision. If a memory turns out stale, update it with `memory_add` (same topic)
instead of leaving the trap for the next session.

When you learn something durable (a decision, a gotcha, a convention), save it
back with `memory_add` before ending the task.
