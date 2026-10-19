---
{
  "id": "harness/leina-graph-consult",
  "phase": "plan",
  "severity": "blocking",
  "enabled": true,
  "scope": {
    "taskTypes": [
      "feature",
      "bugfix",
      "refactor"
    ]
  },
  "summary": "Map the blast radius with the leina code graph before modifying code.",
  "tags": [
    "leina",
    "graph"
  ]
}
---

# Consult the code graph before touching code

Memory tells you the why; the graph tells you the structure. Before modifying
or renaming anything, map the blast radius:

- `leina affected . <symbol|file>` — everything that transitively depends on it.
- `leina impact analyze . <symbol>` — impact classified into files, tests, services, configs.
- `leina query . "<question>"` — relevance-ranked subgraph when you don't know where to look.

Reflect what you find in your plan (files to touch and files at risk). The
graph is kept trustworthy by the `leina-graph-fresh` verify gate — use it
instead of grepping blindly.
