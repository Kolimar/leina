// mcp-cli.test.ts — `leina mcp` (MCP server over stdio) and the .mcp.json registration.
//
// The E2E drives the real server process with raw JSON-RPC frames (newline-delimited,
// per MCP stdio transport): initialize → tools/list → tools/call. This proves the wire
// contract without depending on an MCP client library in tests.
// Run: node --no-warnings --experimental-strip-types --test test/mcp-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addMcpRegistration, removeMcpRegistration } from "../src/application/install/mcp-config.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

// ---------------------------------------------------------------------------
// (mcpc-*) Pure .mcp.json writer
// ---------------------------------------------------------------------------

test("(mcpc-1) addMcpRegistration creates, preserves other servers, is idempotent, never clobbers", () => {
  const fresh = addMcpRegistration(null);
  assert.ok(fresh !== null);
  const cfg = JSON.parse(fresh) as { mcpServers: Record<string, { command: string; args: string[] }> };
  assert.deepEqual(cfg.mcpServers.leina, { command: "leina", args: ["mcp"] });

  // Idempotent
  assert.equal(addMcpRegistration(fresh), null);

  // Preserves other servers + unknown keys
  const mixed = JSON.stringify({ mcpServers: { other: { command: "x" } }, custom: 1 });
  const merged = addMcpRegistration(mixed)!;
  const m = JSON.parse(merged);
  assert.ok(m.mcpServers.other, "other server preserved");
  assert.equal(m.custom, 1, "unknown key preserved");
  assert.ok(m.mcpServers.leina, "leina entry added");

  // Malformed JSON → no-clobber
  assert.equal(addMcpRegistration("{ not json"), null);
});

test("(mcpc-2) removeMcpRegistration strips only our entry; drops empty mcpServers", () => {
  const both = JSON.stringify({ mcpServers: { leina: { command: "leina", args: ["mcp"] }, other: { command: "x" } } });
  const stripped = JSON.parse(removeMcpRegistration(both)!);
  assert.ok(!("leina" in stripped.mcpServers));
  assert.ok(stripped.mcpServers.other);

  const onlyOurs = addMcpRegistration(null)!;
  const emptied = JSON.parse(removeMcpRegistration(onlyOurs)!);
  assert.ok(!("mcpServers" in emptied), "empty mcpServers key dropped");

  assert.equal(removeMcpRegistration(JSON.stringify({ a: 1 })), null, "nothing to remove → null");
  assert.equal(removeMcpRegistration(null), null);
});

// ---------------------------------------------------------------------------
// (mcpi-*) init --mcp / deinit wiring
// ---------------------------------------------------------------------------

function sandboxEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, LEINA_HOME: join(home, ".leina"), HOME: home, USERPROFILE: home };
}

test("(mcpi-1) init --mcp registers; plain init does not; deinit unregisters preserving others", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-init-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-proj-"));
  const env = sandboxEnv(home);
  try {
    const run = (...args: string[]) => {
      // Host-selecting commands now require an explicit --hosts; default to "devin".
      if (["setup", "activate", "init", "install-global"].includes(args[0]!) && !args.includes("--hosts")) {
        args = [...args, "--hosts", "devin"];
      }
      if (args[0] === "init" && !args.includes("--profile") && !args.includes("--agent")) {
        args = [...args, "--profile", "devin"];
      }
      return spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
        encoding: "utf8", env,
      });
    };

    // Plain init: no .mcp.json.
    assert.equal(run("init", "--project", dir).status, 0);
    assert.ok(!existsSync(join(dir, ".mcp.json")), "no .mcp.json without --mcp");

    // Pre-existing third-party server must survive the whole cycle.
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));

    const r = run("init", "--project", dir, "--mcp");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\.mcp\.json \(leina MCP server registered\)/);
    const cfg = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(cfg.mcpServers.leina, { command: "leina", args: ["mcp"] });
    assert.ok(cfg.mcpServers.other, "third-party server preserved");

    const d = run("deinit", "--project", dir);
    assert.equal(d.status, 0);
    const after = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.ok(!("leina" in (after.mcpServers ?? {})), "leina entry removed by deinit");
    assert.ok(after.mcpServers.other, "third-party server still there");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (mcps-*) stdio server E2E — raw JSON-RPC frames
