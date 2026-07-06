// architecture.test.ts — Static import layering guard.
//
// Asserts the hexagonal layering: domain is pure, application depends on no
// infrastructure module, infrastructure never imports the cli driving adapter,
// and the heavy extractor libs stay confined to infrastructure/extractors/.
// All five rules are ACTIVE now that the DDD reorg has landed.
//
// Node:test, zero external dependencies. Import analysis is done via regex on
// raw file content — no AST parser needed for these structural assertions.
//
// Run: node --no-warnings --experimental-strip-types --test test/architecture.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// NFR-03 (graph-serve, task 5.2): the whole feature (project registry, `memory reanchor`,
// `graph serve` + JSON API, the vanilla explorer UI) MUST NOT add new production dependencies.
// Frozen at the state of `package.json#dependencies` measured on commit `2f8246e` — the last
// commit BEFORE the graph-serve change started (ola 1, `3e582b3`) — and re-verified unchanged
// through every subsequent ola (2f8246e..f72284e). Any NEW key added to `dependencies` fails
// this test; removing a baseline dependency is fine (the guard is "no new", not "exactly this
// set frozen forever").
const FROZEN_PRODUCTION_DEPENDENCIES = new Set([
  "@clack/prompts",
  "@modelcontextprotocol/sdk",
  "ts-morph",
  "web-tree-sitter",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SRC = join(ROOT, "src");

/** Recursively find all .ts files under `dir`. */
function walkTs(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true }) as {
    name: string;
    parentPath: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }[];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".ts")) {
      results.push(join(e.parentPath, e.name));
    }
  }
  return results;
}

/** Relative path from SRC root, using forward slashes for consistent matching. */
function rel(absPath: string): string {
  return relative(SRC, absPath).split(sep).join("/");
}

/**
 * Return all static import module specifiers found in `content`.
 *
 * Matches both single-line and multiline import forms:
 *   import { foo } from "bar"
 *   import type { Foo } from "bar"
 *   import "bar"
 *
 * Does NOT match dynamic imports: `import("bar")` / `await import("bar")`.
 *
 * Implementation: scan for `from "specifier"` or `import "specifier"` that
 * appear in a static declaration context. We detect the static context by
 * requiring that the line with `from "..."` is not preceded by `(` on the
 * same line (which would indicate a dynamic import call expression).
 */
function staticImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];

  // Match: import ... from "specifier"  (single-line or the `from "..."` part
  // of a multiline import).  Require the line NOT to contain a bare `(` before
  // the keyword — that would indicate it is inside a dynamic import() call.
  const fromRe = /^(?!.*\bimport\s*\().*\bfrom\s+["']([^"']+)["']/gm;
  for (const m of content.matchAll(fromRe)) {
    specifiers.push(m[1]!);
  }

  // Match: import "specifier"  (side-effect import — no bindings, no `from`)
  const bareRe = /^import\s+["']([^"']+)["']/gm;
  for (const m of content.matchAll(bareRe)) {
    specifiers.push(m[1]!);
  }

  return specifiers;
}

// ---------------------------------------------------------------------------
// Rule 1: domain/ purity — files under src/domain/ MUST NOT import from
//         application/, infrastructure/, or cli/.
//
// Status: ACTIVE (domain/ folder is created in PR-1).
// ---------------------------------------------------------------------------

