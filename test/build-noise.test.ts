// build-noise.test.ts — what a build prints about reduced-precision extraction.
//
// The "install a sidecar / SCIP indexer for <lang>" nudge used to fire for ANY file of the
// language (leina's own test/fixtures/Sample.cs included), was printed by the extractor,
// again as a build diagnostic and a third time in the "Done" line, and hit stderr on every
// stale auto-rebuild of query/affected. Now: extractors return `degraded` notes (only for
// product code), the explicit build prints each once, and read-path rebuilds stay quiet.
// Run: node --no-warnings --experimental-strip-types --test test/build-noise.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAuxiliarySourcePath } from "../src/application/graph/detect.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

const SANDBOX = mkdtempSync(join(tmpdir(), "leina-noise-sandbox-"));
const EMPTY_PATH = join(SANDBOX, "empty-path"); // no scip-go / rust-analyzer / scip-python
mkdirSync(EMPTY_PATH);
// No built sidecars (they live under $LEINA_HOME/sidecars) and no sidecar env overrides.
process.env.LEINA_HOME = join(SANDBOX, "leina-home");
delete process.env.LEINA_CSHARP_SIDECAR;
delete process.env.LEINA_JAVA_SIDECAR;
delete process.env.LEINA_BUILD_SIDECARS;
test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/** Run `fn` with PATH pointing at an empty dir, capturing everything written to stderr. */
async function withoutToolsCapturingStderr<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
  const savedPath = process.env.PATH;
  const original = process.stderr.write.bind(process.stderr);
  let err = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.env.PATH = EMPTY_PATH;
  try {
    return { value: await fn(), err };
  } finally {
    process.env.PATH = savedPath;
    process.stderr.write = original;
  }
}

test("(noise-1) isAuxiliarySourcePath: tests, fixtures, vendor and examples are auxiliary", () => {
  for (const p of [
    "test/fixtures/Sample.cs",
    "src/__tests__/a.ts",
    "vendor/github.com/x/y.go",
    "examples/demo/main.go",
    "pkg/server_test.go",
    "app/models/user_spec.rb",
    "src/Foo.Tests/FooTests.cs",
    "src/test/java/com/acme/AppTest.java",
    "tests\\unit\\test_api.py",
  ]) {
    assert.equal(isAuxiliarySourcePath(p), true, p);
  }
  for (const p of ["src/App.cs", "cmd/server/main.go", "lib/testing_utils.py", "src/contest.ts", "Latest.java"]) {
    assert.equal(isAuxiliarySourcePath(p), false, p);
  }
});

test("(noise-2) sidecar extractor: no note for fixture-only C#, one note for product C#, never prints", async () => {
  const { SidecarExtractor } = await import("../src/infrastructure/extractors/semantic/sidecar.ts");
  const root = mkdtempSync(join(tmpdir(), "leina-noise-cs-"));
  try {
    const fixture = write(root, "test/fixtures/Sample.cs", "class Sample {}\n");
    const ext = new SidecarExtractor("csharp", "test");
    const { value: onlyFixture, err: err1 } = await withoutToolsCapturingStderr(() => ext.extract(root, [fixture]));
    assert.deepEqual(onlyFixture.degraded, []);
    assert.equal(onlyFixture.errors.length > 0, true, "still unclaimed → tree-sitter handles it");

    const product = write(root, "src/App.cs", "class App {}\n");
    const { value: withProduct, err: err2 } = await withoutToolsCapturingStderr(() => ext.extract(root, [fixture, product]));
    assert.equal(withProduct.degraded?.length, 1);
    assert.match(withProduct.degraded[0]!, /^csharp: 1 file\(s\) via tree-sitter \(syntactic\) — run `leina sidecar build csharp`/);
    assert.deepEqual(withProduct.diagnostics, [], "the nudge is not also a diagnostic");
    assert.equal(err1 + err2, "", "the extractor itself prints nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(noise-3) SCIP extractor: no note for vendored/example Go, one note for product Go, never prints", async () => {
  const { ScipExtractor } = await import("../src/infrastructure/extractors/semantic/scip.ts");
  const root = mkdtempSync(join(tmpdir(), "leina-noise-go-"));
  try {
    const vendored = write(root, "vendor/x/y.go", "package y\n");
    const example = write(root, "examples/demo/main.go", "package main\n");
    const ext = new ScipExtractor("go", "test");
    const { value: aux, err: err1 } = await withoutToolsCapturingStderr(() => ext.extract(root, [vendored, example]));
    assert.deepEqual(aux.degraded, []);

    const product = write(root, "cmd/server/main.go", "package main\n");
    const { value: real, err: err2 } = await withoutToolsCapturingStderr(() => ext.extract(root, [vendored, product]));
    assert.equal(real.degraded?.length, 1);
    assert.match(real.degraded[0]!, /^go: 1 file\(s\) via tree-sitter \(syntactic\) — run `leina scip install go`/);
    assert.equal(err1 + err2, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: EMPTY_PATH, LEINA_DISABLE_AUTOBUILD: "1" },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

test("(noise-4) explicit build prints each note once; a read-path auto-rebuild prints none", () => {
  const root = mkdtempSync(join(tmpdir(), "leina-noise-cli-"));
  try {
    write(root, "src/App.cs", "class App { void Run() {} }\n");
    write(root, "test/fixtures/Fixture.java", "class Fixture {}\n");
    write(root, "examples/demo/main.go", "package main\nfunc main() {}\n");
    write(root, "src/index.ts", "export function entry(): number { return 1; }\n");

    const build = runCli(["build", root]);
    assert.equal(build.code, 0, build.stderr);
    const all = `${build.stdout}\n${build.stderr}`;
    assert.equal(all.match(/via tree-sitter/g)?.length, 1, `one C# note, nothing for fixture Java / example Go:\n${all}`);
    assert.match(build.stderr, /^ {2}note: csharp: 1 file\(s\) via tree-sitter/m);
    assert.doesNotMatch(build.stdout, /C#\/Java|sidecar/, "the Done line no longer repeats it");
    assert.doesNotMatch(all, /files detected|indexer not found|not configured/);

    write(root, "src/App.cs", "class App { void Run() {} void Stop() {} }\n");
    const query = runCli(["query", root, "Stop"]);
    assert.equal(query.code, 0, query.stderr);
    const lines = query.stderr.split("\n").filter((l) => l.trim() !== "");
    assert.deepEqual(lines, ["leina: graph stale (touched:src/App.cs); rebuilding ..."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
