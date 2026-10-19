// Disposable copies of test/fixtures/* for tests that build or extract a graph.
//
// A build writes its manifest and extraction cache under <root>/.leina, so running it on a
// fixture in place leaves state inside the repo — and a later run can then reuse that stale
// cache instead of extracting. Tests copy the fixture into a temp dir and build there.

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");

export interface FixtureCopy {
  /** The copied fixture root (same basename as the original). */
  dir: string;
  /** Remove the copy. Idempotent. */
  cleanup(): void;
}

/** Copy `test/fixtures/<segments...>` into a fresh temp dir, leaving out any `.leina/`. */
export function copyFixture(...segments: string[]): FixtureCopy {
  const parent = mkdtempSync(join(tmpdir(), "leina-fixture-"));
  const dir = join(parent, segments.at(-1) ?? "fixture");
  cpSync(join(FIXTURES_DIR, ...segments), dir, {
    recursive: true,
    filter: (src) => basename(src) !== ".leina",
  });
  return { dir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}
