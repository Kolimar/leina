---
{
  "id": "harness/typecheck",
  "phase": "verify",
  "severity": "blocking",
  "summary": "The project must typecheck cleanly.",
  "gate": {
    "type": "command",
    "run": "npm run --if-present typecheck",
    "expectExitCode": 0,
    "timeoutMs": 180000,
    "onlyIfChanged": [
      "**/*.ts",
      "**/*.tsx",
      "**/*.mts",
      "**/*.cts"
    ],
    "failureMessage": "Typecheck failed. Fix every reported type error — do not silence errors with\n`any`, `@ts-ignore`, or `@ts-expect-error` unless the surrounding code\nalready establishes that pattern. Re-run `leina harness verify` when clean.\n"
  },
  "tags": [
    "typing"
  ]
}
---

# The project must typecheck

Run the project's typecheck script and fix every error it reports. Do not
suppress type errors to get past the gate.
