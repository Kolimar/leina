// fake-scip-indexer.ts — stand-in for a real `scip-go`/`rust-analyzer`/
// `scip-python` binary, used ONLY by tests (scip-indexer-run.test.ts /
// scip-extractor.test.ts / scip-verify.test.ts / scip-build-e2e.test.ts /
// scip-indexer-translate.test.ts) that exercise `runScipIndexer`'s full
// spawn->read->cleanup pipeline WITHOUT requiring the real toolchain/binary
// to be installed.
//
// Contract it fakes:
//   - `--fail` anywhere in argv -> simulated failure, exit 1.
//   - `--output <path>` present (every currently-wired indexer — Go, Rust,
//     Python — always passes this) -> copies the fixture there, exits 0.
//   - `--output` ABSENT -> copies the fixture to `<cwd>/index.scip` instead
//     (cwd is whatever the caller spawned this process with, per
//     `runScipIndexer`'s `cwd: root`), exits 0 — kept as a fallback shape,
//     even though no currently-wired language exercises it (scip-python was
//     assumed in Ola A design to have no `--output` flag; Ola C task C1.3
//     confirmed the real binary DOES accept one, same shape as Go/Rust).
//   - `LEINA_FAKE_SCIP_FIXTURE` env var overrides which `.scip` file gets
//     copied (defaults to the committed real
//     `test/fixtures/scip/go/index.scip`) — lets tests supply a synthetic
//     index (see `test/helpers/scip-encode.ts`'s `encodeIndex`) without a
//     second fake binary.
//
// This lets the runScipIndexer/ScipExtractor tests assert the REAL
// argv-building, spawn, streaming-read and tempdir-cleanup behavior
// end-to-end, using a real (if canned or hand-encoded) `.scip` payload
// rather than a mock of the parser itself.
//
// Run as a spawned child process: `node --experimental-strip-types
// fake-scip-indexer.ts index --output <path> ./...` (mirrors
// test/helpers/scip-stream-probe.ts's pattern).

import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--fail")) {
  console.error("fake-scip-indexer: simulated failure");
  process.exit(1);
}
const fixture =
  process.env.LEINA_FAKE_SCIP_FIXTURE ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "scip", "go", "index.scip");

const outIdx = args.indexOf("--output");
const outPath = outIdx === -1 || !args[outIdx + 1] ? join(process.cwd(), "index.scip") : args[outIdx + 1]!;
copyFileSync(fixture, outPath);
process.exit(0);
