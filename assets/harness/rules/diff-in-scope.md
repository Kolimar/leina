---
{
  "id": "harness/diff-in-scope",
  "phase": "verify",
  "severity": "blocking",
  "summary": "Only files inside the declared contract scope may change.",
  "gate": {
    "type": "diff",
    "failureMessage": "Files changed outside the declared contract scope. Either revert the\nout-of-scope changes, or — if they are genuinely required — amend the\ncontract scope (`leina harness contract edit`) and state why in your report.\n"
  },
  "tags": [
    "scope"
  ]
}
---

# Stay inside the declared scope

Every changed file must match the scope globs declared in the active task
contract. Scope creep is the most common way a task drifts from its goal:
if you believe a file outside the scope must change, amend the contract
first and say why — never silently expand the blast radius.

When no contract is active, this gate passes automatically (nothing was
declared, so nothing can be violated) — but strict mode requires a contract
before editing at all.
