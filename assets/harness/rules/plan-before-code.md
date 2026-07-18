---
{
  "id": "harness/plan-before-code",
  "phase": "plan",
  "severity": "blocking",
  "scope": {
    "taskTypes": [
      "feature",
      "refactor"
    ]
  },
  "summary": "Write a plan file with acceptance criteria before editing any code.",
  "gate": {
    "type": "file",
    "path": ".harness/state/current/plan.md",
    "exists": true,
    "minBytes": 200,
    "failureMessage": "No plan artifact found at .harness/state/current/plan.md (or it is too short).\nWrite your plan there BEFORE editing code: files to touch, approach, and the\nacceptance criteria you will verify at the end. Keep it under 40 lines.\n"
  },
  "tags": [
    "workflow"
  ]
}
---

# Produce a written plan before editing code

Before modifying any file, write your plan to `.harness/state/current/plan.md`:

1. The files you intend to touch.
2. The approach, in a few sentences.
3. The acceptance criteria you will verify at the end.

Keep it under 40 lines. A task without a written plan is not ready to execute.
