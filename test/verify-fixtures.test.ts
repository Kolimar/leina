// verify-fixtures.test.ts — `leina sidecar verify` / `leina scip verify` run against fixtures
// that SHIP with the package (assets/fixtures/), so they work from an installed leina.
//
// Before: both pointed at <package>/test/fixtures/..., which is not published (package.json
// "files" is dist + assets) — from any npm install the C#/Java verify ran its sidecar on a
// missing dir and the SCIP verify spawned its indexer with a non-existent cwd. The C#/Java
// fixtures were also empty files, and a configured prebuilt sidecar was reported as "skip"
// whenever the build toolchain (dotnet / JDK) was absent.
// Run: node --no-warnings --experimental-strip-types --test test/verify-fixtures.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyFixtureDir } from "../src/infrastructure/extractors/semantic/verify-fixtures.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(PKG, "src", "cli", "index.ts");
const SANDBOX = mkdtempSync(join(tmpdir(), "leina-verify-fx-"));
const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: join(SANDBOX, "home"),
  LEINA_HOME: join(SANDBOX, "leina-home"), // no built sidecars
};
delete BASE_ENV.LEINA_CSHARP_SIDECAR;
delete BASE_ENV.LEINA_JAVA_SIDECAR;
mkdirSync(join(SANDBOX, "home"), { recursive: true });
test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** Files under `root`, as root-relative POSIX paths. */
function filesUnder(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(root, p));
    else out.push(relative(root, p).split("\\").join("/"));
  }
  return out.sort();
}

function runCli(args: string[], env: NodeJS.ProcessEnv): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    env,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

test("(vfx-1) the verify fixtures live under the published assets/ and hold real sources", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes("assets"), "assets/ is published");
  assert.ok(!pkg.files.some((f) => f === "test" || f.startsWith("test/")), "test/ is not");

  const expected: [string[], RegExp][] = [
    [["csharp"], /\.cs$/],
    [["java"], /\.java$/],
    [["scip", "go"], /\.go$/],
    [["scip", "rust"], /\.rs$/],
    [["scip", "python"], /\.py$/],
  ];
  for (const [segments, ext] of expected) {
    const dir = verifyFixtureDir(...segments);
    assert.equal(relative(PKG, dir).split("\\").join("/"), `assets/fixtures/${segments.join("/")}`);
    const sources = filesUnder(dir).filter((f) => ext.test(f));
    assert.ok(sources.length > 0, `${segments.join("/")}: has sources`);
    for (const f of sources) assert.ok(statSync(join(dir, f)).size > 0, `${f} is not empty`);
  }
  // The project manifests the indexers need ship alongside the sources.
  for (const f of ["scip/go/go.mod", "scip/rust/Cargo.toml", "scip/rust/Cargo.lock"]) {
    assert.ok(existsSync(verifyFixtureDir(...f.split("/"))), f);
  }
});

/** A stand-in sidecar: records the dir it was pointed at, prints one node per source in it. */
function fakeSidecar(ext: string, empty = false): { cmd: string; seen: string } {
  const seen = join(SANDBOX, `seen-${ext}-${empty ? "empty" : "full"}.txt`);
  const script = join(SANDBOX, `fake-sidecar-${ext}-${empty ? "empty" : "full"}.mjs`);
  writeFileSync(
    script,
    `import { readdirSync, writeFileSync } from "node:fs";\n` +
      `const target = process.argv.at(-1);\n` +
      `writeFileSync(${JSON.stringify(seen)}, target);\n` +
      `const files = ${empty ? "[]" : `readdirSync(target).filter((f) => f.endsWith(${JSON.stringify(ext)}))`};\n` +
      `const nodes = files.map((f) => ({ id: f, label: f, kind: "file", sourceFile: f }));\n` +
      `process.stdout.write(JSON.stringify({ nodes, edges: [] }));\n`,
  );
  return { cmd: `${process.execPath} ${script}`, seen };
}

test("(vfx-2) sidecar verify runs a configured sidecar over the shipped fixture, toolchain or not", () => {
  const fake = fakeSidecar(".java");
  // PATH without javac/jar/jpackage: an installed (prebuilt) sidecar must still be verified.
  const emptyPath = join(SANDBOX, "empty-path");
  mkdirSync(emptyPath, { recursive: true });
  const r = runCli(["sidecar", "verify", "java"], { ...BASE_ENV, PATH: emptyPath, LEINA_JAVA_SIDECAR: fake.cmd });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^java: ok$/m);
  assert.match(r.stdout, /nodes=1 edges=0/);
  assert.equal(readFileSync(fake.seen, "utf8"), verifyFixtureDir("java"));
});

test("(vfx-3) a sidecar that returns an empty graph for the fixture fails verify (exit 1)", () => {
  const fake = fakeSidecar(".cs", true);
  const r = runCli(["sidecar", "verify", "csharp"], { ...BASE_ENV, LEINA_CSHARP_SIDECAR: fake.cmd });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /csharp: FAIL — the csharp sidecar returned an empty graph for the verify fixture/);
});

test("(vfx-4) no sidecar: skip names the command that fixes it", () => {
  const emptyPath = join(SANDBOX, "empty-path");
  mkdirSync(emptyPath, { recursive: true });
  const r = runCli(["sidecar", "verify", "csharp"], { ...BASE_ENV, PATH: emptyPath });
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /^csharp: skip — sidecar not installed for csharp, and the toolchain to build it is unavailable \(missing in PATH: dotnet\) — run `leina sidecar install csharp`/m,
  );
});

test("(vfx-5) scip verify runs the indexer inside the shipped fixture", () => {
  // A stand-in scip-go: records its cwd and writes the committed real index as its output.
  const realIndex = join(PKG, "test", "fixtures", "scip", "go", "index.scip");
  const seen = join(SANDBOX, "seen-scip-go.txt");
  const script = join(SANDBOX, "fake-scip-go.mjs");
  writeFileSync(
    script,
    `import { copyFileSync, writeFileSync } from "node:fs";\n` +
      `const args = process.argv.slice(2);\n` +
      `writeFileSync(${JSON.stringify(seen)}, process.cwd());\n` +
      `copyFileSync(${JSON.stringify(realIndex)}, args[args.indexOf("--output") + 1]);\n`,
  );
  const r = runCli(["scip", "verify", "go"], { ...BASE_ENV, LEINA_SCIP_GO_INDEXER: `${process.execPath} ${script}` });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^go: ok$/m);
  assert.match(r.stdout, /nodes=[1-9]\d* edges=\d+/);
  assert.equal(readFileSync(seen, "utf8"), verifyFixtureDir("scip", "go"));
});
