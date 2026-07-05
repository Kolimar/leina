// handlers-workspace-audit.test.ts — smoke tests for workspace/audit handler logic
// Tests the handler modules without spawning a full CLI process (unit/integration level).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/infrastructure/sqlite/graph-store.ts";
import { handleAuditCatalog, handleAuditReachability, handleAuditPack } from "../src/cli/handlers/audit.ts";
import { handleWorkspaceStatus, handleWorkspaceDetect } from "../src/cli/handlers/workspace.ts";
import type { GraphNode, GraphEdge } from "../src/domain/graph/model.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "handler-ws-audit-"));
}

function node(id: string, repo?: string): GraphNode {
  return { id, label: id, fileType: "code", kind: "function", sourceFile: "src/x.ts", ...(repo ? { repo } : {}) };
}

function edge(source: string, target: string, repo?: string): GraphEdge {
  return { source, target, relation: "calls", confidence: "EXTRACTED", sourceFile: "src/x.ts", weight: 1, ...(repo ? { repo } : {}) };
}

function seedGraph(dbPath: string): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const store = new GraphStore(dbPath);
  store.addNodes([node("svc-a::fn1", "svc-a"), node("svc-a::fn2", "svc-a"), node("svc-b::fn1", "svc-b")]);
  store.addEdges([edge("svc-a::fn1", "svc-b::fn1", "svc-a")]);
  store.close();
}

// ---------------------------------------------------------------------------
// audit catalog handler (unit test — captures stdout)
// ---------------------------------------------------------------------------

test("(handler-audit-catalog) catalog outputs repo breakdown", () => {
  const dir = tmpDir();
  const dbDir = join(dir, ".leina");
  mkdirSync(dbDir, { recursive: true });
  seedGraph(join(dbDir, "graph.db"));

  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    handleAuditCatalog([dir]);
    const output = lines.join("\n");
    assert.ok(output.includes("svc-a") || output.includes("catalog"), `expected catalog output; got: ${output}`);
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// audit reachability handler — fails when no --from given
// ---------------------------------------------------------------------------

test("(handler-audit-reachability) no --from → exits with error", () => {
  const dir = tmpDir();
  const dbDir = join(dir, ".leina");
  mkdirSync(dbDir, { recursive: true });
  seedGraph(join(dbDir, "graph.db"));

  // handleAuditReachability calls fail() which calls process.exit — expect it to throw
  let threw = false;
  const origExit = process.exit.bind(process);
  (process as unknown as Record<string, unknown>).exit = (code?: number) => { threw = true; throw new Error(`exit:${code}`); };
  try {
    handleAuditReachability([dir]);
  } catch { /* expected */ }
  finally {
    process.exit = origExit;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(threw, "should have called process.exit when no --from provided");
});

// ---------------------------------------------------------------------------
// audit pack handler
// ---------------------------------------------------------------------------

test("(handler-audit-pack) pack outputs node/edge counts", async () => {
  const dir = tmpDir();
  const dbDir = join(dir, ".leina");
  mkdirSync(dbDir, { recursive: true });
  seedGraph(join(dbDir, "graph.db"));

  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await handleAuditPack([dir]);
    const output = lines.join("\n");
    assert.ok(output.includes("nodes") || output.includes("pack"), `expected pack output; got: ${output}`);
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// workspace status — single mode when no child repos
// ---------------------------------------------------------------------------

test("(handler-ws-status) empty dir → single mode reported", () => {
  const dir = tmpDir();
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    handleWorkspaceStatus([dir]);
    const output = lines.join("\n");
    assert.ok(output.includes("single"), `expected single mode; got: ${output}`);
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// workspace detect — outputs JSON
// ---------------------------------------------------------------------------

test("(handler-ws-detect) detect outputs valid JSON", () => {
  const dir = tmpDir();
  let output = "";
  const origLog = console.log;
  console.log = (arg: unknown) => { output += String(arg); };
  try {
    handleWorkspaceDetect([dir]);
    const parsed = JSON.parse(output) as { mode: string };
    assert.ok(parsed.mode === "single" || parsed.mode === "workspace");
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