test("arch-rule-1: src/domain/** has no imports from application/, infrastructure/, or cli/", () => {
  const domainDir = join(SRC, "domain");
  let domainFiles: string[];
  try {
    domainFiles = walkTs(domainDir);
  } catch {
    // domain/ doesn't exist yet — nothing to check (safe for pre-PR-1 runs).
    return;
  }

  const forbidden = ["application/", "infrastructure/", "cli/"];
  const violations: string[] = [];

  for (const file of domainFiles) {
    const content = readFileSync(file, "utf8");
    const specifiers = staticImportSpecifiers(content);
    for (const spec of specifiers) {
      // Convert the specifier to a normalised relative path for checking.
      // Absolute imports (node: builtins, npm packages) don't contain these
      // directory segments, so they're safe.
      for (const segment of forbidden) {
        if (spec.includes(segment)) {
          violations.push(`${rel(file)} imports from '${spec}' (forbidden segment: ${segment.slice(0, -1)})`);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `domain/ purity violations found:\n${violations.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// Rule 2: lazy-extractor guard — `web-tree-sitter` and `ts-morph` MUST NOT
//         appear as static top-level imports in any file outside src/extractors/.
//
// These heavy libraries are ONLY permitted as static imports in:
//   src/extractors/treesitter.ts        (web-tree-sitter)
//   src/extractors/semantic/tsmorph.ts  (ts-morph)
//
// All other files that need the extractor stack MUST use dynamic
// `await import(...)` to avoid pulling the libraries into the startup
// module graph of query/memory/status commands.
//
// Status: ACTIVE now — this is a pre-existing property of the codebase
//         that we lock in immediately with PR-1. See REQ-DEP-02.
// ---------------------------------------------------------------------------

test("arch-rule-2: web-tree-sitter and ts-morph are not statically imported outside src/extractors/", () => {
  const allFiles = walkTs(SRC);
  const heavyLibs = ["web-tree-sitter", "ts-morph"];

  // These are the ONLY files allowed to have static imports of the heavy libraries
  // (the canonical DDD adapter paths under infrastructure/extractors/).
  const allowedPaths = new Set([
    "infrastructure/extractors/treesitter.ts",
    "infrastructure/extractors/semantic/tsmorph.ts",
    "infrastructure/extractors/yaml.ts",
  ]);

  const violations: string[] = [];

  for (const file of allFiles) {
    const relPath = rel(file);
    if (allowedPaths.has(relPath)) continue;

    const content = readFileSync(file, "utf8");
    const specifiers = staticImportSpecifiers(content);

    for (const spec of specifiers) {
      if (heavyLibs.includes(spec)) {
        violations.push(
          `${relPath} statically imports '${spec}' (must use dynamic import outside src/extractors/)`,
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Lazy-extractor guard violations found:\n${violations.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// Rule 3: application/ layer purity. Files under src/application/ MUST NOT
// directly import infrastructure modules (node:sqlite, node:child_process,
// web-tree-sitter, ts-morph) — all infra access goes through domain ports (REQ-DEP-01).
//
// Status: ACTIVE (the DDD reorg landed; src/application/ holds real use-cases).
// ---------------------------------------------------------------------------

test("arch-rule-3: src/application/** imports no infrastructure modules", () => {
  // When active, check that no file under src/application/ imports:
  //   node:sqlite, node:fs, node:child_process, web-tree-sitter, ts-morph
  // and verify all infra access is mediated through domain port interfaces.
  const applicationDir = join(SRC, "application");
  let files: string[];
  try {
    files = walkTs(applicationDir);
  } catch {
    // application/ doesn't exist yet — test passes trivially.
    return;
  }

  const infraModules = ["node:sqlite", "node:child_process", "web-tree-sitter", "ts-morph"];
  const violations: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const specifiers = staticImportSpecifiers(content);
    for (const spec of specifiers) {
      if (infraModules.includes(spec)) {
        violations.push(`${rel(file)} imports '${spec}' (infrastructure module forbidden in application layer)`);
      }
    }
  }

  assert.deepEqual(violations, [], `application/ layer violations:\n${violations.join("\n")}`);
});

// ---------------------------------------------------------------------------
// Rule 4: infrastructure/ does not import from cli/ (the driving adapter is the
// outermost layer; adapters must not depend on it).
//
// Status: ACTIVE.
// ---------------------------------------------------------------------------

test("arch-rule-4: src/infrastructure/** does not import from cli/", () => {
  // When active, verify no file under src/infrastructure/ imports from src/cli/.
  const infraDir = join(SRC, "infrastructure");
  let files: string[];
  try {
    files = walkTs(infraDir);
  } catch {
    // infrastructure/ doesn't exist yet — test passes trivially.
    return;
  }

  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const specifiers = staticImportSpecifiers(content);
    for (const spec of specifiers) {
      if (spec.includes("cli/")) {
        violations.push(`${rel(file)} imports from cli/ (forbidden in infrastructure layer)`);
      }
    }
  }

  assert.deepEqual(violations, [], `infrastructure/ → cli/ violations:\n${violations.join("\n")}`);
});

// ---------------------------------------------------------------------------
// Rule 5 (TODO — Phase 3): extractor adapters reside only in infrastructure/extractors/.
//
// After PR-reorg, the treesitter and ts-morph extractor files will have moved
// from src/extractors/ to src/infrastructure/extractors/. This rule will then
// assert that no OTHER infrastructure path imports web-tree-sitter/ts-morph,
// and no application/domain path has them at all.
//
// Status: DEFERRED — covered by Rule 2 until the reorg.
// ---------------------------------------------------------------------------

test("arch-rule-5: extractor adapters are confined to infrastructure/extractors/", () => {
  // After the DDD reorg, heavy extractor libraries (web-tree-sitter, ts-morph)
  // must only appear in infrastructure/extractors/. No other infrastructure/
  // path may import them, and domain/application must not import them at all.
  const allFiles = walkTs(SRC);
  const heavyLibs = ["web-tree-sitter", "ts-morph"];
  const allowedPrefix = "infrastructure/extractors/";

  const violations: string[] = [];
  for (const file of allFiles) {
    const relPath = rel(file);
    // Skip files in the allowed extractor directory
    if (relPath.startsWith(allowedPrefix)) continue;

    // Only check domain/, application/, and non-extractor infrastructure/ files
    if (!relPath.startsWith("domain/") && !relPath.startsWith("application/") &&
        !(relPath.startsWith("infrastructure/") && !relPath.startsWith(allowedPrefix))) continue;

    const content = readFileSync(file, "utf8");
    const specifiers = staticImportSpecifiers(content);
    for (const spec of specifiers) {
      if (heavyLibs.includes(spec)) {
        violations.push(`${relPath} statically imports '${spec}' (only allowed in ${allowedPrefix})`);
      }
    }
  }

  assert.deepEqual(violations, [], `Rule 5 violations:\n${violations.join("\n")}`);
});

// ---------------------------------------------------------------------------
// Rule 6 (NFR-03, graph-serve task 5.2): `package.json#dependencies` MUST NOT gain any
// entry beyond the frozen baseline captured before the graph-serve change. The feature is
// additive-only on top of the existing hexagonal architecture and its vanilla-JS frontend
// (design §6: "vanilla SIN build... cero deps de producción → cumple la guarda") — a new
// production dependency here would silently violate that constraint.
//
// Status: ACTIVE.
// ---------------------------------------------------------------------------

test("arch-rule-6: package.json#dependencies has no entries beyond the frozen NFR-03 baseline", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const current = Object.keys(pkg.dependencies ?? {});

  const newDependencies = current.filter((name) => !FROZEN_PRODUCTION_DEPENDENCIES.has(name));

  assert.deepEqual(
    newDependencies,
    [],
    `New production dependencies found beyond the frozen NFR-03 baseline ` +
      `(${[...FROZEN_PRODUCTION_DEPENDENCIES].join(", ")}): ${newDependencies.join(", ")}`,
  );
});
