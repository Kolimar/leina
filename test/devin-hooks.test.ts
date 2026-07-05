// devin-hooks.test.ts — pure writers for .devin/hooks.v1.json (project) and the user-global
// ~/.config/devin/config.json `hooks` key. Mirrors hooks.ts (Windsurf) for the Devin/Claude shape.
//
// Contract: devinHooksJson(cli, project, existing?) → FileArtifact { path, content }.
//           devinUserConfigWithHooks(existing|null, hooks) → string.
// Both must be idempotent + merge-safe + refuse to clobber malformed JSON.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEVIN_MANAGED_EVENTS,
  devinHooksJson,
  devinUserConfigWithHooks,
  buildUserGlobalHooks,
  removeUserGlobalHooks,
  type DevinHooksFile,
} from "../src/application/install/devin-hooks.ts";
import type { McpCommand } from "../src/application/install/protocol.ts";

const CLI_DEV: McpCommand = {
  command: "node",
  args: ["--no-warnings", "--experimental-strip-types", "/abs/leina/src/cli/index.ts"],
};
const CLI_BIN: McpCommand = { command: "leina", args: [] };
const PROJECT = "/abs/work/project";

// ---------- devinHooksJson — project file .devin/hooks.v1.json ----------

test("(devin-hooks-1) writes to .devin/hooks.v1.json", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  assert.equal(out.path, ".devin/hooks.v1.json");
});

test("(devin-hooks-2) emits all managed event keys with correct matcher group counts", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  for (const ev of DEVIN_MANAGED_EVENTS) {
    assert.ok(Array.isArray(parsed[ev]), `${ev} is an array`);
  }
  // PreToolUse: ^(edit|write|exec)$ + ^(grep|glob)$ (Palanca A, ADR-1 additive).
  assert.equal(parsed.PreToolUse.length, 2);
  // PostToolUse: ^(edit|write)$ (refresh) + ^exec$ (marker) + ^(read|grep|glob)$ (Palanca C).
  assert.equal(parsed.PostToolUse.length, 3);
  assert.equal(parsed.UserPromptSubmit.length, 1);
  assert.equal(parsed.SessionStart.length, 1);
});

test("(devin-hooks-3) PreToolUse matcher is ^(edit|write|exec)$ and invokes `devin-hook PreToolUse`", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  const entry = parsed.PreToolUse[0];
  assert.equal(entry.matcher, "^(edit|write|exec)$");
  assert.equal(entry.hooks.length, 1);
  assert.equal(entry.hooks[0].type, "command");
  assert.match(entry.hooks[0].command, /devin-hook PreToolUse/);
});

test("(devin-hooks-4) PostToolUse has freshness-refresh, exec-marker and native-nudge groups", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  const matchers = parsed.PostToolUse.map((m: { matcher: string }) => m.matcher).sort();
  // ^(edit|write)$ → leina refresh <project> (freshness)
  // ^exec$         → devin-hook PostToolUse (memory marker write)
  // ^(read|grep|glob)$ → devin-hook PostToolUse (Palanca C retrospective nudge)
  assert.deepEqual(matchers, [
    "^(edit|write)$",
    "^exec$",
    "^(read|grep|glob)$",
  ].sort());
  const refresh = parsed.PostToolUse.find((m: { matcher: string }) => m.matcher === "^(edit|write)$");
   
  assert.match(refresh.hooks[0].command, new RegExp(`refresh ${PROJECT.replace(/\//g, "\\/")}`));
  const marker = parsed.PostToolUse.find((m: { matcher: string }) => m.matcher === "^exec$");
  assert.match(marker.hooks[0].command, /devin-hook PostToolUse/);
  const native = parsed.PostToolUse.find((m: { matcher: string }) => m.matcher === "^(read|grep|glob)$");
  assert.ok(native, "native matcher entry present");
  assert.match(native.hooks[0].command, /devin-hook PostToolUse/);
});

test("(devin-hooks-5) UserPromptSubmit invokes the gate (`devin-hook UserPromptSubmit`) with empty matcher", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  const entry = parsed.UserPromptSubmit[0];
  assert.equal(entry.matcher, "");
  assert.match(entry.hooks[0].command, /devin-hook UserPromptSubmit/);
});

