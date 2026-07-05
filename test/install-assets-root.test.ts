// install-assets-root.test.ts — guards entryAssetsRootFrom in src/infrastructure/install/global.ts.
//
// Regression: a global install exposes the CLI through an npm bin SYMLINK
// (<prefix>/bin/leina -> <prefix>/lib/node_modules/<pkg>/dist/cli/index.js).
// path.resolve keeps the symlink location, so anchoring the bundled assets/ there
// resolved to <prefix>/assets and `activate` failed with
// "ENOENT ... stat '<prefix>/assets/skills'". The entry must be realpath'd so the
// anchor lands on the real dist/cli/index.js inside the package.
//
// Run: node --no-warnings --experimental-strip-types --test test/install-assets-root.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryAssetsRootFrom } from "../src/infrastructure/install/global.ts";

// Windows runners may lack the symlink privilege (Developer Mode); when the probe fails,
// symlink-SHAPE assertions are skipped — linkOrCopy falls back to copy there by design,
// and the existence/content assertions still run.
const SYMLINKS_OK = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), "leina-symprobe-"));
    writeFileSync(join(d, "t"), "");
    symlinkSync(join(d, "t"), join(d, "l"));
    rmSync(d, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();


test("(IA-1) entryAssetsRootFrom dereferences an npm bin symlink to the package assets", { skip: !SYMLINKS_OK && "symlink privilege unavailable" }, () => {
  const root = mkdtempSync(join(tmpdir(), "leina-entry-"));
  try {
    const pkg = join(root, "lib", "node_modules", "pkg");
    mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
    mkdirSync(join(pkg, "assets"), { recursive: true });
    const entry = join(pkg, "dist", "cli", "index.js");
    writeFileSync(entry, "// cli entry\n");

    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const link = join(binDir, "leina");
    symlinkSync(entry, link);

    // Invoked via the bin symlink: assets must resolve inside the package, NOT next
    // to the symlink (the pre-fix bug pointed at <root>/assets).
    // realpath both sides: the entry resolver dereferences symlinks, and on macOS
    // tmpdir() (/var/...) is itself a symlink to /private/var/..., so the expected
    // side must be realpath'd too to avoid a spurious /private prefix mismatch.
    assert.equal(realpathSync(entryAssetsRootFrom(link)), realpathSync(join(pkg, "assets")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(IA-2) entryAssetsRootFrom resolves assets next to a real (non-symlinked) entry", () => {
  const root = mkdtempSync(join(tmpdir(), "leina-entry-"));
  try {
    const pkg = join(root, "pkg");
    mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
    mkdirSync(join(pkg, "assets"), { recursive: true });
    const entry = join(pkg, "dist", "cli", "index.js");
    writeFileSync(entry, "// cli entry\n");

    assert.equal(realpathSync(entryAssetsRootFrom(entry)), realpathSync(join(pkg, "assets")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(IA-3) pnpm layout: two-hop chain (bin symlink → symlinked package dir → real store)", { skip: !SYMLINKS_OK && "symlink privilege unavailable" }, () => {
  // pnpm's global layout links the bin into a node_modules/<pkg> that is ITSELF a symlink
  // into the content-addressed .pnpm store:
  //   <pnpm-home>/leina -> <global>/node_modules/leina/dist/cli/index.js
  //   <global>/node_modules/leina -> <global>/node_modules/.pnpm/leina@2/node_modules/leina
  // realpath must collapse the WHOLE chain, or assets would resolve inside a half-virtual path.
  const root = mkdtempSync(join(tmpdir(), "leina-entry-"));
  try {
    const store = join(root, "global", "node_modules", ".pnpm", "leina@2.0.0", "node_modules", "leina");
    mkdirSync(join(store, "dist", "cli"), { recursive: true });
    mkdirSync(join(store, "assets"), { recursive: true });
    writeFileSync(join(store, "dist", "cli", "index.js"), "// cli entry\n");

    const pkgLink = join(root, "global", "node_modules", "leina");
    symlinkSync(store, pkgLink, "dir");

    const binDir = join(root, "pnpm-home");
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, "leina");
    symlinkSync(join(pkgLink, "dist", "cli", "index.js"), bin);

    assert.equal(realpathSync(entryAssetsRootFrom(bin)), realpathSync(join(store, "assets")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(IA-4) RELATIVE bin symlink (npm's actual on-disk form) resolves into the package", { skip: !SYMLINKS_OK && "symlink privilege unavailable" }, () => {
  const root = mkdtempSync(join(tmpdir(), "leina-entry-"));
  try {
    const pkg = join(root, "lib", "node_modules", "pkg");
    mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
    mkdirSync(join(pkg, "assets"), { recursive: true });
    writeFileSync(join(pkg, "dist", "cli", "index.js"), "// cli entry\n");

    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const link = join(binDir, "leina");
    symlinkSync(join("..", "lib", "node_modules", "pkg", "dist", "cli", "index.js"), link);

    assert.equal(realpathSync(entryAssetsRootFrom(link)), realpathSync(join(pkg, "assets")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
