---
{
  "id": "harness/lint-clean",
  "phase": "verify",
  "severity": "advisory",
  "summary": "Linting should report no new problems.",
  "gate": {
    "type": "command",
    "run": "npm run --if-present lint",
    "expectExitCode": 0,
    "timeoutMs": 180000,
    "onlyIfChanged": [
      "src/**",
      "lib/**"
    ],
    "failureMessage": "Lint reported problems. Fix them or, if a rule conflicts with the task,\nmention it explicitly in your final report instead of silencing it.\n"
  },
  "tags": [
    "style"
  ]
}
---

# Keep lint clean

Run the project's lint script on your changes and fix what it reports.