test("(devin-hooks-6) SessionStart invokes `devin-hook SessionStart` with empty matcher", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  const entry = parsed.SessionStart[0];
  assert.equal(entry.matcher, "");
  assert.match(entry.hooks[0].command, /devin-hook SessionStart/);
});

test("(devin-hooks-7) every managed hook entry has type 'command' and a non-empty command string", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  for (const ev of DEVIN_MANAGED_EVENTS) {
    for (const group of parsed[ev]) {
      for (const h of group.hooks) {
        assert.equal(h.type, "command", `${ev} entry type`);
        assert.ok(typeof h.command === "string" && h.command.length > 0, `${ev} command non-empty`);
      }
    }
  }
});

test("(devin-hooks-8) idempotent: re-running on prior output yields byte-identical content", () => {
  const once = devinHooksJson(CLI_BIN, PROJECT, null).content;
  const twice = devinHooksJson(CLI_BIN, PROJECT, once).content;
  assert.equal(once, twice);
});

test("(devin-hooks-9) merge-safe: preserves unmanaged event keys in existing file", () => {
  const existing = JSON.stringify({
    PreToolUse: [{ matcher: "^read$", hooks: [{ type: "command", command: "echo custom" }] }],
    Notification: [{ matcher: "", hooks: [{ type: "command", command: "echo unrelated" }] }],
  });
  const out = devinHooksJson(CLI_BIN, PROJECT, existing);
  const parsed = JSON.parse(out.content);
  // Unmanaged event key kept verbatim:
  assert.deepEqual(parsed.Notification, [
    { matcher: "", hooks: [{ type: "command", command: "echo unrelated" }] },
  ]);
  // Unmanaged matcher inside a managed event is also preserved (only managed matchers replaced):
  const preToolMatchers = parsed.PreToolUse.map((m: { matcher: string }) => m.matcher);
  assert.ok(preToolMatchers.includes("^read$"), "preserved unmanaged matcher");
  assert.ok(preToolMatchers.includes("^(edit|write|exec)$"), "managed matcher present");
});

test("(devin-hooks-10) dev CLI cmd quoted/joined via shellJoin (paths with spaces)", () => {
  const cliWithSpace: McpCommand = {
    command: "node",
    args: ["--no-warnings", "/Users/me/My Repos/leina/src/cli/index.ts"],
  };
  const out = devinHooksJson(cliWithSpace, PROJECT, null);
  const parsed = JSON.parse(out.content);
  // quoted arg with space:
  assert.match(parsed.PreToolUse[0].hooks[0].command, /"\/Users\/me\/My Repos\/leina\/src\/cli\/index\.ts"/);
});

test("(devin-hooks-11) throws on malformed existing JSON instead of clobbering", () => {
  assert.throws(() => devinHooksJson(CLI_BIN, PROJECT, "{ not json"), /JSON|object/i);
});

test("(devin-hooks-12) dev launcher (node + flags) flows through into commands", () => {
  const out = devinHooksJson(CLI_DEV, PROJECT, null);
  const parsed = JSON.parse(out.content);
  assert.match(parsed.PreToolUse[0].hooks[0].command, /^node /);
  assert.match(parsed.PreToolUse[0].hooks[0].command, /--experimental-strip-types/);
  assert.match(parsed.PreToolUse[0].hooks[0].command, /index\.ts devin-hook PreToolUse$/);
});

// ---------- devinUserConfigWithHooks — user-global ~/.config/devin/config.json hooks key ----------

function userGlobalHooks(): DevinHooksFile {
  // Build a minimal user-global hooks block from the project writer, then drop the freshness
  // refresh group (tests just need a "valid managed-shape" payload to feed the user-global merger).
  const proj = JSON.parse(devinHooksJson(CLI_BIN, "/x", null).content) as DevinHooksFile;
  proj.PostToolUse = proj.PostToolUse.filter(
    (m) => !m.matcher.startsWith("^(edit|write)"),
  );
  return proj;
}

test("(devin-user-1) seeds a fresh config from null with only the hooks key + managed events", () => {
  const out = devinUserConfigWithHooks(null, userGlobalHooks());
  const parsed = JSON.parse(out);
  assert.ok(parsed.hooks, "hooks key present");
  for (const ev of DEVIN_MANAGED_EVENTS) {
    assert.ok(Array.isArray(parsed.hooks[ev]), `${ev} array present`);
  }
});

