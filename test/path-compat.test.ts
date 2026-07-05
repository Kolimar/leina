// test/path-compat.test.ts — Cross-OS path compatibility tests
//
// PC-01: normalizeProjectKey — mismo output con separadores Windows (\), POSIX (/) y drive letter
// PC-02: copyTree — test directo de copia recursiva (sin mock.module, sin flag experimental)
// PC-03: layerOf cross-OS — renderGraphHtml con sourceFile en formato Windows → grupo correcto

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeProjectKey } from "../src/application/project/detect-key.ts";
import { renderGraphHtml } from "../src/application/graph/html-export.ts";
import { copyTree } from "../src/infrastructure/install/symlinks.ts";
import type { NodeLinkGraph } from "../src/domain/graph/model.ts";
import { FAKE_VIS } from "./helpers/golden.ts";

// ── PC-01: normalizeProjectKey cross-OS ──────────────────────────────────────

test("(PC-01a) normalizeProjectKey: separadores Windows y POSIX → misma key", () => {
  const win = normalizeProjectKey("C:\\Users\\org\\repo");
  const posix = normalizeProjectKey("C:/Users/org/repo");
  assert.equal(win, "c-users-org-repo");
  assert.equal(posix, "c-users-org-repo");
  assert.equal(win, posix, "ambos formatos deben producir la misma key");
});

test("(PC-01b) normalizeProjectKey: drive letter D con backslashes", () => {
  const key = normalizeProjectKey("D:\\projects\\my-app");
  assert.equal(key, "d-projects-my-app");
});

test("(PC-01c) normalizeProjectKey: path POSIX sin drive letter → misma lógica", () => {
  const key = normalizeProjectKey("/home/user/my-repo");
  assert.equal(key, "home-user-my-repo");
});

// ── PC-03: layerOf cross-OS (vía renderGraphHtml) ────────────────────────────

test("(PC-03a) layerOf: sourceFile con separadores Windows → grupo 'application' presente", () => {
  const g: NodeLinkGraph = {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      {
        id: "fn:foo",
        label: "foo",
        fileType: "code",
        sourceFile: "src\\application\\foo.ts",
        kind: "function",
      },
    ],
    links: [],
  };
  const { content } = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  assert.ok(
    content.includes('"group":"application"'),
    "nodo con sourceFile Windows debe tener grupo 'application'",
  );
});

test("(PC-03b) layerOf: sourceFile con separadores POSIX → grupo 'application' presente", () => {
  const g: NodeLinkGraph = {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [
      {
        id: "fn:bar",
        label: "bar",
        fileType: "code",
        sourceFile: "src/application/bar.ts",
        kind: "function",
      },
    ],
    links: [],
  };
  const { content } = renderGraphHtml(g, FAKE_VIS, { projectName: "P" });
  assert.ok(
    content.includes('"group":"application"'),
    "nodo con sourceFile POSIX debe tener grupo 'application'",
  );
});

// ── PC-02: copyTree directo ───────────────────────────────────────────────────
// Sin mock.module ni --experimental-test-module-mocks.
// Cobertura de la rama EPERM queda como riesgo residual conocido (ver tasks.md open question 1).

if (process.platform !== "win32") {
  test("(PC-02) copyTree: copia recursiva de árbol src → dest", () => {
    const base = mkdtempSync(join(tmpdir(), "golden-pc02-"));
    const src = join(base, "src");
    const dest = join(base, "dest");

    // Crear árbol src/
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "file.txt"), "hello");
    writeFileSync(join(src, "sub", "nested.txt"), "world");

    copyTree(src, dest);

    assert.equal(readFileSync(join(dest, "file.txt"), "utf8"), "hello");
    assert.equal(readFileSync(join(dest, "sub", "nested.txt"), "utf8"), "world");

    // Limpieza
    rmSync(base, { recursive: true, force: true });
  });
}
