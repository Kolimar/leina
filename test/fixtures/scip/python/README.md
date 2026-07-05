# SCIP Python fixture

A minimal **single-root** Python project exercising exactly the shapes
`sdd/scip-lang-rollout` (wave C) cares about:

- `main.py`:
  - `outer_a()`/`outer_b()` — two top-level functions, each defining a **nested
    function named `helper`** — same name, two different closures. Both must
    **flatten** to the SAME id (`main.py:helper`), matching tree-sitter's own
    behavior (`treesitter.ts`'s `walk` never tracks an enclosing FUNCTION as an
    owner, only classes/interfaces do — so two homonymous nested functions
    already collapse to one flat id on the tree-sitter side too; scip-python
    must match that, not diverge from it).
  - `main()` — calls into the imported module (see below) and into
    `outer_a()`/`outer_b()`.
  - `import pkg.helper` (bare import, NOT `from pkg.helper import ...`):
    deliberate — tree-sitter's Python `collectImport` only synthesizes an
    `imports`-edge/module-concept-node for the `from X import Y` form
    (`pythonFromImport`); a bare `import X` resolves to `module: ""` in
    `pythonPlainImport` and creates no node. SCIP has no equivalent concept
    for either form — using the bare form here keeps the fixture's node set
    100% comparable rather than encoding a known, unrelated tree-sitter-only
    concept node into the gate.
- `pkg/helper.py` — a class with a method (`Greeter.greet`) and a top-level
  function (`add`), both called from `main.py` **cross-file** (`main.py`
  imports `pkg.helper` and calls `pkg.helper.Greeter()`/`pkg.helper.add(...)`)
  — exercises the same "two Documents in one combined index" shape the Rust
  gate's cross-crate test does (see `scip-gate-python-cross-file-call-site`).
- `pkg/stub.pyi` — a type stub file (`.pyi`), confirming `scipExtensionsFor`
  claims stub files too (`SCIP_CONFIGS.python.extensions = {".py", ".pyi"}`)
  and that scip-python indexes them like regular source.

`index.scip` is the **real** SCIP protobuf index produced by
[`scip-python`](https://github.com/sourcegraph/scip-python) against this
exact source. It is committed so the id-parity gate
(`test/scip-id-parity-python.test.ts`) doesn't require the Python/Node
toolchain to be installed to run.

## Regenerating `index.scip`

Requires Node (for `scip-python` itself, an npm package) AND a Python
interpreter with `pip` on `PATH` (scip-python shells out to `pip` to resolve
the project's dependency environment — a venv's `bin/` on `PATH` is enough,
no packages need to actually be installed for this fixture, which has zero
third-party imports):

```sh
# 1. Install scip-python (only needed once; no separate pip install needed
#    for THIS fixture, but scip-python still probes for a working `pip`)
npm install -g @sourcegraph/scip-python
python3 -m venv /tmp/scip-python-pip  # any venv with `pip` on PATH satisfies the probe
export PATH="/tmp/scip-python-pip/bin:$PATH"

# 2. From this directory, regenerate the index
cd test/fixtures/scip/python
scip-python index --output index.scip --project-version=0.0.0

# index.scip is rewritten in place — commit it if the byte content changed.
```

Confirmed empirically against `@sourcegraph/scip-python 0.6.6` (this closes
the design's Open Questions for scip-python, task C1.3):

- **Invocation / `--output` flag**: CONTRARY to the Ola A design assumption
  ("no explicit output flag exists, must resolve a cwd-default `index.scip`
  and clean it up"), `scip-python index --output <path>` **does** accept an
  explicit output path — it defaults to `index.scip` under `--cwd` only when
  `--output` is omitted. `SCIP_CONFIGS.python` therefore needs no
  `"cwd-default"` special-casing at all; it uses the exact same
  explicit-flag shape as Go/Rust. `runScipIndexer`'s `output: {strategy,
  resolve}` abstraction was simplified away entirely as a result (see
  `sdd/scip-lang-rollout/apply` for the full before/after).
- **`--project-version`**: scip-python defaults this by shelling out to `git
  rev-parse` when omitted, and **throws** (`TypeError: Cannot read properties
  of undefined (reading 'indexOf')` in `ScipSymbol.ts`'s
  `normalizeNameOrVersion`) if the indexed directory isn't inside a git
  repository. `SCIP_CONFIGS.python.argv` always passes a fixed
  `--project-version=0.0.0` defensively — the package/version fields are
  parsed and immediately discarded by `splitScipHead` (never part of any
  derived id), so the fixed value has zero effect on the graph, only avoids
  a crash for python projects that aren't (or aren't the root of) a git repo.
- **`relative_path`**: cwd-relative, confirmed by running with `cwd` set to
  this fixture's own directory — `main.py`, `pkg/helper.py`, `pkg/stub.pyi`,
  matching `runScipIndexer`'s existing `cwd: root` invariant (unchanged from
  Go/Rust).
- **`SymbolInformation.kind`**: confirmed ALWAYS `0` (never populated) for
  every symbol in this fixture, including classes/methods/functions — the
  suffix-based `fallbackKind` fallback (Ola A, task A1.5) is not an edge
  case for Python, it is the ONLY path that ever fires.
- **`SymbolInformation.display_name`**: also confirmed ALWAYS empty string —
  an Ola C finding NOT anticipated by the design. Left unfixed, every
  python node's label would render as `"()"` (functions/methods) or `""`
  (classes) instead of the real name. Fixed in
  `deriveDefinitionNodesAndEdges` by falling back to the already-resolved id
  chain's final descriptor name (always the real identifier — general fix,
  not a python-specific branch, so Go/Rust are unaffected since their
  `display_name` is already populated).
- **Nested nesting shape**: a nested function's symbol string chains BOTH
  enclosing function names as `method`-suffixed descriptors under the
  module's own `namespace` descriptor, e.g. `main/outer_a().helper().` —
  confirming Ola A's `flattenNestedFns` (drop every non-final
  `method`-suffixed descriptor) is exactly the right shape.
- **Symbol duplication for parameters**: scip-python also emits one
  `SymbolInformation` per PARAMETER (e.g. `Greeter#greet().(self)`,
  `.(name)`), which — since `"parameter"` is excluded from
  `ID_CHAIN_SUFFIXES` — folds to the SAME id as its owning method/function.
  This produces internal duplicate node entries (3x for `greet`/`add`: the
  definition itself + 2 parameter symbols each), collapsed by `dedup()` just
  like Rust's own struct+impl internal duplication (see
  `test/scip-id-parity-rust.test.ts`'s dedup-merges test) — not a bug, not
  gate-relevant (the gate compares by id SET, not by raw array length).
- **Cross-file calls stay untranslated as `calls` EDGES** (same known,
  accepted gap already documented for Rust's cross-crate call): a reference
  occurrence's symbol folds against the CURRENT document's `relativePath`,
  not the definition's actual file, so a cross-file callee id never matches
  that document's own `nodeIds` guard and no edge is emitted. The gate
  (`scip-gate-python-cross-file-call-site`) only asserts BOTH ends
  translate as valid NODE ids from their own Document — exactly mirroring
  `scip-gate-rust-cross-crate-call-site`'s scope — never that a `calls` edge
  connects them.

If `scip-python index` output ever changes shape in a way that breaks
`test/scip-id-parity-python.test.ts`, that is a **signal, not a nuisance** —
re-run the gate before assuming the fixture is stale.