test("(devin-user-2) preserves unrelated top-level keys (mcpServers, etc.)", () => {
  const existing = JSON.stringify({
    mcpServers: { other: { command: "x", args: [] } },
    customKey: 42,
  });
  const out = devinUserConfigWithHooks(existing, userGlobalHooks());
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.mcpServers, { other: { command: "x", args: [] } });
  assert.equal(parsed.customKey, 42);
  assert.ok(parsed.hooks.PreToolUse);
});

test("(devin-user-3) preserves unrelated hook entries already present under `hooks` key", () => {
  const existing = JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "^read$", hooks: [{ type: "command", command: "echo keep" }] }],
      MyCustomEvent: [{ matcher: "", hooks: [{ type: "command", command: "echo keep-event" }] }],
    },
  });
  const out = devinUserConfigWithHooks(existing, userGlobalHooks());
  const parsed = JSON.parse(out);
  assert.ok(parsed.hooks.MyCustomEvent, "unmanaged event preserved");
  const preToolMatchers = parsed.hooks.PreToolUse.map((m: { matcher: string }) => m.matcher);
  assert.ok(preToolMatchers.includes("^read$"), "unmanaged matcher preserved");
  assert.ok(preToolMatchers.includes("^(edit|write|exec)$"), "managed matcher present");
});

test("(devin-user-4) idempotent: re-running on prior output yields byte-identical content", () => {
  const hooks = userGlobalHooks();
  const once = devinUserConfigWithHooks(null, hooks);
  const twice = devinUserConfigWithHooks(once, hooks);
  assert.equal(once, twice);
});

test("(devin-user-5) throws on malformed existing JSON instead of clobbering", () => {
  assert.throws(() => devinUserConfigWithHooks("{ not json", userGlobalHooks()), /JSON|object/i);
});

// ---------------------------------------------------------------------------
// T8: PostCompaction in devin-hooks.ts (FR-5, FR-8)
// ---------------------------------------------------------------------------

test("(devin-hooks-PostCompaction-1) DEVIN_MANAGED_EVENTS includes PostCompaction", () => {
  assert.ok(
    (DEVIN_MANAGED_EVENTS as readonly string[]).includes("PostCompaction"),
    "PostCompaction must be in DEVIN_MANAGED_EVENTS",
  );
});

test("(devin-hooks-PostCompaction-2) devinHooksJson output contains PostCompaction key with empty matcher and correct command", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  assert.ok(Array.isArray(parsed.PostCompaction), "PostCompaction key is an array");
  assert.equal(parsed.PostCompaction.length, 1, "exactly 1 matcher group for PostCompaction");
  const entry = parsed.PostCompaction[0];
  assert.equal(entry.matcher, "", "PostCompaction has empty string matcher");
  assert.equal(entry.hooks.length, 1, "exactly 1 hook command");
  assert.equal(entry.hooks[0].type, "command");
  assert.match(entry.hooks[0].command, /devin-hook PostCompaction/, "command invokes devin-hook PostCompaction");
});

test("(devin-hooks-PostCompaction-3) buildUserGlobalHooks includes PostCompaction", () => {
  const hooks = buildUserGlobalHooks(CLI_BIN);
  assert.ok(Array.isArray(hooks.PostCompaction), "PostCompaction present in user-global hooks");
  assert.equal(hooks.PostCompaction.length, 1, "exactly 1 PostCompaction entry");
  assert.match(hooks.PostCompaction[0]!.hooks[0]!.command, /devin-hook PostCompaction/);
});

test("(devin-hooks-PostCompaction-4) devinHooksJson emits all 5 managed event keys after adding PostCompaction", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  for (const ev of DEVIN_MANAGED_EVENTS) {
    assert.ok(Array.isArray(parsed[ev]), `${ev} is an array`);
  }
  assert.equal(parsed.PostCompaction.length, 1, "PostCompaction has 1 matcher group");
});

