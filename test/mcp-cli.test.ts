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
import { trustWorkspace } from "../src/application/install/trust.ts";
import { isolateLeinaHome, jsonFrontmatterDoc } from "./helpers/harness-tmprepo.ts";

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
    // A server that dies mid-session (process.exit in a tool path) fails fast instead
    // of timing out. Once every response is in, this is a no-op (already resolved).
    child.once("exit", (code) =>
      rejectDone(new Error(`server exited (code ${code}) after ${responses.length}/${expected} responses`)),
    );
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
    for (const expectedTool of ["graph_query", "graph_affected", "graph_build", "impact_analyze", "memory_add", "memory_search", "memory_verified", "memory_update", "memory_suggest_topic", "memory_session", "context_build", "doctor_run", "graph_visualize", "harness_contract_new", "harness_contract_show", "harness_contract_end", "harness_verify", "harness_rules_list"]) {
      assert.ok(names.includes(expectedTool), `tools/list includes ${expectedTool} (got: ${names.join(",")})`);
    }
    assert.equal(tools.length, 24, "22 registry tools + doctor_run + graph_visualize");

    // graph_affected auto-built the graph via the freshness gate, then answered.
    const affectedText = byId.get(3)?.result?.content?.[0]?.text ?? "";
    const affectedJson = JSON.parse(affectedText) as { seed: { label: string }; dependents: unknown[] };
    assert.equal(affectedJson.seed.label, "callee()");
    assert.ok(affectedJson.dependents.length >= 1, "greet depends on callee");

    // memory round-trip through MCP.
    assert.ok(!byId.get(4)?.result?.isError, "memory_add succeeded");
    const hitsText = byId.get(5)?.result?.content?.[0]?.text ?? "";
    assert.match(hitsText, /"title":"t"/);
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
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "harness_contract_show", arguments: { root: dir } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));

    assert.equal(byId.get(2)?.result?.isError, true, "disabled repo → tool blocked");
    assert.match(byId.get(2)?.result?.content?.[0]?.text ?? "", /disabled/, "actionable consent message");
    assert.ok(!byId.get(3)?.result?.isError, "doctor_run exempt from the consent gate");
    assert.equal(byId.get(4)?.result?.isError, true, "harness tools are NOT consent-exempt");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-16) graph and memory tools from a subdirectory act on the repo's project", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home16-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo16-"));
  const env = sandboxEnv(home);
  try {
    assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export function greet(): string { return callee(); }\nexport function callee(): string { return \"hi\"; }\n");
    const sub = join(dir, "src");

    const responses = await driveMcp(sub, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_affected", arguments: { symbol: "callee" } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));
    assert.ok(!byId.get(2)?.result?.isError, byId.get(2)?.result?.content?.[0]?.text);
    assert.ok(existsSync(join(dir, ".leina", "graph.db")), "graph built at the repo root");
    assert.ok(!existsSync(join(sub, ".leina")), "no second project in the subdirectory");

    // The repo's consent flag governs a server launched below it.
    writeFileSync(join(dir, ".leina", "consent"), "disabled");
    const blocked = await driveMcp(sub, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search", arguments: { query: "x" } } },
    ]);
    assert.equal(blocked.find((r) => r.id === 2)?.result?.isError, true, "disabled at the repo root → blocked in its subdirectory");
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

    // Build and visualize are a DEPENDENT sequence, but the server processes tool calls
    // concurrently — batching them into one driveMcp would race (visualize's existsSync
    // fires while the build's replaceGraph is still in flight). Drive them as two separate
    // sessions: the graph.db persisted by the first is on disk before the second opens it.
    await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_build", arguments: { root: dir } } },
    ]);
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
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

