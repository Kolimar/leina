---
{
  "id": "harness/tests-pass",
  "phase": "verify",
  "severity": "blocking",
  "summary": "The full test suite must pass before the task can be declared complete.",
  "gate": {
    "type": "command",
    "run": "npm test",
    "expectExitCode": 0,
    "timeoutMs": 300000,
    "onlyIfChanged": [
      "src/**",
      "lib/**",
      "test/**",
      "tests/**"
    ],
    "failureMessage": "Tests failed. Do not report the task as complete. Read the failing output,\nfix the underlying cause (never the test itself, unless the test encodes the\nold behavior you were asked to change), and re-run `leina harness verify`.\n"
  },
  "tags": [
    "testing"
  ]
}
---

# Tests must pass before completion

1. Run the full test suite before declaring any task complete.
2. Never delete, skip, or weaken a test to make it pass.
3. If you added behavior, you must have added at least one test that fails
   without your change.

The task is NOT complete until `leina harness verify` exits 0.
