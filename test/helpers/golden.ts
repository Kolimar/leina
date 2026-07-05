// test/helpers/golden.ts — Helper de golden tests para la suite de validación.
//
// assertGolden(name, actual): compara actual con el golden en test/fixtures/golden/<name>.
// Si UPDATE_GOLDENS==="1" o el golden no existe, lo crea/actualiza y retorna sin fallar.
// Deps: solo node:fs, node:path, node:assert/strict.
//
// FAKE_VIS: stub canónico de vis-network para golden tests (byte-estable entre OS).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// fileURLToPath, NOT URL.pathname: on Windows the pathname of a file URL is
// "/D:/…", which path.join/mkdir then mangle into "D:\D:\…" (ENOENT on CI).
const GOLDEN_DIR = fileURLToPath(new URL("../fixtures/golden/", import.meta.url));

export const FAKE_VIS =
  "/* vis-network stub (golden) */\n" +
  "var vis={DataSet:function(){return{};},Network:function(){return{on:function(){}};}};";

export function assertGolden(name: string, actual: string): void {
  const file = join(GOLDEN_DIR, name);
  const update = process.env.UPDATE_GOLDENS === "1";
  if (update || !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  const expected = readFileSync(file, "utf8");
  assert.strictEqual(
    actual,
    expected,
    `Golden mismatch: ${name}. Run UPDATE_GOLDENS=1 npm test to regenerate.`,
  );
}
