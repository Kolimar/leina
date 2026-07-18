// harness-install.test.ts — the `leina init` harness bootstrap writer
// (bootstrapHarness: .harness/config.json seed + in-process sync) and its
// per-repo inverse (deinitHarness): idempotency, clean round-trip, and the
// "user content is never touched" guarantees (rules/state/hand-edits).
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-install.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  bootstrapHarness,
  deinitHarness,
  HARNESS_MINIMAL_CONFIG,
} from "../src/application/install/harness-init.ts";
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
  it("seeds the minimal config and generates the sync artifacts", async () => {
    const result = await bootstrapHarness(repo.root);
    assert.deepEqual(result.failures, [], result.failures.join("; "));
    assert.ok(result.written.some((w) => w.includes(".harness/config.json")));
    assert.ok(result.written.some((w) => w.startsWith("harness sync:")));

    assert.equal(await read(".harness/config.json"), HARNESS_MINIMAL_CONFIG);
    assert.ok(await exists(".harness/harness.lock.json"));
    assert.match(await read("AGENTS.md"), /harness:begin/, "agentsmd baseline block");
  });

  it("is idempotent: a second run changes nothing and reports up-to-date", async () => {
    await bootstrapHarness(repo.root);
    const agentsBefore = await read("AGENTS.md");
    const lockBefore = await read(".harness/harness.lock.json");

    const second = await bootstrapHarness(repo.root);
    assert.deepEqual(second.failures, []);
    assert.ok(second.written.some((w) => w.includes("artifacts up to date")), second.written.join("; "));
    assert.ok(!second.written.some((w) => w.includes(".harness/config.json")), "config not re-reported");
    assert.equal(await read("AGENTS.md"), agentsBefore);
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
  it("round-trips cleanly: artifacts, lockfile and pristine config are removed", async () => {
    await bootstrapHarness(repo.root);
    const result = deinitHarness(repo.root);
    assert.deepEqual(result.failures, [], result.failures.join("; "));

    assert.equal(await exists("AGENTS.md"), false, "file contained only the harness block");
    assert.equal(await exists(".harness/harness.lock.json"), false);
    assert.equal(await exists(".harness/config.json"), false, "pristine {} config removed");
    assert.equal(await exists(".harness"), false, "empty .harness/ pruned");
  });

  it("is idempotent: a second deinit is a silent no-op", async () => {
    await bootstrapHarness(repo.root);
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
