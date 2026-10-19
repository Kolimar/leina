// Unit tests for the graph freshness layer: the build manifest + isStale, and
// the freshness posture config loader. Run via: npm test (matches test/*.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { listSourceFiles } from "../src/application/graph/sources.ts";
import {
  writeManifest,
  readManifest,
  isStale,
  manifestPath,
  fullExtractionReason,
  graphStatus,
  EXTRACTOR_SCHEMA_VERSION,
} from "../src/application/graph/manifest.ts";
import { readPackageVersion } from "../src/version.ts";
import { loadFreshnessConfig } from "../src/infrastructure/config/freshness.ts";

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "leina-fresh-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
  return dir;
}

function stamp(dir: string): void {
  writeManifest(dir, listSourceFiles(dir));
}

// --- source discovery -------------------------------------------------------

test("listSourceFiles: .NET build outputs (obj/, bin/) are not sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-fresh-"));
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "obj", "Debug"), { recursive: true });
    mkdirSync(join(dir, "bin", "Debug"), { recursive: true });
    writeFileSync(join(dir, "src", "App.cs"), "class App {}\n");
    writeFileSync(join(dir, "obj", "Debug", "App.g.cs"), "class Generated {}\n");
    writeFileSync(join(dir, "bin", "Debug", "Copied.cs"), "class Copied {}\n");

    const files = listSourceFiles(dir);
    assert.deepEqual(files, [join(dir, "src", "App.cs")]);

    // A dotnet build regenerating obj/ must not re-stale the graph.
    writeManifest(dir, files);
    writeFileSync(join(dir, "obj", "Debug", "Fresh.g.cs"), "class Fresh {}\n");
    const r = isStale(dir);
    assert.equal(r.stale, false);
    assert.equal(r.reason, "fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSourceFiles: minified artifacts (*.min.js et al) are not sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-fresh-"));
  try {
    mkdirSync(join(dir, "assets", "vis-network"), { recursive: true });
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "assets", "vis-network", "vis-network.min.js"), "var a=1;\n");
    writeFileSync(join(dir, "assets", "styles.min.css"), "body{}\n");
    // NOT minified-named — must survive the filter.
    writeFileSync(join(dir, "assets", "admin.js"), "const b = 2;\n");

    const files = listSourceFiles(dir);
    assert.deepEqual(files.sort(), [join(dir, "app.ts"), join(dir, "assets", "admin.js")].sort());

    // Re-copying a vendored bundle must not re-stale the graph.
    writeManifest(dir, files);
    writeFileSync(join(dir, "assets", "vis-network", "vis-network.min.js"), "var a=2;\n");
    const r = isStale(dir);
    assert.equal(r.stale, false);
    assert.equal(r.reason, "fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- isStale matrix ---------------------------------------------------------

test("isStale: untouched manifest is fresh", () => {
  const dir = freshRepo();
  try {
    stamp(dir);
    const r = isStale(dir);
    assert.equal(r.stale, false);
    assert.equal(r.reason, "fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale: missing manifest is stale (no-manifest)", () => {
  const dir = freshRepo();
  try {
    const r = isStale(dir);
    assert.equal(r.stale, true);
    assert.equal(r.reason, "no-manifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale: corrupt manifest is stale (no-manifest)", () => {
  const dir = freshRepo();
  try {
    stamp(dir);
    writeFileSync(manifestPath(dir), "{ not valid json", "utf8");
    const r = isStale(dir);
    assert.equal(r.stale, true);
    assert.equal(r.reason, "no-manifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale: added source file is stale (added:<rel>)", () => {
  const dir = freshRepo();
  try {
    stamp(dir);
    writeFileSync(join(dir, "c.ts"), "export const c = 3;\n");
    const r = isStale(dir);
    assert.equal(r.stale, true);
    assert.equal(r.reason, "added:c.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale: removed source file is stale (removed:<rel>)", () => {
  const dir = freshRepo();
  try {
    stamp(dir);
    unlinkSync(join(dir, "b.ts"));
    const r = isStale(dir);
    assert.equal(r.stale, true);
    assert.equal(r.reason, "removed:b.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale: changed content is stale (touched:<rel>)", () => {
  const dir = freshRepo();
  try {
    stamp(dir);
    const future = Date.now() / 1000 + 10_000;
    writeFileSync(join(dir, "a.ts"), "export const a = 999;\n");
    utimesSync(join(dir, "a.ts"), future, future);
    const r = isStale(dir);
    assert.equal(r.stale, true);
    assert.equal(r.reason, "touched:a.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale: mtime bump without content change stays fresh", () => {
  // A git checkout or save-without-edit moves the mtime but not the bytes.
  // The content hash must win over the mtime so the graph isn't needlessly rebuilt.
  const dir = freshRepo();
  try {
    stamp(dir);
    const future = Date.now() / 1000 + 10_000;
    utimesSync(join(dir, "a.ts"), future, future);
    const r = isStale(dir);
    assert.equal(r.stale, false);
    assert.equal(r.reason, "fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest: written shape carries version, commitSha, hashes and POSIX relpaths", () => {
  const dir = freshRepo();
  try {
    stamp(dir);
    const m = readManifest(dir);
    assert.ok(m);
    assert.equal(m.manifestVersion, 3);
    assert.equal(typeof m.leinaVersion, "string");
    assert.equal(m.extractorSchema, EXTRACTOR_SCHEMA_VERSION);
    assert.deepEqual(m.degraded, []);
    assert.equal(m.fileCount, 2);
    assert.ok(m.builtAt > 0);
    // tmpdir is not a git repo → commitSha is null; in a repo it'd be a hex string.
    assert.ok(m.commitSha === null || typeof m.commitSha === "string");
    assert.ok("a.ts" in m.files);
    assert.ok("b.ts" in m.files);
    assert.equal(typeof m.files["a.ts"].hash, "string");
    assert.ok(m.files["a.ts"].hash.length === 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- build basis: leina version, extractor schema, resolution configs --------

/** Rewrite fields of the stamped manifest in place (simulates one written by another leina). */
function patchManifest(dir: string, patch: (m: Record<string, unknown>) => void): void {
  const m = JSON.parse(readFileSync(manifestPath(dir), "utf8")) as Record<string, unknown>;
  patch(m);
  writeFileSync(manifestPath(dir), JSON.stringify(m), "utf8");
}

test("(basis-1) a graph stamped by an older leina (manifest v2) is stale: 'leina upgraded'", () => {
  const dir = freshRepo();
  try {
    stamp(dir);
    patchManifest(dir, (m) => {
      m.manifestVersion = 2;
      delete m.leinaVersion;
      delete m.extractorSchema;
      delete m.configs;
    });
    const r = isStale(dir);
    assert.equal(r.stale, true);
    assert.equal(r.reason, `leina upgraded (graph built by an older leina → ${readPackageVersion()})`);
    assert.equal(readManifest(dir), null, "an old-format manifest is never read as current");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(basis-2) another leina version or extractor schema makes an untouched graph stale", () => {
  const dir = freshRepo();
  try {
    stamp(dir);
    patchManifest(dir, (m) => (m.leinaVersion = "0.0.1"));
    assert.equal(isStale(dir).reason, `leina upgraded (0.0.1 → ${readPackageVersion()})`);
    patchManifest(dir, (m) => (m.leinaVersion = "999.0.0"));
    assert.equal(isStale(dir).reason, `leina downgraded (999.0.0 → ${readPackageVersion()})`);
    patchManifest(dir, (m) => {
      m.leinaVersion = readPackageVersion();
      m.extractorSchema = EXTRACTOR_SCHEMA_VERSION - 1;
    });
    assert.equal(
      isStale(dir).reason,
      `extractor changed (schema ${EXTRACTOR_SCHEMA_VERSION - 1} → ${EXTRACTOR_SCHEMA_VERSION})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(basis-3) tsconfig/jsconfig/package.json edits, additions and removals make the graph stale", () => {
  const dir = freshRepo();
  try {
    writeFileSync(join(dir, "tsconfig.json"), `{"compilerOptions":{"paths":{}}}\n`);
    stamp(dir);
    assert.equal(isStale(dir).reason, "fresh");

    // mtime-only bump (checkout, save-without-edit): still fresh.
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, "tsconfig.json"), later, later);
    assert.equal(isStale(dir).reason, "fresh");

    writeFileSync(join(dir, "tsconfig.json"), `{"compilerOptions":{"paths":{"@/*":["src/*"]}}}\n`);
    utimesSync(join(dir, "tsconfig.json"), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    assert.deepEqual(isStale(dir), { stale: true, reason: "config changed:tsconfig.json" });

    stamp(dir);
    mkdirSync(join(dir, "packages", "a"), { recursive: true });
    writeFileSync(join(dir, "packages", "a", "package.json"), `{"name":"a"}\n`);
    assert.deepEqual(isStale(dir), { stale: true, reason: "config changed:packages/a/package.json" });

    stamp(dir);
    unlinkSync(join(dir, "tsconfig.json"));
    assert.deepEqual(isStale(dir), { stale: true, reason: "config changed:tsconfig.json" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(basis-4) fullExtractionReason: null when the basis matches, the reason otherwise", () => {
  const dir = freshRepo();
  try {
    assert.equal(fullExtractionReason(dir), "no previous build");
    writeFileSync(join(dir, "jsconfig.json"), "{}\n");
    stamp(dir);
    assert.equal(fullExtractionReason(dir), null);
    // A plain source edit does not invalidate the basis — only that file's own result.
    writeFileSync(join(dir, "a.ts"), "export const a = 42;\n");
    assert.equal(fullExtractionReason(dir), null);

    writeFileSync(join(dir, "jsconfig.json"), `{"compilerOptions":{"baseUrl":"."}}\n`);
    utimesSync(join(dir, "jsconfig.json"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    assert.equal(fullExtractionReason(dir), "config changed:jsconfig.json");

    stamp(dir);
    patchManifest(dir, (m) => (m.extractorSchema = -1));
    assert.match(fullExtractionReason(dir) ?? "", /^extractor changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(basis-5) degraded notes are stamped and surface in graphStatus", () => {
  const dir = freshRepo();
  try {
    writeManifest(dir, listSourceFiles(dir), { degraded: ["csharp: 3 file(s) via tree-sitter (syntactic)"] });
    assert.deepEqual(graphStatus(dir).degraded, ["csharp: 3 file(s) via tree-sitter (syntactic)"]);
    assert.equal(graphStatus(dir).stale, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- freshness config -------------------------------------------------------

const ENV_KEY = "LEINA_FRESHNESS";

test("config: defaults to auto with no env and no file", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-cfg-"));
  const prev = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  try {
    assert.equal(loadFreshnessConfig(dir), "auto");
  } finally {
    if (prev !== undefined) process.env[ENV_KEY] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: config.json freshness is honored", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-cfg-"));
  const prev = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(
      join(dir, ".leina", "config.json"),
      JSON.stringify({ freshness: "refuse" }),
      "utf8",
    );
    assert.equal(loadFreshnessConfig(dir), "refuse");
  } finally {
    if (prev !== undefined) process.env[ENV_KEY] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: env overrides config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-cfg-"));
  const prev = process.env[ENV_KEY];
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(
      join(dir, ".leina", "config.json"),
      JSON.stringify({ freshness: "auto" }),
      "utf8",
    );
    process.env[ENV_KEY] = "refuse";
    assert.equal(loadFreshnessConfig(dir), "refuse");
  } finally {
    if (prev !== undefined) process.env[ENV_KEY] = prev;
    else delete process.env[ENV_KEY];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: invalid value falls through to default", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-cfg-"));
  const prev = process.env[ENV_KEY];
  try {
    process.env[ENV_KEY] = "banana";
    assert.equal(loadFreshnessConfig(dir), "auto");
  } finally {
    if (prev !== undefined) process.env[ENV_KEY] = prev;
    else delete process.env[ENV_KEY];
    rmSync(dir, { recursive: true, force: true });
  }
});
