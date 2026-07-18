---
{
  "id": "harness/leina-graph-fresh",
  "phase": "verify",
  "severity": "blocking",
  "enabled": true,
  "summary": "The leina code graph must be fresh before the task can be declared complete.",
  "tags": [
    "leina",
    "graph"
  ],
  "gate": {
    "type": "command",
    "run": "leina status .",
    "expectStdoutMatch": "^status:\\s*fresh",
    "timeoutMs": 30000,
    "onlyIfChanged": [
      "src/**",
      "test/**",
      "rules/**",
      "recipes/**",
      "scripts/**"
    ],
    "failureMessage": "The leina code graph is stale (sources changed since the last build).\nRun `leina refresh .` to rebuild it, then re-run `leina harness verify`.\nAn up-to-date graph is what makes impact analysis and memory recall\ntrustworthy for the next session.\n"
  }
}
---

# Keep the leina graph fresh

If you changed source files, the code graph no longer reflects reality. Rebuild
it with `leina refresh .` before declaring the task complete, so blast-radius
queries (`leina affected`, `leina impact analyze`) and the next agent session
work from current data.
