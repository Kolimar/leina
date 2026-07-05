---
name: graph-viz
description: >
  Visualize the leina code graph as an interactive, offline, self-contained HTML file.
  Trigger: When the user asks to visualize, explore, or browse the code graph; review architecture;
  understand module dependencies; or inspect community structure.
license: MIT
metadata:
  version: "1.0"
---

# graph-viz — Interactive code-graph visualization

> Transport: commands are shown as `leina ...` CLI. If `mcp__leina__*` tools are
> available, prefer them — `graph_visualize` runs the same export and returns the path
> of the generated HTML (mapping in `skills/_shared/cli-utilities.md`).

## When to use this skill

Use `leina visualize` when the user wants to:

- **Visually explore** the project architecture (modules, layers, dependencies).
- **Detect god nodes** — functions or classes with a high coupling degree.
- **Review Louvain communities** detected automatically during the build.
- **Present the graph** to another team member offline.
- Investigate code clusters or circular dependencies graphically.

## Steps to generate the HTML

### 1. Check that the graph is available

```bash
leina status .
```

If the graph is `STALE` or missing, rebuild it:

```bash
leina refresh .
# or (only if it does not exist yet):
leina build .
```

### 2. Generate the offline HTML

```bash
leina visualize . [--out <path/to/file.html>]
```

- `<dir>` is the project root directory (default `.`).
- `--out` is optional; the default is `.leina/graph.html`.
- The command prints: `Exported graph.html (N nodes, E edges) -> <path>`.

### 3. Open the HTML in a browser

```bash
open .leina/graph.html        # macOS
xdg-open .leina/graph.html    # Linux
start .leina/graph.html       # Windows
```

The file is **fully self-contained and offline**: no network connection required.

## Visual legend

| Element | Meaning |
|----------|-------------|
| **Node color** | Top-level folder/layer of the file (`src/domain` → yellow, `src/application` → blue, `src/infrastructure` → green, `src/cli` → violet, etc.). The legend shows the folder names. |
| **Node size** | Bidirectional behavioral degree (number of edges that are NOT `contains`). Bigger nodes have higher coupling. |
| **God nodes** | The 12 highest-degree nodes are labelled and listed in the side panel. They are priority refactoring candidates. |
| **Dashed edge** | `INFERRED` confidence — relation detected with lower certainty. |
| **Faint edge** | `contains` type (structural relation, module→member). |

## Node detail (click → drawer)

**There is no hover tooltip.** **Clicking** a node opens a drawer on the right with its
structured detail: full label, `kind`, layer, file (`sourceFile:loc`), degree, signature
(for functions/methods) and the detected **Louvain community** (as data — it does not
affect the color). Clicking empty space closes the drawer. The search box and the god-node
list also focus the node and open its drawer.

> Louvain communities are still computed and persisted during the build, but coloring and
> the legend are **per folder** (more readable); the community only appears as data in the drawer.

## UI controls

- **Search box**: type part of a name and press Enter to zoom to the node and open its drawer.
- **Folder filters**: toggle the visibility of each folder/layer.
- **Freeze physics / resume physics**: freezes the force-directed layout; useful for screenshots.
- **Fit view**: adjusts the view to show all nodes.
- **God nodes** (bottom panel): lists the 12 highest-degree nodes; clicking one focuses it and opens its drawer.

## Notes

- The HTML embeds vis-network and the graph data; typical size is ~700 KB.
- The graph is detected as `stale` when sources change. Run `leina refresh .`
  before `visualize` to get fresh data.
- The `visualize` command follows the same **freshness gate** as `query` and `affected`:
  posture `auto` → rebuilds automatically; posture `refuse` → asks you to run `refresh`.
