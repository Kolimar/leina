// sidecar-build.test.ts — guards the package-root resolution used to locate the
// shipped sidecar `.tmpl` sources in src/infrastructure/extractors/semantic/sidecar-build.ts.
//
// Regression: after the hexagonal reorg moved the file from
// src/extractors/semantic/ to src/infrastructure/extractors/semantic/, PKG_ROOT
// still walked up three levels (landing on src/) instead of four, so
// `sidecar build <lang>` failed with "sidecar templates not found ... at .../src/assets/sidecars/<lang>".
//
// Run: node --no-warnings --experimental-strip-types --test test/sidecar-build.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { templatesDir } from "../src/infrastructure/extractors/semantic/sidecar-build.ts";

test("(SB-1) templatesDir(java) resolves to the shipped assets/sidecars/java directory", () => {
  const dir = templatesDir("java");
  assert.ok(existsSync(dir), `templates dir should exist: ${dir}`);
  assert.ok(statSync(dir).isDirectory(), `should be a directory: ${dir}`);
  // The resolved root must be the package root, NOT src/ (the pre-fix bug).
  assert.ok(!/\bsrc[\\/]assets\b/.test(dir), `must not resolve under src/: ${dir}`);
  assert.ok(
    existsSync(join(dir, "javagraph", "src", "JavaGraph.java.tmpl")),
    `expected JavaGraph template under ${dir}`,
  );
});

test("(SB-2) templatesDir(csharp) resolves to the shipped assets/sidecars/csharp directory", () => {
  const dir = templatesDir("csharp");
  assert.ok(existsSync(dir), `templates dir should exist: ${dir}`);
  assert.ok(statSync(dir).isDirectory(), `should be a directory: ${dir}`);
  assert.ok(!/\bsrc[\\/]assets\b/.test(dir), `must not resolve under src/: ${dir}`);
  assert.ok(
    existsSync(join(dir, "RoslynGraph", "RoslynGraph.csproj.tmpl")),
    `expected RoslynGraph template under ${dir}`,
  );
});
