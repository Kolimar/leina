// test/cli-help.test.ts — the command table (src/cli/commands.ts): help for every command,
// usage errors (exit 2, stderr hint) before any handler runs, and the table's consistency
// with the dispatcher and the capability registry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COMMANDS, childrenOf, findCommand, renderHelp, resolveInvocation, valueFlags } from "../src/cli/commands.ts";
import { capabilities } from "../src/application/capabilities/registry.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function runCli(args: string[], cwd?: string): { stdout: string; stderr: string; code: number } {
  const home = mkdtempSync(join(tmpdir(), "leina-help-home-"));
  try {
    const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, HOME: home, LEINA_HOME: join(home, ".leina") },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("(help-1) every command and group resolves `--help`, `-h` and `help <cmd>` to its own help", () => {
  for (const spec of COMMANDS) {
    const words = spec.path.split(" ");
    for (const argv of [[...words, "--help"], [...words, "-h"], ["help", ...words]]) {
      assert.deepEqual(resolveInvocation(argv), { kind: "help", path: spec.path }, argv.join(" "));
    }
    const help = renderHelp(spec.path);
    assert.ok(help.startsWith(`leina ${spec.path} — ${spec.summary}\n`), spec.path);
    assert.match(help, /\nUsage:\n {2}leina /, spec.path);
    for (const f of spec.flags ?? []) assert.ok(help.includes(f.name), `${spec.path} help lists ${f.name}`);
    for (const c of childrenOf(spec.path)) assert.ok(help.includes(c.path.split(" ").pop()!), `${spec.path} lists ${c.path}`);
  }
});

test("(help-2) a bare group prints its help; groups that run bare still run", () => {
  for (const group of ["memory", "graph", "env", "harness", "workspace", "capabilities", "events", "impact"]) {
    assert.deepEqual(resolveInvocation([group]), { kind: "help", path: group }, group);
  }
  for (const group of ["mcp", "sidecar", "scip", "audit"]) {
    assert.equal(resolveInvocation([group]).kind, "run", group);
  }
  assert.equal(resolveInvocation(["audit", "some/dir", "--json"]).kind, "run", "audit takes its own <dir>");
});

test("(help-3) the root help leads with the everyday commands and lists every top-level command", () => {
  const help = renderHelp("");
  assert.match(help, /^leina — code knowledge graph \+ project memory for AI agents\n\nUsage: leina <command> \[args\]\n\nEveryday:\n {2}query /);
  for (const top of COMMANDS.filter((c) => !c.path.includes(" ") && c.section !== undefined)) {
    assert.match(help, new RegExp(`^ {2}${top.path}\\b`, "m"), top.path);
  }
  assert.match(help, /Exit codes: 0 success · 1 runtime failure · 2 usage error/);
  for (const line of help.split("\n")) assert.ok(line.length <= 100, `root help line too wide: ${line}`);
  assert.deepEqual(resolveInvocation([]), { kind: "help", path: "" });
  assert.deepEqual(resolveInvocation(["--help"]), { kind: "help", path: "" });
  assert.deepEqual(resolveInvocation(["help"]), { kind: "help", path: "" });
});

test("(help-4) unknown commands, sub-commands and flags are usage errors with a suggestion", () => {
  assert.deepEqual(resolveInvocation(["memroy"]), {
    kind: "usage",
    path: "",
    message: "unknown command 'memroy' (did you mean 'memory'?)",
  });
  assert.deepEqual(resolveInvocation(["memory", "serch", "x"]), {
    kind: "usage",
    path: "memory",
    message: "unknown sub-command 'serch' (did you mean 'search'?)",
  });
  assert.deepEqual(resolveInvocation(["query", "x", "--jsno"]), {
    kind: "usage",
    path: "query",
    message: "unknown flag '--jsno' (did you mean '--json'?)",
  });
  assert.deepEqual(resolveInvocation(["status", "--frob"]), {
    kind: "usage",
    path: "status",
    message: "unknown flag '--frob' (it takes no flags)",
  });
  assert.deepEqual(resolveInvocation(["help", "nope"]), {
    kind: "usage",
    path: "",
    message: "unknown command 'nope'",
  });
});

test("(help-5) a flag missing its value is a usage error, never a swallowed positional", () => {
  assert.deepEqual(resolveInvocation(["affected", "Foo", "--depth"]), {
    kind: "usage",
    path: "affected",
    message: "--depth requires a value <n>",
  });
  assert.equal(resolveInvocation(["memory", "save", "--title", "--content", "x"]).kind, "usage");
  assert.equal(resolveInvocation(["visualize", "--out", "x.html"]).kind, "run");
});

