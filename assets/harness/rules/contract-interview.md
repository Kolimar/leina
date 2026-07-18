---
{
  "id": "harness/contract-interview",
  "phase": "intake",
  "severity": "blocking",
  "summary": "Interview the user until goal, scope and acceptance criteria are unambiguous BEFORE creating the contract.",
  "tags": [
    "workflow",
    "contract"
  ]
}
---

# Interview before you contract

Never invent a task contract from a vague request. Before running
`leina harness contract new` for ANY coding task or objective:

1. **Ask the user clarifying questions until you are fully confident** about:
   - **Goal** — one sentence of what "done" looks like, in the user's words.
   - **Scope** — which files/areas may change (and what is explicitly off-limits).
   - **Acceptance criteria** — observable checks that prove it worked.
2. Reflect your understanding back ("so the contract would be: …") and get a
   yes before creating it. If the request is trivial and unambiguous, one
   confirmation question is enough — do not interrogate for the sake of it.
3. Only then run `leina harness contract new` with what the user confirmed.

**One task = one contract.** Before starting a new task, run
`leina harness contract show`. If a previous, unrelated contract is still active,
tell the user and ask whether to close it (`leina harness contract end` — it
archives to history, nothing is lost). Never work a new task under an old
contract's goal and scope.
