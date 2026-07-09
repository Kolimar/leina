# Roadmap

What leina focuses on next, in order. Grounded in an honest read of where the tool is
strong (deterministic blast radius, drift-checked memory, zero-friction install) and
where it is not yet. Items move to the changelog when they ship — this file never
advertises the past.

## Shipped

- **MCP server** — `leina mcp` (stdio): the capability registry as MCP tools;
  `init --mcp` registers it in the project `.mcp.json`. The CLI remains the primary
  transport (cheaper in tokens).
- **CI across OSes** — Linux/macOS/Windows × Node 22/24 matrix; provenance-attested
  release workflow.
- **Kotlin, Rust, Ruby, PHP** via tree-sitter (11 languages total).
- **Portable project memory** — `memory export/import/sync` with a committable
  `.leina/memory-export.jsonl` snapshot and deterministic merge.
- **Host-neutral hook gate** — `agent-hook` + `init --claude-hooks` writes Claude Code
  hooks in `.claude/settings.json`; one gate serves Devin and Claude Code.
- **Incremental extraction cache** — content-hash per-file reuse for all tree-sitter
  languages; `build --profile` shows per-stage timings.
- **Word-wise query scoring** — camelCase/snake_case subtokens on both sides of the
  match, closing most of the "vocabulary gap" without embeddings.
- **Benchmark harness** — `npm run bench` (docs/benchmarks).
- **Prebuilt semantic sidecars** — `sidecar install <lang>`: sha256-verified downloads of a
  CI-published per-platform binary, no local .NET/JDK needed; `sidecar build <lang>` remains
  the local-toolchain fallback.

## Next (reach & depth)

- **Embedding provider port** — opt-in semantic search behind an external-command port
  (local model / host API); never a hard native dependency.
- **ts-morph incremental strategy** — the profile shows the TS type-check dominates
  rebuilds on TS-heavy repos; investigate program reuse without losing precision.
- **Benchmark tables for public repos** — zod/gson/Dapper numbers, re-measured and PR'd.
- Clustering / god-node handling for very large graphs.

## Non-goals

- No cloud dependency. The local event outbox stays the seam for a future **opt-in** sync.
- No native compile steps or install scripts — installs must keep working under
  pnpm/bun/`--ignore-scripts` everywhere.
- No lowering of the Node ≥ 22.13 floor: it is what allows `node:sqlite` with zero native
  dependencies, and Node 20 left maintenance in April 2026.
