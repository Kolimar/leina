# SCIP Rust fixture

A minimal Cargo **workspace of 2 crates** exercising exactly the shapes
`sdd/scip-lang-rollout` (wave B) cares about:

- `crate_a` (library):
  - `Foo` — a struct with an **inherent** `impl` block (`impl Foo { fn greet(&self) }`).
  - `Greeter` — a trait with an **abstract** method `greet` (no default body).
  - `Bar` — a struct with a **trait** `impl` block (`impl Greeter for Bar { fn greet(&self) }`)
    — same method NAME (`greet`) as `Foo`'s inherent impl, on a different owner. Both impl
    blocks live in the SAME file, so this is the concrete regression case for
    `normalizeImpl` (scip-indexer.ts): rust-analyzer emits every impl member under a
    synthetic `impl#[SelfType]`/`impl#[SelfType][Trait]` descriptor, never directly under
    `Foo#`/`Bar#` — left unrewritten, `Foo`'s and `Bar`'s `greet` methods would collide
    under one shared, invented `impl` owner id.
  - `Direction` (enum) and `Number` (union) — both must map to `NodeKind: "class"`, same as
    `struct`, mirroring `treesitter.ts`'s rust `classTypes`.
  - `describe()` — a top-level function (no owner) calling both `greet()` methods via a
    `format!` **macro invocation** (exercises `isCallableSymbol`'s `macro` suffix).
- `crate_b` (binary, depends on `crate_a` via a path dependency): calls `crate_a::describe`
  — a **cross-crate** call, indexed by a single `rust-analyzer scip .` run over the whole
  workspace (confirms `translateScipSymbol`'s package-name/version fields are correctly
  discarded — see `splitScipHead` — so multi-crate ids stay purely path-based).

`index.scip` is the **real** SCIP protobuf index produced by
[`rust-analyzer scip`](https://rust-analyzer.github.io/) against this exact source. It is
committed so the id-parity gate (`test/scip-id-parity-rust.test.ts`) doesn't require the
Rust toolchain to be installed to run.

## Regenerating `index.scip`

Requires `rustup` (installs `rust-analyzer` as a component — no separate `cargo install`
needed) and network access the first time:

```sh
# 1. Install rust-analyzer (only needed once)
rustup component add rust-analyzer

# 2. From this directory, regenerate the index
cd test/fixtures/scip/rust
rust-analyzer scip . --output index.scip

# index.scip is rewritten in place — commit it if the byte content changed.
# `cargo build`/`cargo metadata` also work here (offline, no external deps beyond
# std) if you want to sanity-check the workspace compiles first; delete the
# resulting target/ before committing (already .gitignore'd).
```

Confirmed empirically against `rust-analyzer 1.96.1`:

- Invocation: `rust-analyzer scip <path> --output <path>` — an explicit `--output` flag
  (unlike scip-python), so the existing `{argv, output:{strategy:"flag"}}` shape from
  `scip-indexer.ts`'s Go config needed no changes for Rust.
- `impl` blocks: every member of `impl Foo { ... }` is emitted under a symbol shaped
  `impl#[Foo]<member>` (inherent) or `impl#[Bar][Greeter]<member>` (trait impl) — never
  directly under `Foo#`/`Bar#`. `normalizeImpl` rewrites the synthetic `impl` descriptor to
  its first `type-parameter` (the Self type) and discards a second one (the trait), exactly
  as designed.
- `SymbolInformation.kind` IS reliably populated (unlike scip-python): `Struct(49)`,
  `Enum(11)`, `Union(59)`, `Trait(53)`, `Function(17)`, `Method(26)`, and — for a trait's
  own abstract method signature specifically — `TraitMethod(70)`, all present in this
  fixture's real output and all mapped in `SCIP_CONFIGS.rust.kindToNode`.
- `SymbolInformation.relationships` came back EMPTY for every symbol in this fixture (no
  `is_implementation` relationship recorded for `Bar`/`Greeter`, even though `Bar` really
  does `impl Greeter for Bar`) — a coverage gap for `extends`/`implements` edges via SCIP
  for Rust specifically, noted here rather than silently assumed; it does not affect the
  id-parity gate (which only compares definition node ids, not heritage edges).

If `rust-analyzer scip` output ever changes shape in a way that breaks
`test/scip-id-parity-rust.test.ts`, that is a **signal, not a nuisance** — re-run the gate
before assuming the fixture is stale.