test("(devin-hooks-PostCompaction-5/FR8a) merge-safe: adding PostCompaction to existing install without clobbering user hooks", () => {
  // Simulate an existing install that has PostToolUse user hooks but NO PostCompaction
  const existing = JSON.stringify({
    PreToolUse: [{ matcher: "^(edit|write|exec)$", hooks: [{ type: "command", command: "old-cmd" }] }],
    PostToolUse: [{ matcher: "^exec$", hooks: [{ type: "command", command: "user-exec-hook" }] }],
    CustomUserEvent: [{ matcher: "", hooks: [{ type: "command", command: "user-custom" }] }],
  });
  const out = devinHooksJson(CLI_BIN, PROJECT, existing);
  const parsed = JSON.parse(out.content);
  // PostCompaction should be ADDED
  assert.ok(Array.isArray(parsed.PostCompaction), "PostCompaction added to existing install");
  assert.match(parsed.PostCompaction[0].hooks[0].command, /devin-hook PostCompaction/);
  // User's unmanaged event is preserved
  assert.deepEqual(parsed.CustomUserEvent, [
    { matcher: "", hooks: [{ type: "command", command: "user-custom" }] },
  ]);
  // Managed events still include user-exec-hook (unmanaged matcher within PostToolUse preserved)
  const postToolMatchers = parsed.PostToolUse.map((m: { matcher: string }) => m.matcher);
  assert.ok(postToolMatchers.includes("^exec$"), "exec matcher present in PostToolUse");
});

test("(devin-hooks-PostCompaction-6/FR8b) idempotent: re-running when PostCompaction already present → byte-identical output", () => {
  const once = devinHooksJson(CLI_BIN, PROJECT, null).content;
  const twice = devinHooksJson(CLI_BIN, PROJECT, once).content;
  assert.equal(once, twice, "output is byte-identical on re-run with PostCompaction present");
});

test("(devin-hooks-PostCompaction-7) devinUserConfigWithHooks includes PostCompaction from buildUserGlobalHooks", () => {
  const hooks = buildUserGlobalHooks(CLI_BIN);
  const out = devinUserConfigWithHooks(null, hooks);
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.hooks.PostCompaction), "PostCompaction in user-global config");
  assert.match(parsed.hooks.PostCompaction[0].hooks[0].command, /devin-hook PostCompaction/);
});

// ---------------------------------------------------------------------------
// T7: Stop event registration in devin-hooks.ts (FR-4, NFR-5, NFR-6 — mirrors PostCompaction block)
// ---------------------------------------------------------------------------

test("(devin-hooks-Stop-1) DEVIN_MANAGED_EVENTS includes Stop", () => {
  assert.ok(
    (DEVIN_MANAGED_EVENTS as readonly string[]).includes("Stop"),
    "Stop must be in DEVIN_MANAGED_EVENTS",
  );
});

test("(devin-hooks-Stop-2) devinHooksJson output contains Stop key with empty matcher and correct command", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  assert.ok(Array.isArray(parsed.Stop), "Stop key is an array");
  assert.equal(parsed.Stop.length, 1, "exactly 1 matcher group for Stop");
  const entry = parsed.Stop[0];
  assert.equal(entry.matcher, "", "Stop has empty string matcher");
  assert.equal(entry.hooks.length, 1, "exactly 1 hook command");
  assert.equal(entry.hooks[0].type, "command");
  assert.match(entry.hooks[0].command, /devin-hook Stop/, "command invokes devin-hook Stop");
});

test("(devin-hooks-Stop-3) buildUserGlobalHooks includes Stop", () => {
  const hooks = buildUserGlobalHooks(CLI_BIN);
  assert.ok(Array.isArray(hooks.Stop), "Stop present in user-global hooks");
  assert.equal(hooks.Stop.length, 1, "exactly 1 Stop entry");
  assert.match(hooks.Stop[0]!.hooks[0]!.command, /devin-hook Stop/);
});

test("(devin-hooks-Stop-4) devinHooksJson emits all 6 managed event keys including Stop", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  for (const ev of DEVIN_MANAGED_EVENTS) {
    assert.ok(Array.isArray(parsed[ev]), `${ev} is an array`);
  }
  assert.equal(parsed.Stop.length, 1, "Stop has 1 matcher group");
});

