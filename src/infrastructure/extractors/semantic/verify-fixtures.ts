// Where `leina sidecar verify` / `leina scip verify` find the small deterministic projects they
// run the real sidecar / indexer against. They ship in the package under assets/fixtures/
// (package.json "files" publishes assets/, never test/): with the fixtures under test/fixtures/,
// verify could only work from a git checkout and failed from every installed leina.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/ or dist/ infrastructure/extractors/semantic/ → up 4 → package root.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** `<package>/assets/fixtures/<...segments>` — e.g. ("java"), ("scip", "go"). */
export function verifyFixtureDir(...segments: string[]): string {
  return join(PKG_ROOT, "assets", "fixtures", ...segments);
}

/** null when the fixture is in place; otherwise the failure message for a broken install. */
export function missingFixtureProblem(dir: string): string | null {
  return existsSync(dir) ? null : `verify fixture missing at ${dir} — the leina install is incomplete; reinstall it`;
}