test("(mcps-8) graph_visualize: out resolves against root, is confined and must be .html", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home8-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo8-"));
  const env = sandboxEnv(home);
  const escapeName = `leina-evil-${process.pid}-${Date.now()}.html`;
  try {
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "pkg", "a.ts"), "export function one(): number { return 1; }\n");
    // Build first (separate session — see mcps-5 on intra-session ordering).
    await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_build", arguments: { root: "pkg" } } },
    ]);
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_visualize", arguments: { root: "pkg", out: join("viz", "g.html") } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graph_visualize", arguments: { root: "pkg", out: join("..", "..", escapeName) } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "graph_visualize", arguments: { root: "pkg", out: "notes.txt" } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));

    assert.ok(!byId.get(2)?.result?.isError, `visualize failed: ${byId.get(2)?.result?.content?.[0]?.text}`);
    assert.ok(existsSync(join(dir, "pkg", "viz", "g.html")), "relative out lands under root, not the server cwd");
    assert.ok(!existsSync(join(dir, "viz", "g.html")), "nothing written relative to the server cwd");

    assert.equal(byId.get(3)?.result?.isError, true, "escaping out rejected");
    assert.match(byId.get(3)?.result?.content?.[0]?.text ?? "", /outside the server workspace/);
    assert.ok(!existsSync(join(dir, "..", escapeName)), "escaping file never written");

    assert.equal(byId.get(4)?.result?.isError, true, "non-.html out rejected");
    assert.ok(!existsSync(join(dir, "pkg", "notes.txt")), "non-.html file never written");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(tmpdir(), escapeName), { force: true });
  }
});