test("(devin-hooks-Stop-5/idempotent) merge-safe: adding Stop to existing install without clobbering user hooks", () => {
  // Simulate an existing install that has PostToolUse user hooks but NO Stop
  const existing = JSON.stringify({
    PreToolUse: [{ matcher: "^(edit|write|exec)$", hooks: [{ type: "command", command: "old-cmd" }] }],
    PostToolUse: [{ matcher: "^exec$", hooks: [{ type: "command", command: "user-exec-hook" }] }],
    CustomUserEvent: [{ matcher: "", hooks: [{ type: "command", command: "user-custom" }] }],
  });
  const out = devinHooksJson(CLI_BIN, PROJECT, existing);
  const parsed = JSON.parse(out.content);
  // Stop should be ADDED
  assert.ok(Array.isArray(parsed.Stop), "Stop added on merge");
  assert.match(parsed.Stop[0].hooks[0].command, /devin-hook Stop/);
  // Unrelated custom event preserved
  assert.deepEqual(parsed.CustomUserEvent, [
    { matcher: "", hooks: [{ type: "command", command: "user-custom" }] },
  ]);
  // Managed events still include user-exec-hook (unmanaged matcher within PostToolUse preserved)
  const postToolMatchers = parsed.PostToolUse.map((m: { matcher: string }) => m.matcher);
  assert.ok(postToolMatchers.includes("^exec$"), "exec matcher present in PostToolUse");
});

test("(devin-hooks-Stop-6/idempotent) re-running when Stop already present → byte-identical output", () => {
  const once = devinHooksJson(CLI_BIN, PROJECT, null).content;
  const twice = devinHooksJson(CLI_BIN, PROJECT, once).content;
  assert.equal(once, twice, "output is byte-identical on re-run with Stop present");
});

test("(devin-hooks-Stop-7) devinUserConfigWithHooks includes Stop from buildUserGlobalHooks", () => {
  const hooks = buildUserGlobalHooks(CLI_BIN);
  const out = devinUserConfigWithHooks(null, hooks);
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.hooks.Stop), "Stop in user-global config");
  assert.match(parsed.hooks.Stop[0].hooks[0].command, /devin-hook Stop/);
});

// ---------------------------------------------------------------------------
// Palanca A + C — new matchers (ADR-1 additive, spec §PreToolUse/PostToolUse Matchers)
// ---------------------------------------------------------------------------

test("(devin-hooks-new-1) PreToolUse includes ^(grep|glob)$ in addition to existing ^(edit|write|exec)$", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  const matchers = parsed.PreToolUse.map((m: { matcher: string }) => m.matcher);
  assert.ok(matchers.includes("^(grep|glob)$"), "^(grep|glob)$ present (Palanca A)");
  assert.ok(matchers.includes("^(edit|write|exec)$"), "original matcher preserved (ADR-1)");
  assert.equal(parsed.PreToolUse.length, 2, "exactly 2 PreToolUse groups");
});

test("(devin-hooks-new-2) PostToolUse includes ^(read|grep|glob)$ (Palanca C)", () => {
  const out = devinHooksJson(CLI_BIN, PROJECT, null);
  const parsed = JSON.parse(out.content);
  const matchers = parsed.PostToolUse.map((m: { matcher: string }) => m.matcher);
  assert.ok(matchers.includes("^(read|grep|glob)$"), "^(read|grep|glob)$ present");
  assert.equal(parsed.PostToolUse.length, 3, "exactly 3 PostToolUse groups");
  const entry = parsed.PostToolUse.find((m: { matcher: string }) => m.matcher === "^(read|grep|glob)$");
  assert.ok(entry, "entry found");
  assert.match(entry.hooks[0].command, /devin-hook PostToolUse/);
});

test("(devin-hooks-new-3) buildUserGlobalHooks preserves ^(read|grep|glob)$ and excludes refresh matcher", () => {
  const hooks = buildUserGlobalHooks(CLI_BIN);
  const matchers = hooks.PostToolUse.map((m) => m.matcher);
  assert.ok(matchers.includes("^(read|grep|glob)$"), "native matcher present in user-global hooks");
  assert.ok(!matchers.some((m) => m.startsWith("^(edit|write)")), "refresh matcher excluded from user-global");
});

