// cross-repo-usesite.test.ts — FU#2: use-site anchoring for cross-repo edges.
// The cross-repo edge must be anchored at the function/method that USES the imported
// symbol (function-to-function), with a fall back to the file node when no use-site
// function can be resolved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { linkCrossRepo } from "../src/application/workspace/cross-repo-linker.ts";
import type { WorkspaceMember } from "../src/application/project/detect-key.ts";
import type { GraphNode } from "../src/domain/graph/model.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cross-repo-usesite-"));
}

function node(partial: Partial<GraphNode> & Pick<GraphNode, "id" | "label" | "sourceFile">): GraphNode {
  return { fileType: "code", ...partial };
}

// ---------------------------------------------------------------------------
// FU#2: cross-repo edge anchored at the use-site function (function-to-function)
// ---------------------------------------------------------------------------

test("(usesite) cross-repo edge anchors at the function that uses the imported symbol", () => {
  const dir = tmpDir();
  try {
    const webDir = join(dir, "web");
    const payDir = join(dir, "payments");
    mkdirSync(join(webDir, "src"), { recursive: true });
    mkdirSync(payDir, { recursive: true });

    writeFileSync(join(webDir, "package.json"), JSON.stringify({ name: "@acme/web" }), "utf8");
    writeFileSync(join(payDir, "package.json"), JSON.stringify({ name: "@acme/payments" }), "utf8");

    // handler.ts: import at top-level, used INSIDE handleRequest.
    writeFileSync(
      join(webDir, "src", "handler.ts"),
      [
        `import { chargeCard } from "@acme/payments";`,
        ``,
        `export function handleRequest(req) {`,
        `  return chargeCard(req.amount);`,
        `}`,
        ``,
      ].join("\n"),
      "utf8",
    );

    const members: WorkspaceMember[] = [
      { dir: webDir, repoKey: "web" },
      { dir: payDir, repoKey: "payments" },
    ];

    const store = new GraphStore(join(dir, "merged.db"));
    try {
      store.addNodes([
        node({ id: "web::src_handler_ts", label: "src/handler.ts", sourceFile: "src/handler.ts", kind: "module", repo: "web" }),
        node({ id: "web::handleRequest", label: "handleRequest", sourceFile: "src/handler.ts", kind: "function", repo: "web" }),
        node({ id: "payments::chargeCard", label: "chargeCard", sourceFile: "src/index.ts", kind: "function", repo: "payments" }),
      ]);

      const crossEdges = linkCrossRepo(store, members);
      assert.equal(crossEdges.length, 1, `expected exactly 1 cross-repo edge; got ${crossEdges.length}`);
      const e = crossEdges[0]!;
      assert.equal(e.source, "web::handleRequest", "edge must be anchored at the use-site function, not the file node");
      assert.equal(e.target, "payments::chargeCard", "edge must target the imported symbol node");
      assert.equal(e.relation, "imports_from");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FU#2: fall back to the file node when the import is used only at module top-level
// ---------------------------------------------------------------------------

test("(usesite-fallback) top-level-only use falls back to the file node", () => {
  const dir = tmpDir();
  try {
    const webDir = join(dir, "web");
    const payDir = join(dir, "payments");
    mkdirSync(join(webDir, "src"), { recursive: true });
    mkdirSync(payDir, { recursive: true });

    writeFileSync(join(webDir, "package.json"), JSON.stringify({ name: "@acme/web" }), "utf8");
    writeFileSync(join(payDir, "package.json"), JSON.stringify({ name: "@acme/payments" }), "utf8");

    // top.ts: import used only at module top-level (no enclosing function).
    writeFileSync(
      join(webDir, "src", "top.ts"),
      [
        `import { chargeCard } from "@acme/payments";`,
        ``,
        `export const handler = chargeCard;`,
        ``,
      ].join("\n"),
      "utf8",
    );

    const members: WorkspaceMember[] = [
      { dir: webDir, repoKey: "web" },
      { dir: payDir, repoKey: "payments" },
    ];

    const store = new GraphStore(join(dir, "merged.db"));
    try {
      store.addNodes([
        node({ id: "web::src_top_ts", label: "src/top.ts", sourceFile: "src/top.ts", kind: "module", repo: "web" }),
        node({ id: "payments::chargeCard", label: "chargeCard", sourceFile: "src/index.ts", kind: "function", repo: "payments" }),
      ]);

      const crossEdges = linkCrossRepo(store, members);
      assert.equal(crossEdges.length, 1, `expected exactly 1 cross-repo edge; got ${crossEdges.length}`);
      assert.equal(crossEdges[0]!.source, "web::src_top_ts", "no use-site function → must fall back to the file node");
      assert.equal(crossEdges[0]!.target, "payments::chargeCard");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FU#2: Python use-site anchoring (multi-language coverage)
// ---------------------------------------------------------------------------

test("(usesite-py) Python: edge anchors at the def that uses the imported symbol", () => {
  const dir = tmpDir();
  try {
    const webDir = join(dir, "web");
    const payDir = join(dir, "payments");
    mkdirSync(webDir, { recursive: true });
    mkdirSync(payDir, { recursive: true });

    // Use package.json on both so the package index resolves names deterministically.
    writeFileSync(join(webDir, "package.json"), JSON.stringify({ name: "web" }), "utf8");
    writeFileSync(join(payDir, "package.json"), JSON.stringify({ name: "payments" }), "utf8");

    writeFileSync(
      join(webDir, "app.py"),
      [
        `from payments import charge_card`,
        ``,
        `def handle_request(req):`,
        `    return charge_card(req)`,
        ``,
      ].join("\n"),
      "utf8",
    );

    const members: WorkspaceMember[] = [
      { dir: webDir, repoKey: "web" },
      { dir: payDir, repoKey: "payments" },
    ];

    const store = new GraphStore(join(dir, "merged.db"));
    try {
      store.addNodes([
        node({ id: "web::app_py", label: "app.py", sourceFile: "app.py", kind: "module", repo: "web" }),
        node({ id: "web::handle_request", label: "handle_request", sourceFile: "app.py", kind: "function", repo: "web" }),
        node({ id: "payments::charge_card", label: "charge_card", sourceFile: "svc.py", kind: "function", repo: "payments" }),
      ]);

      const crossEdges = linkCrossRepo(store, members);
      const anchored = crossEdges.find((e) => e.source === "web::handle_request");
      assert.ok(anchored, "expected a cross-repo edge anchored at handle_request");
      assert.equal(anchored.target, "payments::charge_card");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
