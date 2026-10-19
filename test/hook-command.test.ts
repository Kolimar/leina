// hook-command.test.ts — the managed hook launch line: builder, parser and the helpers doctor
// and the gate use to find leina's entries in host config files.
// Run: node --no-warnings --experimental-strip-types --test test/hook-command.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentHookCommand,
  hookCommandsIn,
  isLegacyRefreshCommand,
  managedHookCommands,
  parseManagedHookCommand,
} from "../src/application/install/hook-command.ts";

const DEV = { command: "/usr/bin/node", args: ["--no-warnings", "--experimental-strip-types", "/repo/src/cli/index.ts"] };
const SPACED = { command: "C:/Program Files/nodejs/node.exe", args: ["C:/Users/A B/leina/dist/cli/index.js"] };

test("(hc-1) builder: host always, --scope only for the user-global copy", () => {
  assert.equal(
    agentHookCommand(DEV, "Stop", "claude", "project"),
    "/usr/bin/node --no-warnings --experimental-strip-types /repo/src/cli/index.ts agent-hook Stop --host claude",
  );
  assert.match(agentHookCommand(DEV, "Stop", "devin", "user"), /agent-hook Stop --host devin --scope user$/);
});

test("(hc-2) parser round-trips the builder, including quoted paths with spaces", () => {
  const parsed = parseManagedHookCommand(agentHookCommand(SPACED, "PreToolUse", "devin", "user"));
  assert.deepEqual(parsed, {
    node: "C:/Program Files/nodejs/node.exe",
    cli: "C:/Users/A B/leina/dist/cli/index.js",
    event: "PreToolUse",
    host: "devin",
    scope: "user",
  });
  const dev = parseManagedHookCommand(agentHookCommand(DEV, "SessionStart", "claude", "project"));
  assert.equal(dev?.cli, "/repo/src/cli/index.ts", "node flags are not mistaken for the CLI entry");
  assert.equal(dev?.scope, "project");
});

test("(hc-3) parser: legacy forms (no flags, devin-hook alias) are still ours; foreign commands are not", () => {
  const legacy = parseManagedHookCommand("/n /old/dist/cli/index.js devin-hook Stop");
  assert.deepEqual(legacy, { node: "/n", cli: "/old/dist/cli/index.js", event: "Stop", scope: "project" });
  assert.equal(parseManagedHookCommand("other-tool warmup"), undefined);
  assert.equal(parseManagedHookCommand("agent-hook Stop"), undefined, "no launcher before the subcommand");
  assert.equal(parseManagedHookCommand(42), undefined);
});

test("(hc-4) legacy refresh entries are recognised only as a CLI entry's refresh", () => {
  assert.equal(isLegacyRefreshCommand("/n /x/dist/cli/index.js refresh /proj"), true);
  assert.equal(isLegacyRefreshCommand("npm run refresh"), false);
});

test("(hc-5) hookCommandsIn / managedHookCommands read both file shapes and filter by scope", () => {
  const user = agentHookCommand(DEV, "Stop", "claude", "user");
  const proj = agentHookCommand(DEV, "Stop", "claude", "project");
  const settings = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: user }, { type: "command", command: "keep" }] }], Pre: "junk" },
  });
  assert.equal(hookCommandsIn(JSON.parse(settings).hooks).length, 2);
  assert.equal(managedHookCommands(settings, "hooks-key").length, 1);
  assert.equal(managedHookCommands(settings, "hooks-key", "project").length, 0);
  const devinFile = JSON.stringify({ Stop: [{ matcher: "", hooks: [{ type: "command", command: proj }] }] });
  assert.equal(managedHookCommands(devinFile, "root", "project").length, 1);
  assert.deepEqual(managedHookCommands("{ broken", "root"), []);
  assert.deepEqual(managedHookCommands(null, "hooks-key"), []);
});
