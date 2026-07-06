# Contributing to leina

Thanks for your interest in improving leina! Issues and pull requests are welcome.
Please also read the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements: **Node ≥ 22.13** (Node ≥ 24 recommended — see the readme for why). No build
step is needed to develop: the CLI runs TypeScript directly.

```bash
git clone <repo-url> && cd leina
npm install
npm run cli -- --help        # run the CLI from source
npm test                     # full test suite (node:test, no external runner)
npm run typecheck            # tsc --noEmit
npm run lint                 # eslint (zero warnings tolerated); lint:fix autofixes
```

Useful during development:

```bash
npm run cli -- build src          # dogfood: build the graph of leina itself
npm run cli -- affected src "GraphStore"
npm run test:coverage             # lcov + spec reporters into coverage/
```

## Architecture in two minutes

The source tree is hexagonal — dependencies point inward only:

```
domain/          types + ports (no I/O, no Node APIs beyond types)
application/     use cases over the ports
infrastructure/  adapters (SQLite, tree-sitter, filesystem, sidecars)
cli/             driving adapter: dispatcher + handlers + composition root (wiring.ts)
```

Start with [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md) — every command documents the
implementation entry point behind it, and the *Implementation map* table at the bottom is
the fastest way to find the file you need. The layer rules are enforced twice: by
`test/architecture.test.ts` and by the `no-restricted-imports` blocks in
`eslint.config.js` — a dependency pointing the wrong way fails both. If you change one
enforcement, change the other.

## Pull request guidelines

- **Tests accompany behavior.** New commands, flags, or fixes come with a test in `test/`
  (the suite is plain `node:test`; follow the `(prefix-N)` naming used by neighboring tests).
- **`npm test`, `npm run typecheck` and `npm run lint` must pass.** CI runs all three on
  Node 22 and 24. The lint gate tolerates zero warnings; a security-rule finding you have
  reviewed and judged safe gets an inline `eslint-disable-next-line` with the reasoning
  after the `--`, never a blanket rule change.
- **Keep the read path fast.** The heavy extractor stack (tree-sitter, ts-morph) is
  lazy-imported on purpose; don't add static imports of it to the dispatcher or to
  query-path handlers.
- **Reversibility is a feature.** Anything that writes to a user's machine or repo needs an
  inverse and must respect the consent flag (see the install handlers for the pattern).
- **Docs travel with the change.** If you add or change a command or flag, update
  `docs/CLI_REFERENCE.md` (and the root help in `src/cli/handlers/system.ts` — a test
  checks that every command family is listed there).

## Reporting bugs

Open an issue with the command you ran, the full output (including stderr), your OS, and
`node --version`. The output of `leina doctor` is almost always useful — it's read-only
and prints where everything resolves from.
