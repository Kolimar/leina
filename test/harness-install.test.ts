// harness-install.test.ts — the `leina init` harness bootstrap writer
// (bootstrapHarness: .harness/config.json seed + in-process sync) and its
// per-repo inverse (deinitHarness): idempotency, clean round-trip, the
// "user content is never touched" guarantees (rules/state/hand-edits), and
// lockfile path containment (a hostile lockfile never reaches outside the repo).
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-install.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bootstrapHarness,
  deinitHarness,
  HARNESS_MINIMAL_CONFIG,
} from "../src/application/install/harness-init.ts";
import { runSync } from "../src/application/harness/sync.ts";
import { sha256 } from "../src/application/harness/adapters/managed-block.ts";
import { GITIGNORE_BODY } from "../src/application/install/gitignore.ts";
import { makeTmpRepo, isolateLeinaHome, type TmpRepo } from "./helpers/harness-tmprepo.ts";

let repo: TmpRepo;
let restoreHome: () => void;

beforeEach(async () => {
  repo = await makeTmpRepo(false); // no git needed — sync/deinit are fs-only
  restoreHome = isolateLeinaHome(path.join(repo.root, "no-user-config"));
});

afterEach(async () => {
  restoreHome();
  await repo.cleanup();
});

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(repo.root, rel), "utf8");
}

async function exists(rel: string): Promise<boolean> {
  return fs.access(path.join(repo.root, rel)).then(
    () => true,
    () => false,
  );
}

describe("bootstrapHarness (leina init step)", () => {
  it("seeds the minimal config and writes NO platform artifacts without hosts or evidence", async () => {
    const result = await bootstrapHarness(repo.root);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    assert.ok(result.written.some((w) => w.includes(".harness/config.json")));
    assert.ok(result.written.some((w) => w.startsWith("harness sync:")));

    assert.equal(await read(".harness/config.json"), HARNESS_MINIMAL_CONFIG);
    assert.equal(await exists("AGENTS.md"), false, "no host auto-elected in an empty repo");
    assert.equal(await exists("CLAUDE.md"), false);
  });

  it("targets the hosts chosen with --hosts and persists them as config.platforms", async () => {
    const result = await bootstrapHarness(repo.root, ["claude"]);
    assert.deepEqual(result.failures, [], result.failures.join("; "));

    const config = JSON.parse(await read(".harness/config.json"));
    assert.deepEqual(config, { platforms: ["claude-code"] });
    assert.match(await read("CLAUDE.md"), /harness:begin/);
    assert.ok(await exists(".claude/skills/harness-workflow/SKILL.md"));
    assert.equal(await exists("AGENTS.md"), false, "agentsmd only when the repo already carries one");
  });

  it("includes agentsmd only when the repo already carries an AGENTS.md", async () => {
    await repo.write("AGENTS.md", "# My project\n");
    const result = await bootstrapHarness(repo.root, ["claude"]);
    assert.deepEqual(result.failures, []);
    const config = JSON.parse(await read(".harness/config.json"));
    assert.deepEqual(config, { platforms: ["claude-code", "agentsmd"] });
    assert.match(await read("AGENTS.md"), /harness:begin/);
  });

  it("is idempotent: a second run changes nothing and reports up-to-date", async () => {
    await bootstrapHarness(repo.root, ["claude"]);
    const claudeBefore = await read("CLAUDE.md");
    const lockBefore = await read(".harness/harness.lock.json");

    const second = await bootstrapHarness(repo.root, ["claude"]);
    assert.deepEqual(second.failures, []);
    assert.ok(second.written.some((w) => w.includes("artifacts up to date")), second.written.join("; "));
    assert.ok(!second.written.some((w) => w.includes(".harness/config.json")), "config not re-reported");
    assert.equal(await read("CLAUDE.md"), claudeBefore);
    assert.equal(await read(".harness/harness.lock.json"), lockBefore);
  });

  it("respects an existing .harness/config.json (never overwrites)", async () => {
    const custom = JSON.stringify({ strictness: "strict" });
    await repo.write(".harness/config.json", custom);
    const result = await bootstrapHarness(repo.root);
    assert.equal(await read(".harness/config.json"), custom);
    assert.ok(!result.written.some((w) => w.includes(".harness/config.json (created")));
  });

  it("detects Claude Code when .claude/ exists and emits its skill artifacts", async () => {
    await repo.write(".claude/settings.json", "{}\n");
    const result = await bootstrapHarness(repo.root);
    assert.deepEqual(result.failures, []);
    assert.match(await read("CLAUDE.md"), /harness:begin/);
    assert.ok(await exists(".claude/skills/harness-workflow/SKILL.md"));
  });

  it("the leina-managed gitignore block covers .harness/state/", () => {
    assert.ok(GITIGNORE_BODY.split("\n").includes(".harness/state/"));
  });
});

