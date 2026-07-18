---
{
  "id": "harness/leina-session-summary",
  "phase": "deliver",
  "severity": "blocking",
  "enabled": true,
  "summary": "A leina session summary must be saved before the task can be closed.",
  "tags": [
    "leina",
    "memory"
  ],
  "gate": {
    "type": "js",
    "module": "./gates/leina-session-summary.js",
    "timeoutMs": 30000,
    "failureMessage": "No leina session summary has been saved since this task started. Save one\nbefore closing — it is what the next session's memory recall surfaces:\n\n  leina memory session . --content \"<what was done, why, and what is now pending>\"\n\n(or the MCP tool memory_session). State WHAT changed, WHY, and the REAL\npending items — a stale or missing summary misinforms the next session\nwith authority.\n"
  }
}
---

# Save the session summary before closing

The task is not delivered until its story is in leina memory. Summarize what
was done, the decisions taken, and the actual pending items. Update any
observation this task made stale (same topic key) — do not leave traps for
the next session.