// ---------------------------------------------------------------------------

interface RpcResponse {
  id?: number;
  result?: {
    tools?: { name: string; inputSchema?: { type?: string } }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
    serverInfo?: { name: string; version: string };
  };
}

async function driveMcp(cwd: string, env: NodeJS.ProcessEnv, requests: object[]): Promise<RpcResponse[]> {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "mcp"],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const responses: RpcResponse[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  const expected = requests.filter((r) => "id" in r).length;

  const done = new Promise<void>((resolveDone, rejectDone) => {
    const timer = setTimeout(() => rejectDone(new Error(`timeout; got ${responses.length}/${expected}: ${buffer}`)), 30_000);
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        const msg = JSON.parse(line) as RpcResponse;
        if (msg.id !== undefined) responses.push(msg);
        if (responses.length >= expected) {
          clearTimeout(timer);
          resolveDone();
        }
      }
    });
    child.on("error", rejectDone);
  });

  for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  await done;
  // Kill AND wait for the exit: on Windows the caller's rmSync(dir) fails with EPERM
  // while the dying server still holds its cwd / memory.db handles.
  const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
  child.kill();
  await exited;
  return responses;
}

test("(mcps-1) initialize → tools/list → tools/call over stdio against a real project", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo-"));
  const env = sandboxEnv(home);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "export function greet(): string { return callee(); }\nexport function callee(): string { return \"hi\"; }\n");

    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graph_affected", arguments: { root: dir, symbol: "callee" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_add", arguments: { root: dir, title: "t", content: "c" } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_search", arguments: { root: dir, query: "t" } } },
    ]);

    const byId = new Map(responses.map((r) => [r.id, r]));

    assert.equal(byId.get(1)?.result?.serverInfo?.name, "leina", "server identifies as leina");

    const tools = byId.get(2)?.result?.tools ?? [];
    const names = tools.map((t) => t.name).sort();
    for (const expectedTool of ["graph_query", "graph_affected", "graph_build", "impact_analyze", "memory_add", "memory_search", "memory_verified", "memory_update", "memory_suggest_topic", "memory_session", "context_build", "doctor_run", "graph_visualize"]) {
      assert.ok(names.includes(expectedTool), `tools/list includes ${expectedTool} (got: ${names.join(",")})`);
    }
    assert.equal(tools.length, 19, "17 registry tools + doctor_run + graph_visualize");

    // graph_affected auto-built the graph via the freshness gate, then answered.
    const affectedText = byId.get(3)?.result?.content?.[0]?.text ?? "";
    const affectedJson = JSON.parse(affectedText) as { seed: { label: string }; dependents: unknown[] };
    assert.equal(affectedJson.seed.label, "callee()");
    assert.ok(affectedJson.dependents.length >= 1, "greet depends on callee");

    // memory round-trip through MCP.
    assert.ok(!byId.get(4)?.result?.isError, "memory_add succeeded");
    const hitsText = byId.get(5)?.result?.content?.[0]?.text ?? "";
    assert.match(hitsText, /"title": "t"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-3) parity tools: batch add/get, update, suggest_topic, session round-trip", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home3-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo3-"));
  const env = sandboxEnv(home);
  try {
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_add", arguments: { root: dir, items: [{ title: "b1", content: "c1" }, { title: "b2", content: "c2" }], atomic: true } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_suggest_topic", arguments: { root: dir, title: "batch observation one" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_session", arguments: { root: dir, content: "session summary", title: "s1" } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));

    // Batch save: 2 results, both ok, with observation ids we can round-trip.
    assert.ok(!byId.get(2)?.result?.isError, `batch add failed: ${byId.get(2)?.result?.content?.[0]?.text}`);
    const batch = JSON.parse(byId.get(2)?.result?.content?.[0]?.text ?? "[]") as { ok: boolean; data?: { observation: { id: string } } }[];
    assert.equal(batch.length, 2, "two batch results");
    const ids = batch.map((b) => b.data?.observation.id).filter((x): x is string => typeof x === "string");
    assert.equal(ids.length, 2, "both saves returned observation ids");

    // suggest_topic returns a suggestion string.
    const suggestion = JSON.parse(byId.get(3)?.result?.content?.[0]?.text ?? "{}") as { suggestion?: string };
    assert.ok(typeof suggestion.suggestion === "string" && suggestion.suggestion.length > 0, "topic suggestion present");

    // session save succeeded.
    assert.ok(!byId.get(4)?.result?.isError, "memory_session succeeded");

    // Second round: batch get + update by id (needs ids from the first round).
    const responses2 = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_get", arguments: { root: dir, ids } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_update", arguments: { root: dir, id: ids[0], content: "c1-updated" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_get", arguments: { root: dir, id: ids[0] } } },
    ]);
    const byId2 = new Map(responses2.map((r) => [r.id, r]));

    const got = JSON.parse(byId2.get(2)?.result?.content?.[0]?.text ?? "[]") as { ok: boolean }[];
    assert.equal(got.length, 2, "batch get returns both");
    assert.ok(got.every((g) => g.ok), "both batch gets ok");

    assert.ok(!byId2.get(3)?.result?.isError, `update failed: ${byId2.get(3)?.result?.content?.[0]?.text}`);
    assert.match(byId2.get(4)?.result?.content?.[0]?.text ?? "", /c1-updated/, "update visible on re-read");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-4) consent=disabled blocks tools with isError; doctor_run stays exempt", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home4-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo4-"));
  const env = sandboxEnv(home);
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(join(dir, ".leina", "consent"), "disabled");

    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search", arguments: { root: dir, query: "x" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "doctor_run", arguments: { root: dir } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));

    assert.equal(byId.get(2)?.result?.isError, true, "disabled repo → tool blocked");
    assert.match(byId.get(2)?.result?.content?.[0]?.text ?? "", /disabled/, "actionable consent message");
    assert.ok(!byId.get(3)?.result?.isError, "doctor_run exempt from the consent gate");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-5) graph_visualize returns the path of a generated HTML file", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home5-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo5-"));
  const env = sandboxEnv(home);
  try {
    writeFileSync(join(dir, "a.ts"), "export function one(): number { return 1; }\n");

    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      // Build first (visualize itself does not buildIfMissing — it requires a graph).
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_build", arguments: { root: dir } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graph_visualize", arguments: { root: dir } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));

    assert.ok(!byId.get(3)?.result?.isError, `visualize failed: ${byId.get(3)?.result?.content?.[0]?.text}`);
    const viz = JSON.parse(byId.get(3)?.result?.content?.[0]?.text ?? "{}") as { outPath?: string; mode?: string };
    assert.equal(viz.mode, "single");
    assert.ok(viz.outPath && existsSync(viz.outPath), "HTML file exists at returned path");
    const html = readFileSync(viz.outPath, "utf8");
    assert.ok(html.length > 1000 && html.includes("<html"), "self-contained HTML artifact");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-2) unknown tool and missing args surface as isError, not crashes", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home2-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo2-"));
  const env = sandboxEnv(home);
  try {
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope_tool", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_add", arguments: { root: dir } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));
    assert.equal(byId.get(2)?.result?.isError, true, "unknown tool → isError");
    assert.equal(byId.get(3)?.result?.isError, true, "missing args → isError");
    assert.match(byId.get(3)?.result?.content?.[0]?.text ?? "", /missing required string argument "title"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