test("(devin-hooks-new-4) idempotent with new matchers: re-running on own output yields byte-identical content", () => {
  const once = devinHooksJson(CLI_BIN, PROJECT, null).content;
  const twice = devinHooksJson(CLI_BIN, PROJECT, once).content;
  assert.equal(once, twice, "idempotent with new PreToolUse + PostToolUse matchers");
});

// ---------- removeUserGlobalHooks (inverse of devinUserConfigWithHooks) ----------

test("(hooks-remove-a) null/blank input → null", () => {
  assert.equal(removeUserGlobalHooks(null), null);
  assert.equal(removeUserGlobalHooks(""), null);
  assert.equal(removeUserGlobalHooks("   "), null);
});

test("(hooks-remove-b) malformed JSON → null (no-clobber, no throw)", () => {
  assert.doesNotThrow(() => {
    const r = removeUserGlobalHooks("{ not json");
    assert.equal(r, null);
  });
});

test("(hooks-remove-c) no hooks key → null (nothing to remove)", () => {
  const input = JSON.stringify({ mcpServers: { x: { command: "x" } } });
  assert.equal(removeUserGlobalHooks(input), null);
});

test("(hooks-remove-d) no managed matchers present → null (idempotent)", () => {
  // User-only hooks, no managed matchers
  const input = JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "^custom$", hooks: [{ type: "command", command: "custom" }] }],
    },
  });
  assert.equal(removeUserGlobalHooks(input), null);
});

test("(hooks-remove-e) round-trip: devinUserConfigWithHooks then removeUserGlobalHooks", () => {
  const hooks = buildUserGlobalHooks(CLI_BIN);
  const withHooks = devinUserConfigWithHooks(null, hooks);
  assert.ok(JSON.parse(withHooks).hooks, "hooks present after install");

  const removed = removeUserGlobalHooks(withHooks);
  assert.ok(removed !== null, "returns non-null when managed hooks were present");
  const parsed = JSON.parse(removed);
  // No managed event should survive
  for (const ev of DEVIN_MANAGED_EVENTS) {
    assert.ok(!parsed.hooks?.[ev], `${ev} removed`);
  }
});

test("(hooks-remove-f) preserves unmanaged matchers inside managed events", () => {
  const hooks = buildUserGlobalHooks(CLI_BIN);
  const base = JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "^custom-user$", hooks: [{ type: "command", command: "user-pre" }] },
      ],
    },
  });
  const withHooks = devinUserConfigWithHooks(base, hooks);
  const removed = removeUserGlobalHooks(withHooks)!;
  assert.ok(removed !== null, "had managed hooks");
  const parsed = JSON.parse(removed);
  // The unmanaged ^custom-user$ matcher must survive
  const preToolUse = parsed.hooks?.PreToolUse ?? [];
  const userMatcher = preToolUse.find((m: { matcher: string }) => m.matcher === "^custom-user$");
  assert.ok(userMatcher, "unmanaged matcher ^custom-user$ preserved");
});

test("(hooks-remove-g) preserves unmanaged event keys and top-level keys", () => {
  const hooks = buildUserGlobalHooks(CLI_BIN);
  const base = JSON.stringify({
    mcpServers: { x: { command: "x" } },
    customKey: 99,
    hooks: {
      CustomEvent: [{ matcher: "", hooks: [{ type: "command", command: "custom" }] }],
    },
  });
  const withHooks = devinUserConfigWithHooks(base, hooks);
  const removed = removeUserGlobalHooks(withHooks)!;
  const parsed = JSON.parse(removed);
  assert.deepEqual(parsed.mcpServers, { x: { command: "x" } }, "mcpServers preserved");
  assert.equal(parsed.customKey, 99, "top-level key preserved");
  assert.ok(Array.isArray(parsed.hooks?.CustomEvent), "unmanaged CustomEvent preserved");
});

test("(hooks-remove-h) idempotent: removing twice → null second time", () => {
  const hooks = buildUserGlobalHooks(CLI_BIN);
  const withHooks = devinUserConfigWithHooks(null, hooks);
  const once = removeUserGlobalHooks(withHooks)!;
  assert.ok(once !== null, "first remove produced output");
  assert.equal(removeUserGlobalHooks(once), null, "second remove is idempotent no-op");
});
