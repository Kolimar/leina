# Screenshots — capture recipe

These images illustrate the `leina graph serve` explorer in the docs. They are generated
from a real project (leina itself) so they stay honest. To regenerate them:

```bash
# 1. Build (or refresh) the graph for a project
leina build .

# 2. Launch the read-only explorer (loopback, Ctrl+C to stop)
leina graph serve . --port 7423

# 3. Open http://127.0.0.1:7423 in a browser and capture:
#    - graph-serve-node-detail.jpg — search a symbol (e.g. "GraphStore"), click the result to
#                                     open its detail drawer (connections + anchored memories)
#    - graph-serve-graph.jpg       — a zoomed view of nodes and their relationships
```

Expected files in this folder (referenced from the docs):

| File | Shows |
|------|-------|
| `graph-serve-node-detail.jpg` | The detail drawer for one node: its grouped connections (calls / referenced-by / implements / methods) **and the latest memories anchored to it**, each with a drift badge — the graph↔memory link — alongside the node-type/edge-type filters and folder tree. |
| `graph-serve-graph.jpg` | A zoomed view of the graph: individual nodes (classes, types, functions) and the edges between them. |
