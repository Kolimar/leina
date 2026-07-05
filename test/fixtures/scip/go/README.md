# SCIP Go fixture

`main.go` is a minimal Go module (package `fixture`) exercising exactly the
shapes the scip-ingestion spike cares about:

- a top-level function (`Foo`) — no owner,
- an interface (`Greeter`) with one method spec,
- a struct (`Bar`) that implements `Greeter` (so `SymbolInformation.relationships`
  carries a real `is_implementation` relationship),
- a receiver method (`(*Bar).Greet`) that calls `Foo` (so there's a real
  Reference-inside-a-Definition-range to exercise `calls` containment).

`index.scip` is the **real** SCIP protobuf index produced by
[scip-go](https://github.com/scip-code/scip-go) (module path
`github.com/scip-code/scip-go`, the current home of the indexer formerly at
`github.com/sourcegraph/scip-go`) against this exact source. It is committed
so the parser/id-parity tests (`test/scip-proto.test.ts`,
`test/scip-id-parity.test.ts`) don't require the Go toolchain or scip-go to be
installed to run.

## Regenerating `index.scip`

Requires Go >= 1.25 (scip-go's own `go.mod` floor) and network access for
`go install`:

```sh
# 1. Install scip-go (only needed once; installs to $GOBIN or $GOPATH/bin)
go install github.com/scip-code/scip-go/cmd/scip-go@latest

# 2. From this directory, regenerate the module's dependency graph (go.sum)
#    if go.mod changed, then re-index:
cd test/fixtures/scip/go
go mod tidy
scip-go index ./...

# index.scip is rewritten in place — commit it if the byte content changed.
```

`go.mod` deliberately declares no dependencies beyond the Go stdlib, so
`go mod tidy` should be a no-op unless the module path or Go version changes.

If `scip-go index` output ever changes shape in a way that breaks
`test/scip-id-parity.test.ts` or `test/scip-proto.test.ts`, that is a
**signal, not a nuisance** — re-run the gate before assuming the fixture is
stale; see `sdd/scip-ingestion/design`'s "Versionado del formato SCIP" risk.