describe("deinitHarness (leina deinit inverse)", () => {
  it("(deinit-cfg-1) round-trips cleanly: artifacts, lockfile and the untouched init-written config go", async () => {
    await bootstrapHarness(repo.root, ["claude"]);
    const result = deinitHarness(repo.root);
    assert.deepEqual(result.failures, [], result.failures.join("; "));

    assert.equal(await exists("CLAUDE.md"), false, "file contained only the harness block");
    assert.equal(await exists(".harness/harness.lock.json"), false);
    assert.equal(await exists(".harness/config.json"), false, "init wrote it and nobody touched it since");
    assert.equal(await exists(".harness"), false, "empty .harness/ pruned");
    assert.ok(result.removed.some((r) => r.startsWith(".harness/config.json")));
  });

  it("(deinit-cfg-2) a config edited after init is the user's — kept", async () => {
    await bootstrapHarness(repo.root, ["claude"]);
    const edited = `${JSON.stringify({ platforms: ["claude-code"], strictness: "strict" }, null, 2)}\n`;
    await repo.write(".harness/config.json", edited);

    const result = deinitHarness(repo.root);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    assert.equal(await read(".harness/config.json"), edited);
  });

  it("(deinit-cfg-3) a re-init that merges hosts into its own config keeps it removable", async () => {
    await bootstrapHarness(repo.root, ["claude"]);
    await bootstrapHarness(repo.root, ["claude", "devin"]);
    assert.deepEqual(JSON.parse(await read(".harness/config.json")).platforms, ["claude-code", "windsurf"]);

    deinitHarness(repo.root);
    assert.equal(await exists(".harness/config.json"), false);
  });

  it("(deinit-cfg-4) a user-created config that init merged platforms into stays", async () => {
    await repo.write(".harness/config.json", JSON.stringify({ strictness: "strict" }));
    await bootstrapHarness(repo.root, ["claude"]);

    deinitHarness(repo.root);
    assert.ok(await exists(".harness/config.json"), "never init's file");
  });

  it("round-trips to nothing when the seed was the empty {} (no hosts)", async () => {
    await bootstrapHarness(repo.root);
    const result = deinitHarness(repo.root);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    assert.equal(await exists(".harness/config.json"), false, "pristine {} seed removed");
    assert.equal(await exists(".harness"), false, "empty .harness/ pruned");
  });

  it("re-init with different hosts UNION-merges config.platforms — the next sync keeps both", async () => {
    await repo.write(".harness/config.json", JSON.stringify({ platforms: ["cursor"] }, null, 2));
    await repo.write(".cursor/rules/.keep", "");
    const result = await bootstrapHarness(repo.root, ["claude"]);
    assert.deepEqual(result.failures, [], result.failures.join("; "));

    const config = JSON.parse(await read(".harness/config.json"));
    assert.deepEqual(config.platforms, ["cursor", "claude-code"], "union, user's entry first");
    assert.ok(await exists("CLAUDE.md"));
    assert.ok(await exists(".cursor/rules/harness-core.mdc"), "existing platform still synced");

    // The regression this guards: a plain follow-up sync must NOT orphan-remove
    // what init just wrote (init/sync ping-pong).
    const followUp = await runSync(repo.root, {});
    assert.equal(followUp.exitCode, 0);
    assert.ok(await exists("CLAUDE.md"), "claude artifacts survive the next sync");
    assert.ok(await exists(".cursor/rules/harness-core.mdc"));
  });

  it("(init-plat-1) init --hosts keeps the platforms a plain sync had auto-detected", async () => {
    await repo.write(".cursor/rules/.keep", "");
    await runSync(repo.root, {}); // auto-detect: cursor
    assert.ok(await exists(".cursor/rules/harness-core.mdc"));

    const result = await bootstrapHarness(repo.root, ["claude"]);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    const config = JSON.parse(await read(".harness/config.json"));
    assert.deepEqual(config.platforms, ["claude-code", "cursor"], "hosts first, then what was already synced");
    assert.ok(await exists(".cursor/rules/harness-core.mdc"), "cursor rules survive init");
    assert.match(await read(".cursor/hooks.json"), /harness hook cursor-stop/, "cursor hook wiring survives");
    assert.deepEqual(result.removed, []);
    assert.match(await read("CLAUDE.md"), /harness:begin/);
  });

  it("(init-plat-2) a config without platforms inherits lockfile + detected adapters, not just the hosts", async () => {
    await repo.write(".harness/config.json", JSON.stringify({ strictness: "strict" }));
    await repo.write(".cursor/rules/.keep", "");
    await runSync(repo.root, {});

    const result = await bootstrapHarness(repo.root, ["claude"]);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    const config = JSON.parse(await read(".harness/config.json"));
    assert.equal(config.strictness, "strict", "user keys kept");
    assert.deepEqual(config.platforms, ["claude-code", "cursor"]);
    assert.ok(await exists(".cursor/rules/harness-core.mdc"));
  });

  it("(init-plat-3) artifacts a bootstrap sync deletes are reported as removed, never as written", async () => {
    await repo.write(".harness/config.json", JSON.stringify({ platforms: ["cursor"] }));
    await repo.write(".cursor/hooks.json", JSON.stringify({ version: 1, hooks: { stop: [{ command: "my-hook" }] } }));
    await runSync(repo.root, {});
    assert.ok(await exists(".cursor/rules/harness-core.mdc"));
    // The user drops cursor from the declared platforms, then re-inits.
    await repo.write(".harness/config.json", JSON.stringify({ platforms: ["claude-code"] }));

    const result = await bootstrapHarness(repo.root, ["claude"]);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    assert.equal(await exists(".cursor/rules/harness-core.mdc"), false);
    assert.ok(result.removed.some((r) => r.includes(".cursor/rules/harness-core.mdc")), result.removed.join("; "));
    assert.ok(!result.written.some((w) => w.includes(".cursor/")), result.written.join("; "));
    // The orphaned json-merge wiring is stripped too — nothing untracked dangles.
    const hooks = await read(".cursor/hooks.json");
    assert.ok(!hooks.includes("harness hook"), hooks);
    assert.deepEqual(JSON.parse(hooks).hooks.stop, [{ command: "my-hook" }], "user hook kept");
    assert.ok(result.removed.some((r) => r.includes(".cursor/hooks.json")), result.removed.join("; "));
  });

  it("reports a host with no harness adapter instead of silently dropping it", async () => {
    const result = await bootstrapHarness(repo.root, ["claude", "no-such-host"]);
    assert.ok(result.failures.some((f) => f.includes('host "no-such-host"')));
    assert.match(await read("CLAUDE.md"), /harness:begin/, "mapped host still wired");
  });

  it("is idempotent: a second deinit is a silent no-op", async () => {
    await bootstrapHarness(repo.root, ["claude"]);
    deinitHarness(repo.root);
    const second = deinitHarness(repo.root);
    assert.deepEqual(second.removed, []);
    assert.deepEqual(second.failures, []);
  });

  it("preserves user content around the managed block", async () => {
    await repo.write("AGENTS.md", "# My project\n\nHand-written intro.\n");
    await bootstrapHarness(repo.root);
    assert.match(await read("AGENTS.md"), /harness:begin/);

    const result = deinitHarness(repo.root);
    assert.deepEqual(result.failures, []);
    const agents = await read("AGENTS.md");
    assert.match(agents, /Hand-written intro\./);
    assert.ok(!agents.includes("harness:begin"), "harness block stripped");
  });

  it("leaves user rules/state intact and keeps a configured config.json", async () => {
    await bootstrapHarness(repo.root);
    await repo.write(".harness/rules/mine.md", "user rule placeholder");
    await repo.write(".harness/state/current/plan.md", "my plan");
    await fs.writeFile(
      path.join(repo.root, ".harness", "config.json"),
      JSON.stringify({ strictness: "strict" }),
    );

    const result = deinitHarness(repo.root);
    assert.deepEqual(result.failures, []);
    assert.ok(await exists(".harness/rules/mine.md"));
    assert.ok(await exists(".harness/state/current/plan.md"));
    assert.ok(await exists(".harness/config.json"), "configured config is the user's");
  });

  it("strips harness entries from opencode.json but keeps the user's own", async () => {
    await repo.write("opencode.json", JSON.stringify({ instructions: ["docs/style.md"] }, null, 2));
    await runSync(repo.root, { platforms: ["opencode"] });
    assert.match(await read("opencode.json"), /\.harness\/generated\/opencode-rules\.md/);

    const result = deinitHarness(repo.root);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    const config = JSON.parse(await read("opencode.json"));
    assert.deepEqual(config.instructions, ["docs/style.md"], "user entry kept, harness entry gone");
    assert.equal(await exists(".harness/generated/opencode-rules.md"), false);
  });

  it("strips harness hook wiring from .cursor/hooks.json and keeps user hooks", async () => {
    await repo.write(
      ".cursor/hooks.json",
      JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "my-linter" }] } }, null, 2),
    );
    await runSync(repo.root, { platforms: ["cursor"] });
    assert.match(await read(".cursor/hooks.json"), /harness hook|leina/);

    const result = deinitHarness(repo.root);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    const hooks = JSON.parse(await read(".cursor/hooks.json"));
    assert.deepEqual(hooks.hooks.beforeShellExecution, [{ command: "my-linter" }]);
    const raw = await read(".cursor/hooks.json");
    assert.ok(!raw.includes("harness hook"), "no dangling harness commands");
  });

  it("(deinit-json-1) a tracked JSON file with no harness entries left is not rewritten", async () => {
    await repo.write(".cursor/rules/.keep", "");
    await runSync(repo.root, { platforms: ["cursor"] });
    // Another tool rewrote hooks.json since: minified, no version, no harness entries.
    const foreign = JSON.stringify({ hooks: { stop: [{ command: "my-hook" }] } });
    await repo.write(".cursor/hooks.json", foreign);

    const result = deinitHarness(repo.root);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    assert.equal(await read(".cursor/hooks.json"), foreign, "byte-identical — no version key, no reformat");
  });

  it("(deinit-json-2) stripping harness entries keeps the user's formatting and adds no version key", async () => {
    await repo.write(".cursor/rules/.keep", "");
    await runSync(repo.root, { platforms: ["cursor"] });
    const hooks = JSON.parse(await read(".cursor/hooks.json")) as { hooks: Record<string, unknown[]> };
    // The user's own style: 4-space indent, no version, no trailing newline.
    const userStyled = JSON.stringify({ hooks: { ...hooks.hooks, beforeReadFile: [{ command: "my-reader" }] } }, null, 4);
    await repo.write(".cursor/hooks.json", userStyled);

    deinitHarness(repo.root);
    assert.equal(
      await read(".cursor/hooks.json"),
      JSON.stringify({ hooks: { beforeReadFile: [{ command: "my-reader" }] } }, null, 4),
    );
  });

  it("(deinit-json-3) an opencode.json with no harness entries is left byte-identical", async () => {
    await repo.write("opencode.json", "{}\n");
    await runSync(repo.root, { platforms: ["opencode"] });
    const foreign = '{\n\t"theme": "dark",\n\t"instructions": ["docs/style.md"]\n}';
    await repo.write("opencode.json", foreign);

    deinitHarness(repo.root);
    assert.equal(await read("opencode.json"), foreign);
  });

  it(
    "(deinit-atomic-1) co-owned files are rewritten via temp file + rename, keeping their mode",
    { skip: process.platform === "win32" ? "inode/mode semantics differ on Windows" : false },
    async () => {
      await repo.write("AGENTS.md", "# Mine\n");
      await bootstrapHarness(repo.root);
      const agents = path.join(repo.root, "AGENTS.md");
      await fs.chmod(agents, 0o640);
      const before = await fs.stat(agents);

      deinitHarness(repo.root);
      const after = await fs.stat(agents);
      assert.notEqual(after.ino, before.ino, "replaced by rename, not rewritten in place");
      assert.equal(after.mode & 0o777, 0o640);
      assert.equal(await read("AGENTS.md"), "# Mine\n");
      assert.deepEqual((await fs.readdir(repo.root)).filter((n) => n.includes("harness-tmp")), []);
    },
  );

  it("removes a harness-born .cursor/hooks.json entirely (empty skeleton)", async () => {
    await repo.write(".cursor/rules/.keep", "");
    await runSync(repo.root, { platforms: ["cursor"] });
    assert.ok(await exists(".cursor/hooks.json"));

    const result = deinitHarness(repo.root);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    assert.equal(await exists(".cursor/hooks.json"), false, "held only harness entries");
  });

  it("refuses to strip a managed block whose interior was hand-edited", async () => {
    await repo.write("AGENTS.md", "# Mine\n");
    await bootstrapHarness(repo.root);
    const tampered = (await read("AGENTS.md")).replace("<!-- harness:end", "EDITED-INSIDE\n<!-- harness:end");
    await repo.write("AGENTS.md", tampered);

    const result = deinitHarness(repo.root);
    assert.ok(result.failures.some((f) => f.includes("AGENTS.md") && f.includes("hand-edited")));
    assert.ok((await read("AGENTS.md")).includes("EDITED-INSIDE"), "left in place");
  });

  it("never deletes a hand-edited owned artifact — reports it instead", async () => {
    await repo.write(".claude/settings.json", "{}\n");
    await bootstrapHarness(repo.root);
    const skillPath = ".claude/skills/harness-workflow/SKILL.md";
    await repo.write(skillPath, "hand-edited content\n");

    const result = deinitHarness(repo.root);
    assert.ok(await exists(skillPath), "hand-edited artifact left in place");
    assert.ok(result.failures.some((f) => f.includes(skillPath) && f.includes("hand-edited")));
  });

  it("no lockfile → nothing to revert", async () => {
    const result = deinitHarness(repo.root);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.failures, []);
  });
});

