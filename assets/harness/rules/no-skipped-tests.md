---
{
  "id": "harness/no-skipped-tests",
  "phase": "verify",
  "severity": "blocking",
  "summary": "Changed test files must not introduce skipped or focused tests.",
  "gate": {
    "type": "diff-content",
    "paths": [
      "*test*",
      "*spec*"
    ],
    "forbidAdded": "\\.(skip|only)\\(|@pytest\\.mark\\.skip|#\\[ignore\\]",
    "onlyIfChanged": [
      "**/*test*",
      "**/*spec*"
    ],
    "failureMessage": "Your diff adds a skipped or focused test (.skip / .only / skip marker).\nRemove it: skipping a test to make the suite green defeats the suite.\n"
  },
  "tags": [
    "testing"
  ]
}
---

# Never skip or focus tests to get green

Adding `.skip`, `.only`, or an equivalent marker in your diff is treated as
gaming the verification, not passing it. Fix the test or the code instead.