test("(help-6) `leina <group> <dir> <sub>` names the right order", () => {
  const inv = resolveInvocation(["memory", ".", "context"]);
  assert.equal(inv.kind, "usage");
  assert.match((inv as { message: string }).message, /the sub-command comes first: leina memory context \./);
});

test("(help-7) `--flag=value` is accepted for value flags; `=` on a boolean flag is an error", () => {
  assert.deepEqual(resolveInvocation(["memory", "search", "foo", "--limit=3"]), {
    kind: "run",
    path: "memory search",
    argv: ["memory", "search", "foo", "--limit", "3"],
  });
  assert.deepEqual(resolveInvocation(["query", "x", "--json=true"]), {
    kind: "usage",
    path: "query",
    message: "--json takes no value",
  });
  assert.deepEqual(resolveInvocation(["memory", "search", "foo", "--limt=3"]), {
    kind: "usage",
    path: "memory search",
    message: "unknown flag '--limt' (did you mean '--limit'?)",
  });
});

test("(help-8) what follows `--` belongs to another program; hooks are never validated", () => {
  assert.deepEqual(resolveInvocation(["env", "exec", "--", "tool", "--help", "--x=1"]), {
    kind: "run",
    path: "env exec",
    argv: ["env", "exec", "--", "tool", "--help", "--x=1"],
  });
  for (const hook of [["agent-hook"], ["devin-hook"], ["harness", "hook"]]) {
    const argv = [...hook, "PreToolUse", "--whatever", "x"];
    assert.equal(resolveInvocation(argv).kind, "run", hook.join(" "));
    assert.equal(resolveInvocation([...hook, "--help"]).kind, "help", hook.join(" "));
  }
});

test("(help-9) aliases resolve to their command", () => {
  assert.equal(resolveInvocation(["harness", "compile"]).kind, "run");
  assert.deepEqual(resolveInvocation(["harness", "compile", "--help"]), { kind: "help", path: "harness sync" });
  assert.deepEqual(resolveInvocation(["devin-hook", "--help"]), { kind: "help", path: "agent-hook" });
  assert.equal(resolveInvocation(["--version"]).kind, "version");
  assert.equal(resolveInvocation(["-v"]).kind, "version");
});

test("(help-10) valueFlags lists exactly the flags that take a value", () => {
  assert.deepEqual(valueFlags("affected"), ["--depth"]);
  assert.ok(valueFlags("memory search").includes("--limit"));
  assert.ok(!valueFlags("memory search").includes("--json"));
});

test("(help-11) every registry CLI mapping names a command and flags the table accepts", () => {
  for (const c of capabilities) {
    if (!c.cli) continue;
    // The mapping may carry a positional after the path (`agent-hook SessionStart`).
    const words = c.cli.command.split(" ");
    let spec = findCommand(c.cli.command);
    for (let n = words.length - 1; !spec && n > 0; n--) spec = findCommand(words.slice(0, n).join(" "));
    assert.ok(spec, `${c.capability.id}: unknown CLI command '${c.cli.command}'`);
    const known = new Set((spec.flags ?? []).map((f) => f.name));
    for (const flag of c.cli.flags ?? []) {
      assert.ok(known.has(flag), `${c.capability.id}: '${c.cli.command}' does not accept ${flag}`);
    }
  }
});

test("(help-12) CLI: usage errors go to stderr with a hint and exit 2; help goes to stdout", () => {
  const unknown = runCli(["query", ".", "x", "--frob"]);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr, "leina query: unknown flag '--frob'\nrun 'leina query --help' for usage\n");

  const viaHelp = runCli(["help", "memory", "search"]);
  const viaFlag = runCli(["memory", "search", "--help"]);
  assert.equal(viaHelp.code, 0);
  assert.equal(viaFlag.code, 0);
  assert.equal(viaHelp.stdout, viaFlag.stdout);
  assert.match(viaFlag.stdout, /^leina memory search — /);
  assert.equal(viaFlag.stderr, "");
});

test("(help-13) CLI: a help request or usage error writes nothing to the cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "leina-help-cwd-"));
  try {
    for (const args of [["build", "--help"], ["build", "--frob"], ["build", "--json=x"], ["memroy", "save"]]) {
      runCli(args, dir);
    }
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
