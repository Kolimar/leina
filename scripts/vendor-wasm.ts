// vendor-wasm — MAINTAINER tool: (re)vendor the tree-sitter grammar .wasm files leina actually
// uses INTO this package's assets/wasm/, so the published tarball ships its own parser assets
// instead of depending on grammar packages at install time.
//
// Two sources:
//   · the 11 code grammars (GRAMMAR_WASM_FILES from parser-assets.ts) are copied from
//     node_modules/tree-sitter-wasms/out — a devDependency kept so this script works across
//     version bumps; it must NOT be a runtime dependency (see parser-assets.ts wasmAssetsDir()).
//   · tree-sitter-yaml.wasm comes from the maintained grammar's own npm tarball
//     (@tree-sitter-grammars/tree-sitter-yaml, pinned below), fetched with `npm pack` at vendor
//     time. tree-sitter-wasms' yaml build (ikatyang grammar, C++ scanner, tree-sitter-cli 0.20)
//     imports libc++ symbols (_Znwm, _ZdlPv, __throw_length_error) that web-tree-sitter 0.25's
//     runtime does not export: Language.load() succeeds and the first parse() throws, so every
//     YAML file silently fell back to the line-based extractor. The maintained grammar has a C
//     scanner and ships a wasm built by tree-sitter-cli 0.25 (ABI 14). Its sha256 is pinned:
//     a bumped spec must come with a re-verified hash (and a run of test/yaml-extractor.test.ts).
//
// Usage (needs network for the yaml tarball):
//   node --no-warnings --experimental-strip-types scripts/vendor-wasm.ts
//
// Idempotent: replaces the vendored *.wasm + checksums.json (LICENSES.md is hand-maintained
// and left alone), then re-hashes.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { GRAMMAR_WASM_FILES, YAML_WASM_FILE } from "../src/infrastructure/extractors/parser-assets.ts";

const YAML_GRAMMAR_SPEC = "@tree-sitter-grammars/tree-sitter-yaml@0.7.1";
const YAML_WASM_SHA256 = "e752dc21c3591df9b45692fe417d101f45d1828c28c44d79005f4066dc7e4e91";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let sourceDir: string;
try {
  sourceDir = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
} catch {
  console.error(
    "tree-sitter-wasms is not installed — it is a devDependency, run `npm install` first.",
  );
  process.exit(1);
}

const destDir = join(repoRoot, "assets", "wasm");
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The bytes of `entry` inside a .tgz (ustar), or null. Enough tar for an npm tarball. */
function readTarEntry(tgz: Buffer, entry: string): Buffer | null {
  const tar = gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (name === "") return null; // end-of-archive marker
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const full = prefix ? `${prefix}/${name}` : name;
    if (full === entry) return Buffer.from(tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Fetch the pinned yaml grammar tarball with `npm pack` and return its verified wasm. */
function fetchYamlWasm(): Buffer {
  const work = mkdtempSync(join(tmpdir(), "leina-vendor-yaml-"));
  try {
    execFileSync("npm", ["pack", YAML_GRAMMAR_SPEC, "--pack-destination", work, "--silent"], {
      stdio: ["ignore", "ignore", "inherit"],
      shell: process.platform === "win32",
    });
    const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`npm pack ${YAML_GRAMMAR_SPEC} produced no tarball`);
    const wasm = readTarEntry(readFileSync(join(work, tgz)), `package/${YAML_WASM_FILE}`);
    if (!wasm) throw new Error(`${YAML_GRAMMAR_SPEC} does not ship ${YAML_WASM_FILE}`);
    const got = sha256(wasm);
    if (got !== YAML_WASM_SHA256) {
      throw new Error(`${YAML_WASM_FILE} from ${YAML_GRAMMAR_SPEC}: sha256 ${got} != pinned ${YAML_WASM_SHA256}`);
    }
    return wasm;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const codeWasms = [...new Set(Object.values(GRAMMAR_WASM_FILES))].sort();
const missing = codeWasms.filter((f) => !existsSync(join(sourceDir, f)));
if (missing.length > 0) {
  console.error(`Missing grammar wasm(s) in ${sourceDir}: ${missing.join(", ")}`);
  process.exit(1);
}

let yamlWasm: Buffer;
try {
  yamlWasm = fetchYamlWasm();
} catch (err) {
  console.error(`Could not vendor ${YAML_WASM_FILE}: ${(err as Error).message}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
for (const f of readdirSync(destDir)) {
  if (f.endsWith(".wasm") || f === "checksums.json") rmSync(join(destDir, f));
}

const checksums: Record<string, string> = {};
for (const file of codeWasms) {
  const to = join(destDir, file);
  cpSync(join(sourceDir, file), to);
  checksums[file] = sha256(readFileSync(to));
}
writeFileSync(join(destDir, YAML_WASM_FILE), yamlWasm);
checksums[YAML_WASM_FILE] = sha256(yamlWasm);

const sorted = Object.fromEntries(Object.entries(checksums).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(destDir, "checksums.json"), `${JSON.stringify(sorted, null, 2)}\n`);

console.log(`Vendored ${Object.keys(sorted).length} grammar wasm(s) -> ${destDir}`);
console.log(`Wrote ${join(destDir, "checksums.json")}`);