describe("deinitHarness — lockfile paths stay inside the repo", () => {
  let outside: string;

  beforeEach(async () => {
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "leina-harness-outside-"));
  });

  afterEach(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });

  async function hostileLock(artifactPath: string, content: string): Promise<void> {
    await repo.write(
      ".harness/harness.lock.json",
      JSON.stringify({
        version: 1,
        sourceHash: "f".repeat(64),
        artifacts: [{ path: artifactPath, adapter: "test", kind: "owned", contentHash: sha256(content) }],
      }),
    );
  }

  it("(deinit-path-1) a `..` artifact never deletes the outside file", async () => {
    const victim = path.join(outside, "victim.txt");
    await fs.writeFile(victim, "precious\n");
    await hostileLock(path.relative(repo.root, victim), "precious\n");

    deinitHarness(repo.root);
    assert.equal(await fs.readFile(victim, "utf8"), "precious\n");
  });

  it("(deinit-path-2) an artifact behind a symlinked parent dir is refused and reported", async () => {
    const victim = path.join(outside, "victim.txt");
    await fs.writeFile(victim, "precious\n");
    await fs.symlink(outside, path.join(repo.root, "link"), "junction");
    await hostileLock("link/victim.txt", "precious\n");

    const result = deinitHarness(repo.root);
    assert.equal(await fs.readFile(victim, "utf8"), "precious\n");
    assert.ok(result.failures.some((f) => f.includes("link/victim.txt") && f.includes("outside the repository")));
  });

  it("(deinit-path-3) a symlinked .harness/ is never written or pruned through", async () => {
    await fs.writeFile(path.join(outside, "config.json"), HARNESS_MINIMAL_CONFIG);
    await fs.symlink(outside, path.join(repo.root, ".harness"), "junction");

    deinitHarness(repo.root);
    assert.equal(await fs.readFile(path.join(outside, "config.json"), "utf8"), HARNESS_MINIMAL_CONFIG);
  });

  it("(deinit-path-4) bootstrap never seeds the config through a symlinked .harness/", async () => {
    await fs.symlink(outside, path.join(repo.root, ".harness"), "junction");

    const result = await bootstrapHarness(repo.root, ["claude"]);
    assert.deepEqual(await fs.readdir(outside), [], "nothing written through the link");
    assert.ok(result.failures.some((f) => f.includes(".harness/config.json") && f.includes("outside the repository")));
  });
});
