---
{
  "id": "harness/criteria-checklist",
  "phase": "verify",
  "severity": "blocking",
  "summary": "Every acceptance criterion from the contract must be explicitly checked off.",
  "gate": {
    "type": "checklist",
    "path": ".harness/state/current/checklist.md",
    "requireAllChecked": true,
    "failureMessage": "Unchecked acceptance criteria remain in .harness/state/current/checklist.md.\nFor each one: verify it is actually met, then check its box (- [x]). Never\ncheck a box for a criterion you have not verified — the checklist is your\nsigned statement of what you confirmed.\n"
  },
  "tags": [
    "workflow"
  ]
}
---

# Check off every acceptance criterion

The contract's criteria were written to `.harness/state/current/checklist.md`
when the task started. Before claiming completion, verify each criterion
against the actual behavior of the code and mark it `- [x]`. If a criterion
cannot be met, do not check it — report why instead.