test("(mcps-9) a refused stale graph is a tool error, never a server exit", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home9-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo9-"));
  const env = sandboxEnv(home);
  try {
    writeFileSync(join(dir, "a.ts"), "export function one(): number { return 1; }\n");
    await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_build", arguments: { root: dir } } },
    ]);
    // Stale (new source) under the "refuse" posture: every gated read must refuse in-band.
    writeFileSync(join(dir, "b.ts"), "export function two(): number { return 2; }\n");
    writeFileSync(join(dir, ".leina", "config.json"), JSON.stringify({ freshness: "refuse" }));

    const responses = await driveMcp(dir, { ...env, LEINA_FRESHNESS: "" }, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_query", arguments: { root: dir, question: "one" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graph_visualize", arguments: { root: dir } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "graph_stats", arguments: { root: dir } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));

    for (const id of [2, 3]) {
      assert.equal(byId.get(id)?.result?.isError, true, `call ${id} refused in-band`);
      assert.match(byId.get(id)?.result?.content?.[0]?.text ?? "", /freshness posture is "refuse"/);
    }
    assert.ok(!byId.get(4)?.result?.isError, "server still alive and answering after the refusals");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-10) impact_analyze resolves the symbol like the CLI and honours depth", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home10-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo10-"));
  const env = sandboxEnv(home);
  try {
    // Call chain across files: a() → b() → c().
    writeFileSync(join(dir, "c.ts"), "export function c(): number { return 1; }\n");
    writeFileSync(join(dir, "b.ts"), "import { c } from \"./c\";\nexport function b(): number { return c(); }\n");
    writeFileSync(join(dir, "a.ts"), "import { b } from \"./b\";\nexport function a(): number { return b(); }\n");
    await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_build", arguments: { root: dir } } },
    ]);
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "impact_analyze", arguments: { root: dir, symbol: "c" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "impact_analyze", arguments: { root: dir, symbol: "c", depth: 1 } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "impact_analyze", arguments: { root: dir, symbol: "no_such_symbol" } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));
    interface Impact { seed: { label: string } | null; impacted: { files: string[] }; note?: string }
    const parse = (id: number): Impact => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? "{}") as Impact;

    const full = parse(2);
    assert.equal(full.seed?.label, "c()", "symbol name resolved to its node");
    assert.deepEqual([...full.impacted.files].sort(), ["a.ts", "b.ts", "c.ts"], "default depth reaches the whole chain");

    const shallow = parse(3);
    assert.deepEqual([...shallow.impacted.files].sort(), ["b.ts", "c.ts"], "depth 1 stops at the direct caller");

    const missing = parse(4);
    assert.equal(missing.seed, null);
    assert.deepEqual(missing.impacted.files, []);
    assert.match(missing.note ?? "", /no exact match for "no_such_symbol"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-g1) graph reads answer compact, unindented JSON with file:line on every node and edge", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-homeg1-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repog1-"));
  const env = sandboxEnv(home);
  try {
    // Call chain across files: a() → b() → c(), each call on line 2.
    writeFileSync(join(dir, "c.ts"), "export function c(): number { return 1; }\n");
    writeFileSync(join(dir, "b.ts"), "import { c } from \"./c\";\nexport function b(): number { return c(); }\n");
    writeFileSync(join(dir, "a.ts"), "import { b } from \"./b\";\nexport function a(): number { return b(); }\n");
    const init = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ];
    await driveMcp(dir, env, [...init, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_build", arguments: { root: dir } } }]);
    const call = (id: number, name: string, args: object): object =>
      ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { root: dir, ...args } } });
    const responses = await driveMcp(dir, env, [
      ...init,
      call(2, "graph_query", { question: "b" }),
      call(3, "graph_affected", { symbol: "c" }),
      call(4, "graph_path", { from: "a", to: "c" }),
      call(5, "graph_path", { from: "a", to: "no_such_symbol" }),
      call(6, "impact_analyze", { symbol: "c" }),
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));
    const text = (id: number): string => byId.get(id)?.result?.content?.[0]?.text ?? "";
    for (const id of [2, 3, 4, 5, 6]) {
      assert.ok(!byId.get(id)?.result?.isError, `call ${id}: ${text(id)}`);
      assert.ok(!text(id).includes("\n"), `call ${id} is unindented`);
      assert.doesNotMatch(text(id), /"(signature|fileType|community|weight|sourceFile|sourceLocation)"/, `call ${id} drops redundant fields`);
    }
    const NODE_KEYS = ["at", "id", "kind", "label"];
    interface N { id: string; label: string; kind: string; at: string }
    interface E { source: string; target: string; relation: string; at: string }

    const q = JSON.parse(text(2)) as { seeds: string[]; nodes: N[]; edges: E[]; testsExcluded: boolean };
    assert.equal(q.nodes.find((n) => n.id === q.seeds[0])?.label, "b()");
    for (const n of q.nodes) assert.deepEqual(Object.keys(n).sort(), NODE_KEYS);
    assert.ok(q.edges.some((e) => e.relation === "calls" && e.at === "b.ts:2"), `call site on the edge: ${text(2)}`);

    const aff = JSON.parse(text(3)) as { seed: N; dependents: (N & { depth: number; relation: string; target: string })[] };
    assert.deepEqual(Object.keys(aff.seed).sort(), NODE_KEYS);
    assert.equal(aff.seed.at, "c.ts:1");
    const b = aff.dependents.find((d) => d.label === "b()");
    assert.deepEqual([b?.at, b?.depth, b?.relation, b?.target], ["b.ts:2", 1, "calls", aff.seed.id], "call site + what it depends on");
    assert.equal(aff.dependents.find((d) => d.label === "a()")?.target, b?.id);

    const path = JSON.parse(text(4)) as { path: { nodes: N[]; edges: E[] }; endpoints?: unknown };
    assert.equal(path.path.nodes[0]?.label, "a()");
    assert.equal(path.path.nodes.at(-1)?.label, "c()");
    assert.equal(path.path.edges.length, path.path.nodes.length - 1);
    assert.equal(path.endpoints, undefined, "endpoints only when one is unresolved or ambiguous");

    const miss = JSON.parse(text(5)) as { path: null; endpoints: { to: { note?: string } } };
    assert.equal(miss.path, null);
    assert.match(miss.endpoints.to.note ?? "", /no exact match for "no_such_symbol"/);

    const impact = JSON.parse(text(6)) as { seed: N };
    assert.deepEqual(Object.keys(impact.seed).sort(), NODE_KEYS);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-11) memory_verified honours the type filter like memory_search", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home11-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo11-"));
  const env = sandboxEnv(home);
  try {
    await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_add", arguments: { root: dir, atomic: true, items: [
        { title: "widget pipeline decision", content: "widget choice", type: "decision" },
        { title: "widget crash bugfix", content: "widget fix", type: "bugfix" },
      ] } } },
    ]);
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_verified", arguments: { root: dir, query: "widget" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_verified", arguments: { root: dir, query: "widget", type: "bugfix" } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));
    interface Verified { usable: { type: string }[]; warning: { type: string }[]; doNotUse: { type: string }[] }
    const typesOf = (id: number): string[] => {
      const v = JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? "{}") as Verified;
      return [...v.usable, ...v.warning, ...v.doNotUse].map((i) => i.type).sort();
    };
    assert.deepEqual(typesOf(2), ["bugfix", "decision"], "unfiltered: both hits");
    assert.deepEqual(typesOf(3), ["bugfix"], "type filter applied");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-12) every tool schema matches its executor: root optional + confined, numeric args bounded", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home12-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo12-"));
  const env = sandboxEnv(home);
  try {
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    interface Prop { type?: string; description?: string; minimum?: number; maximum?: number }
    interface Tool { name: string; inputSchema: { type?: string; required?: string[]; properties?: Record<string, Prop> } }
    const tools = (responses.find((r) => r.id === 2)?.result?.tools ?? []) as unknown as Tool[];
    assert.equal(tools.length, 24);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object", `${t.name}: object schema`);
      assert.ok(!(t.inputSchema.required ?? []).includes("root"), `${t.name}: root is optional (defaults to the server cwd)`);
      const props = t.inputSchema.properties ?? {};
      assert.ok(props.root, `${t.name}: declares root`);
      assert.match(props.root.description ?? "", /LEINA_MCP_ALLOW_ROOTS/, `${t.name}: root describes the confinement`);
      // Port-injected registry fields (store objects) must never leak onto the wire.
      assert.ok(!("store" in props), `${t.name}: no port-injected store field`);
      if (t.name.startsWith("harness_")) continue; // validated by the harness use cases
      for (const [k, p] of Object.entries(props)) {
        if (p.type !== "number" && p.type !== "integer") continue;
        assert.equal(p.type, "integer", `${t.name}.${k}: integer`);
        assert.ok(typeof p.minimum === "number" && typeof p.maximum === "number", `${t.name}.${k}: bounded`);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-13) out-of-range numeric args are clamped, never a SQL datatype error or an unbounded read", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home13-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo13-"));
  const env = sandboxEnv(home);
  try {
    writeFileSync(join(dir, "a.ts"), "export function one(): number { return 1; }\n");
    await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_add", arguments: { root: dir, atomic: true, items: [
        { title: "gadget one", content: "gadget a" },
        { title: "gadget two", content: "gadget b" },
        { title: "gadget three", content: "gadget c" },
      ] } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graph_build", arguments: { root: dir } } },
    ]);
    const call = (id: number, name: string, args: object): object =>
      ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { root: dir, ...args } } });
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      call(2, "memory_context", { limit: 1e20, sessionLimit: 1e20 }),
      call(3, "memory_search", { query: "gadget", limit: -1 }),
      call(4, "memory_search", { query: "gadget", limit: 1.5 }),
      call(5, "memory_verified", { query: "gadget", limit: 1e20 }),
      call(6, "graph_query", { question: "one", depth: -5, maxNodes: 1e20 }),
      call(7, "graph_affected", { symbol: "one", depth: 1e20 }),
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));
    for (const id of [2, 3, 4, 5, 6, 7]) {
      assert.ok(!byId.get(id)?.result?.isError, `call ${id} failed: ${byId.get(id)?.result?.content?.[0]?.text}`);
    }
    const hits = (id: number): unknown[] => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? "[]") as unknown[];
    assert.equal(hits(3).length, 1, "limit:-1 clamps to 1 instead of an unbounded LIMIT -1");
    assert.equal(hits(4).length, 1, "limit:1.5 truncates to 1");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-14) graph_stats issued alongside a first graph_build waits for it (never nodes:0)", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home14-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo14-"));
  const env = sandboxEnv(home);
  try {
    writeFileSync(join(dir, "a.ts"), "export function greet(): string { return callee(); }\nexport function callee(): string { return \"hi\"; }\n");
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_build", arguments: { root: dir } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graph_stats", arguments: { root: dir } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "graph_build", arguments: { root: dir } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));
    const built = JSON.parse(byId.get(2)?.result?.content?.[0]?.text ?? "{}") as { nodes?: number; timings?: unknown };
    const stats = JSON.parse(byId.get(3)?.result?.content?.[0]?.text ?? "{}") as { nodes?: number };
    const again = JSON.parse(byId.get(4)?.result?.content?.[0]?.text ?? "{}") as { nodes?: number; timings?: unknown };
    assert.ok((built.nodes ?? 0) > 0, `build produced nodes: ${byId.get(2)?.result?.content?.[0]?.text}`);
    assert.equal(stats.nodes, built.nodes, "stats reads the committed graph, not the empty in-flight one");
    assert.deepEqual(again, built, "the concurrent second graph_build joined the first (same report)");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-6) harness tools: parseable schemas and contract new → show → verify → list → end over stdio", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home6-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo6-"));
  const env = sandboxEnv(home);
  try {
    writeFileSync(join(dir, "a.txt"), "anchor\n");
    mkdirSync(join(dir, ".harness", "rules"), { recursive: true });
    writeFileSync(
      join(dir, ".harness", "rules", "trivial.md"),
      jsonFrontmatterDoc(
        {
          id: "project/trivial",
          phase: "verify",
          severity: "blocking",
          gate: { type: "file", path: "a.txt", exists: true },
        },
        "# Trivial gate",
      ),
    );
    // harness_verify runs only in a workspace the user trusted (`leina init`).
    const restoreHome = isolateLeinaHome(env.LEINA_HOME!);
    try {
      trustWorkspace(dir);
    } finally {
      restoreHome();
    }

    // Round 1: list + create. Dependent calls go in later rounds — tool calls
    // within one session are async and carry no ordering guarantee (see mcps-3).
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "harness_contract_new", arguments: { root: dir, goal: "expose harness caps", scope: ["src/**"], criteria: [] } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));

    // tools/list: the five harness tools expose parseable object input schemas.
    const tools = byId.get(2)?.result?.tools ?? [];
    const harnessTools = tools.filter((t) => t.name.startsWith("harness_"));
    assert.deepEqual(
      harnessTools.map((t) => t.name).sort(),
      ["harness_contract_end", "harness_contract_new", "harness_contract_show", "harness_rules_list", "harness_verify"],
    );
    for (const t of harnessTools) assert.equal(t.inputSchema?.type, "object", `${t.name} schema is an object`);

    const created = JSON.parse(byId.get(3)?.result?.content?.[0]?.text ?? "{}");
    assert.equal(created.ok, true, `contract_new failed: ${byId.get(3)?.result?.content?.[0]?.text}`);
    assert.equal(created.contract.goal, "expose harness caps");

    // Round 2: read-side tools against the created contract (mutually independent).
    const responses2 = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "harness_contract_show", arguments: { root: dir } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "harness_verify", arguments: { root: dir, ruleId: "project/trivial" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "harness_rules_list", arguments: { root: dir } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "harness_verify", arguments: { root: dir, ruleId: "does/not-exist" } } },
    ]);
    const byId2 = new Map(responses2.map((r) => [r.id, r]));

    const shown = JSON.parse(byId2.get(2)?.result?.content?.[0]?.text ?? "{}");
    assert.equal(shown.active, true, `show: ${byId2.get(2)?.result?.content?.[0]?.text}`);
    assert.deepEqual(shown.contract.scope, ["src/**"]);

    const verify = JSON.parse(byId2.get(3)?.result?.content?.[0]?.text ?? "{}");
    assert.equal(verify.exitCode, 0, `verify red: ${byId2.get(3)?.result?.content?.[0]?.text}`);
    assert.equal(verify.report.summary.blockingFailures, 0);
    assert.deepEqual(verify.report.results.map((r: { ruleId: string }) => r.ruleId), ["project/trivial"]);

    const listed = JSON.parse(byId2.get(4)?.result?.content?.[0]?.text ?? "{}");
    const trivial = listed.rules.find((r: { id: string }) => r.id === "project/trivial");
    assert.ok(trivial, "project rule resolved through MCP");
    assert.equal(trivial.layer, "project");
    assert.deepEqual(trivial.gates, ["file"]);

    // (verify-partial-mcp) an unknown ruleId is a tool error, not an empty green run.
    assert.equal(byId2.get(5)?.result?.isError, true, `unknown rule: ${byId2.get(5)?.result?.content?.[0]?.text}`);
    assert.match(byId2.get(5)?.result?.content?.[0]?.text ?? "", /unknown rule "does\/not-exist"/);

    // Round 3: close the contract.
    const responses3 = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "harness_contract_end", arguments: { root: dir } } },
    ]);
    const byId3 = new Map(responses3.map((r) => [r.id, r]));
    const ended = JSON.parse(byId3.get(2)?.result?.content?.[0]?.text ?? "{}");
    assert.equal(ended.ok, true, `end: ${byId3.get(2)?.result?.content?.[0]?.text}`);
    assert.match(String(ended.archivedTo), /history/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-6b) harness_verify in an untrusted workspace is a no-op result, never an error", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home6b-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo6b-"));
  const env = sandboxEnv(home);
  try {
    // A hostile clone can commit its own consent flag — it is not trust.
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(join(dir, ".leina", "consent"), "enabled");
    mkdirSync(join(dir, ".harness", "rules"), { recursive: true });
    writeFileSync(
      join(dir, ".harness", "rules", "trivial.md"),
      jsonFrontmatterDoc(
        { id: "project/trivial", phase: "verify", severity: "blocking", gate: { type: "file", path: "a.txt", exists: true } },
        "# Trivial gate",
      ),
    );

    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "harness_verify", arguments: { root: dir } } },
    ]);
    const res = new Map(responses.map((r) => [r.id, r])).get(2);
    assert.ok(!res?.result?.isError, `must not error: ${res?.result?.content?.[0]?.text}`);
    const body = JSON.parse(res?.result?.content?.[0]?.text ?? "{}");
    assert.equal(body.skipped, true);
    assert.match(String(body.reason), /leina init/);
    assert.equal(body.report, undefined, "no gate ran");
    assert.equal(existsSync(join(dir, ".harness", "state", "current", "verify-report.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(mcps-6c) harness tools resolve the harness root and its trust from a subdirectory or a nested worktree", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home6c-"));
  const repo = mkdtempSync(join(tmpdir(), "leina-mcp-repo6c-"));
  const env = sandboxEnv(home);
  const trivialRule = (dir: string): void => {
    writeFileSync(join(dir, "a.txt"), "anchor\n");
    mkdirSync(join(dir, ".harness", "rules"), { recursive: true });
    writeFileSync(
      join(dir, ".harness", "rules", "trivial.md"),
      jsonFrontmatterDoc(
        { id: "project/trivial", phase: "verify", severity: "blocking", gate: { type: "file", path: "a.txt", exists: true } },
        "# Trivial gate",
      ),
    );
  };
  const verifyFrom = async (cwd: string): Promise<{ skipped?: boolean; exitCode?: number; report?: unknown }> => {
    const responses = await driveMcp(cwd, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "harness_verify", arguments: { root: cwd, ruleId: "project/trivial" } } },
    ]);
    const res = new Map(responses.map((r) => [r.id, r])).get(2);
    assert.ok(!res?.result?.isError, `must not error: ${res?.result?.content?.[0]?.text}`);
    return JSON.parse(res?.result?.content?.[0]?.text ?? "{}");
  };
  try {
    // A trusted repo (consent + the out-of-repo trust record) with its own harness rules.
    mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(join(repo, ".leina"), { recursive: true });
    writeFileSync(join(repo, ".leina", "consent"), "enabled");
    trivialRule(repo);
    // A linked worktree nested under .claude/worktrees/, carrying its own rules.
    const wt = join(repo, ".claude", "worktrees", "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
    writeFileSync(join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
    trivialRule(wt);
    const sub = join(repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const restoreHome = isolateLeinaHome(env.LEINA_HOME!);
    try {
      trustWorkspace(repo);
    } finally {
      restoreHome();
    }

    for (const cwd of [sub, wt]) {
      const body = await verifyFrom(cwd);
      assert.notEqual(body.skipped, true, `${cwd}: trusted through its project, must run`);
      assert.equal(body.exitCode, 0, `${cwd}: ${JSON.stringify(body)}`);
    }
    // The harness root is the repo's, never the subdirectory.
    assert.equal(existsSync(join(sub, ".harness")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("(mcps-7) memory_context clips bodies to previews; full:true and limit honoured", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home7-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo7-"));
  const env = sandboxEnv(home);
  const bigBody = `plan line\n${"x".repeat(4000)}`;
  try {
    const responses = await driveMcp(dir, env, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_add", arguments: { root: dir, items: [{ title: "big plan", content: bigBody }, { title: "small note", content: "tiny" }], atomic: true } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_context", arguments: { root: dir } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_context", arguments: { root: dir, full: true } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_context", arguments: { root: dir, limit: 1 } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));
    assert.ok(!byId.get(2)?.result?.isError, `seed add failed: ${byId.get(2)?.result?.content?.[0]?.text}`);

    // Default: previews. The 4k body never crosses the wire; id + note do.
    const previewText = byId.get(3)?.result?.content?.[0]?.text ?? "";
    assert.ok(!previewText.includes("x".repeat(600)), "full body not in default payload");
    const preview = JSON.parse(previewText) as {
      observations: { id: string; title: string; preview: string; truncated: boolean; contentChars: number }[];
      note?: string;
    };
    assert.equal(preview.observations.length, 2, "both observations listed");
    const big = preview.observations.find((o) => o.title === "big plan")!;
    assert.ok(big.truncated, "big body marked truncated");
    assert.equal(big.contentChars, bigBody.length);
    assert.ok(big.id.length > 0, "id present for memory_get follow-up");
    assert.match(preview.note ?? "", /memory_get/, "note redirects to memory_get");
    const small = preview.observations.find((o) => o.title === "small note")!;
    assert.equal(small.preview, "tiny");
    assert.equal(small.truncated, false);

    // full:true restores the untruncated payload.
    const fullOut = JSON.parse(byId.get(4)?.result?.content?.[0]?.text ?? "{}") as { observations: { content: string }[] };
    assert.ok(fullOut.observations.some((o) => o.content === bigBody), "full:true returns the whole body");

    // limit:1 returns only the most recent observation.
    const limited = JSON.parse(byId.get(5)?.result?.content?.[0]?.text ?? "{}") as { observations: unknown[] };
    assert.equal(limited.observations.length, 1, "limit honoured");
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

test("(mcps-15) memory_update status: resolve hides from memory_context, keeps search; invalid status is a tool error", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-mcp-home13-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-mcp-repo13-"));
  const env = sandboxEnv(home);
  const init = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ];
  try {
    const first = await driveMcp(dir, env, [
      ...init,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_add", arguments: { root: dir, title: "gadget backlog item", content: "gadget todo" } } },
    ]);
    const added = first.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? "{}";
    const id = (JSON.parse(added) as { observation: { id: string } }).observation.id;
    const responses = await driveMcp(dir, env, [
      ...init,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_update", arguments: { root: dir, id, status: "resolved", resolution: "shipped" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_context", arguments: { root: dir } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_search", arguments: { root: dir, query: "gadget" } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_update", arguments: { root: dir, id, status: "done" } } },
    ]);
    const byId = new Map(responses.map((r) => [r.id, r]));
    assert.ok(!byId.get(2)?.result?.isError, byId.get(2)?.result?.content?.[0]?.text);
    assert.match(byId.get(2)?.result?.content?.[0]?.text ?? "", /"status":"resolved"/);
    assert.doesNotMatch(byId.get(2)?.result?.content?.[0]?.text ?? "", /\n/, "memory tools answer in compact JSON");
    assert.doesNotMatch(byId.get(3)?.result?.content?.[0]?.text ?? "", /gadget/, "resolved note is not context");
    assert.match(byId.get(4)?.result?.content?.[0]?.text ?? "", /"status":"resolved"/, "search still returns it, labelled");
    assert.equal(byId.get(5)?.result?.isError, true);
    assert.match(byId.get(5)?.result?.content?.[0]?.text ?? "", /invalid status "done"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
