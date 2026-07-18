// harness-adapters.test.ts — the pure half of the sync engine: managed blocks,
// JSON merges, instruction digest (leina rebranding), the five platform
// adapters' generate() output, auto-detection, and the bundle digest.
// Ported from the origin harness-framework's managed-block/json-merge/adapters
// test substance, adjusted to the etapa-2 design changes (claude-code installs
// no hooks; hook commands come from config.hookCommand).
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-adapters.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  type Recipe,
  type Rule,
  defaultHarnessConfig,
} from "../src/domain/harness/model.ts";
import {
  removeManagedBlock,
  upsertManagedBlock,
} from "../src/application/harness/adapters/managed-block.ts";
import {
  isHarnessHookCommand,
  mergeCursorHooks,
  mergeOpencodeInstructions,
} from "../src/application/harness/adapters/json-merge.ts";
import {
  COMPLETION_PROTOCOL,
  CONTRACT_TEMPLATE,
  renderInstructionBlock,
} from "../src/application/harness/adapters/digest.ts";
import { buildBundle } from "../src/application/harness/adapters/bundle.ts";
import { agentsmdAdapter } from "../src/application/harness/adapters/agentsmd.ts";
import { claudeCodeAdapter } from "../src/application/harness/adapters/claude-code.ts";
import { cursorAdapter } from "../src/application/harness/adapters/cursor.ts";
import {
  packWindsurfRules,
  windsurfAdapter,
  WINDSURF_CHAR_LIMIT,
} from "../src/application/harness/adapters/windsurf.ts";
import { opencodeAdapter } from "../src/application/harness/adapters/opencode.ts";
import {
  adapterById,
  allAdapters,
  detectAdapters,
  selectAdapters,
} from "../src/application/harness/adapters/registry.ts";
import { type RuleBundle } from "../src/application/harness/adapters/types.ts";
import {
  isolateLeinaHome,
  jsonFrontmatterDoc,
  makeTmpRepo,
  type TmpRepo,
} from "./helpers/harness-tmprepo.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    version: 1,
    phase: "verify",
    severity: "blocking",
    scope: {},
    enabled: true,
    tags: [],
    body: `# Rule ${partial.id}\n\nDo the thing.`,
    sourcePath: `/rules/${partial.id.replaceAll("/", "-")}.md`,
    layer: "builtin",
    ...partial,
  };
}

const RECIPE: Recipe = {
  name: "fix-bug",
  description: "Fix a reported bug with a regression test.",
  taskType: "bugfix",
  body: "# Recipe: fix a bug\n\n1. Reproduce first.",
  sourcePath: "/recipes/fix-bug.md",
};

function bundleWith(rules: Rule[], recipes: Recipe[] = []): RuleBundle {
  return { rules, recipes, config: defaultHarnessConfig(), digest: "0".repeat(64) };
}

const CTX = { repoRoot: "/nonexistent" };

// ---------------------------------------------------------------------------
// Managed blocks (marker format is the origin compatibility contract)
// ---------------------------------------------------------------------------

describe("managed blocks", () => {
  it("creates a block in an empty file with the origin marker format", () => {
    const r = upsertManagedBlock(undefined, "core", "agentsmd", "hello rules");
    assert.equal(r.action, "created");
    assert.match(r.content, /<!-- harness:begin id=core adapter=agentsmd v=1 hash=sha256:[0-9a-f]{64} -->/);
    assert.ok(r.content.includes("hello rules"));
    assert.ok(r.content.includes("<!-- harness:end id=core -->"));
  });

  it("appends to user content without touching it", () => {
    const user = "# My project\n\nHand-written notes.\n";
    const r = upsertManagedBlock(user, "core", "agentsmd", "rules here");
    assert.equal(r.action, "created");
    assert.ok(r.content.startsWith(user));
  });

  it("is idempotent — same body twice is a byte-identical no-op", () => {
    const first = upsertManagedBlock("# Title\n", "core", "agentsmd", "body v1");
    const second = upsertManagedBlock(first.content, "core", "agentsmd", "body v1");
    assert.equal(second.action, "unchanged");
    assert.equal(second.content, first.content);
  });

  it("updates the block when the body changes, preserving surroundings", () => {
    const first = upsertManagedBlock("# Before\n", "core", "agentsmd", "body v1");
    const withAfter = `${first.content}\n# After\n`;
    const second = upsertManagedBlock(withAfter, "core", "agentsmd", "body v2");
    assert.equal(second.action, "updated");
    assert.ok(second.content.includes("# Before"));
    assert.ok(second.content.includes("# After"));
    assert.ok(second.content.includes("body v2"));
    assert.ok(!second.content.includes("body v1"));
  });

  it("detects hand-edits inside the block and refuses to clobber", () => {
    const first = upsertManagedBlock(undefined, "core", "agentsmd", "body v1");
    const tampered = first.content.replace("body v1", "body v1 EDITED BY USER");
    const second = upsertManagedBlock(tampered, "core", "agentsmd", "body v2");
    assert.equal(second.action, "conflict");
    assert.equal(second.content, tampered);
    const forced = upsertManagedBlock(tampered, "core", "agentsmd", "body v2", { force: true });
    assert.equal(forced.action, "updated");
    assert.ok(forced.content.includes("body v2"));
  });

  it("supports multiple independent blocks in one file", () => {
    const a = upsertManagedBlock(undefined, "block-a", "x", "AAA");
    const both = upsertManagedBlock(a.content, "block-b", "x", "BBB");
    assert.equal(both.action, "created");
    const updatedA = upsertManagedBlock(both.content, "block-a", "x", "AAA v2");
    assert.equal(updatedA.action, "updated");
    assert.ok(updatedA.content.includes("AAA v2"));
    assert.ok(updatedA.content.includes("BBB"));
  });

  it("removes a block cleanly", () => {
    const created = upsertManagedBlock("# Keep me\n", "core", "x", "ephemeral");
    const removed = removeManagedBlock(created.content, "core");
    assert.equal(removed.removed, true);
    assert.ok(removed.content.includes("# Keep me"));
    assert.ok(!removed.content.includes("ephemeral"));
    assert.ok(!removed.content.includes("harness:begin"));
  });

  it("coexists with leina's protocol block markers in the same file", () => {
    const leinaBlock = "<!-- leina:protocol:start -->\n# Leina protocol\n<!-- leina:protocol:end -->\n";
    const withHarness = upsertManagedBlock(leinaBlock, "harness-core", "agentsmd", "harness body");
    assert.equal(withHarness.action, "created");
    const updated = upsertManagedBlock(withHarness.content, "harness-core", "agentsmd", "harness body v2");
    assert.equal(updated.action, "updated");
    assert.ok(updated.content.includes("<!-- leina:protocol:start -->"));
    assert.ok(updated.content.includes("# Leina protocol"));
    assert.ok(updated.content.includes("<!-- leina:protocol:end -->"));
    assert.ok(updated.content.includes("harness body v2"));
  });
});

// ---------------------------------------------------------------------------
// JSON merges
// ---------------------------------------------------------------------------

describe("isHarnessHookCommand", () => {
  it("matches the default leina hook command and event-form overrides", () => {
    assert.ok(isHarnessHookCommand("leina harness hook cursor-stop"));
    assert.ok(isHarnessHookCommand("npx harness hook stop"));
    assert.ok(isHarnessHookCommand("node dist/cli/index.js hook pre-bash"));
    assert.ok(!isHarnessHookCommand("my-own-linter --fix"));
  });
});

describe("mergeCursorHooks", () => {
  const DESIRED = {
    beforeShellExecution: ["leina harness hook cursor-shell"],
    stop: ["leina harness hook cursor-stop"],
  };

  it("creates hooks.json from scratch with version 1", () => {
    const r = mergeCursorHooks(undefined, DESIRED);
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.hooks.beforeShellExecution, [{ command: "leina harness hook cursor-shell" }]);
  });

  it("preserves user hooks and is idempotent with stale-entry cleanup", () => {
    const existing = JSON.stringify({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: "my-own-guard" }, { command: "npx harness hook cursor-shell" }],
      },
    });
    const r = mergeCursorHooks(existing, DESIRED);
    const parsed = JSON.parse(r.content);
    const commands = parsed.hooks.beforeShellExecution.map((e: { command: string }) => e.command);
    assert.deepEqual(commands, ["my-own-guard", "leina harness hook cursor-shell"]);

    const again = mergeCursorHooks(r.content, DESIRED);
    assert.equal(again.changed, false);

    // Drop the stop hook from the desired set — it must disappear.
    const cleaned = mergeCursorHooks(r.content, { beforeShellExecution: DESIRED.beforeShellExecution });
    assert.equal(JSON.parse(cleaned.content).hooks.stop, undefined);
  });

  it("refuses to touch invalid JSON", () => {
    const r = mergeCursorHooks("{not json", DESIRED);
    assert.ok(r.error);
    assert.equal(r.content, "{not json");
  });
});

describe("mergeOpencodeInstructions", () => {
  it("creates opencode.json with the $schema and the rules file", () => {
    const r = mergeOpencodeInstructions(undefined, ".harness/generated/opencode-rules.md");
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(parsed.instructions, [".harness/generated/opencode-rules.md"]);
  });

  it("preserves user settings/instructions and strips stale harness entries", () => {
    const existing = JSON.stringify({
      theme: "dark",
      instructions: ["docs/my-notes.md", ".harness/generated/old-rules.md"],
    });
    const r = mergeOpencodeInstructions(existing, ".harness/generated/opencode-rules.md");
    const parsed = JSON.parse(r.content);
    assert.equal(parsed.theme, "dark");
    assert.deepEqual(parsed.instructions, ["docs/my-notes.md", ".harness/generated/opencode-rules.md"]);

    const again = mergeOpencodeInstructions(r.content, ".harness/generated/opencode-rules.md");
    assert.equal(again.changed, false);
  });

  it("refuses to touch a non-object root", () => {
    const r = mergeOpencodeInstructions("[1,2]", "x.md");
    assert.ok(r.error);
    assert.equal(r.content, "[1,2]");
  });
});

// ---------------------------------------------------------------------------
// Instruction digest — full leina rebranding
// ---------------------------------------------------------------------------

describe("instruction digest", () => {
  it("rebrands every command surface to `leina harness …`", () => {
    const block = renderInstructionBlock(
      bundleWith([rule({ id: "harness/tests-pass", summary: "Tests must pass." })]),
      { includeContractTemplate: true },
    );
    assert.ok(block.includes("leina harness verify"));
    assert.ok(block.includes("leina harness contract new"));
    assert.ok(block.includes("leina harness sync"));
    assert.ok(block.includes("leina harness list"));
    assert.ok(!block.includes("npx harness"), "no `npx harness` may survive the rebranding");
    assert.ok(!COMPLETION_PROTOCOL.includes("npx"), "completion protocol is fully rebranded");
    assert.ok(!CONTRACT_TEMPLATE.includes("npx"), "contract template is fully rebranded");
  });

  it("groups rules by phase, blocking first, with gate enforcement annotations", () => {
    const block = renderInstructionBlock(
      bundleWith([
        rule({
          id: "harness/tests-pass",
          summary: "Tests pass.",
          gate: { type: "command", run: "npm test", expectExitCode: 0 },
        }),
        rule({ id: "harness/a-advisory", severity: "advisory", summary: "Advisory rule." }),
        rule({ id: "harness/plan", phase: "plan", summary: "Plan first." }),
      ]),
      { includeContractTemplate: false },
    );
    assert.ok(block.includes("### Before the task (plan)"));
    assert.ok(block.includes("### Before claiming completion (verify)"));
    assert.ok(block.includes("- **harness/tests-pass** [blocking] (enforced: command): Tests pass."));
    const blockingIdx = block.indexOf("harness/tests-pass");
    const advisoryIdx = block.indexOf("harness/a-advisory");
    assert.ok(blockingIdx < advisoryIdx, "blocking rules sort before advisory");
    assert.ok(!block.includes("Task contract template"));
  });
});

// ---------------------------------------------------------------------------
// Adapters — generate() output
// ---------------------------------------------------------------------------

describe("agentsmd adapter", () => {
  it("emits a single managed block for AGENTS.md with the contract template inline", async () => {
    const fs = await agentsmdAdapter.generate(bundleWith([rule({ id: "harness/tests-pass" })]), CTX);
    assert.equal(fs.files.length, 1);
    const file = fs.files[0]!;
    assert.equal(file.path, "AGENTS.md");
    assert.equal(file.kind, "managed-block");
    assert.equal(file.blockId, "harness-core");
    assert.ok(file.content.includes("Task contract template"));
  });

  it("detects only repos that already carry an AGENTS.md (vendor-neutral)", async () => {
    assert.equal(await agentsmdAdapter.detect(CTX), false);
  });
});

describe("claude-code adapter", () => {
  it("generates CLAUDE.md block + skills and does NOT touch .claude/settings.json", async () => {
    const fs = await claudeCodeAdapter.generate(bundleWith([rule({ id: "harness/tests-pass" })], [RECIPE]), CTX);
    const paths = fs.files.map((f) => f.path);
    assert.deepEqual(paths, [
      "CLAUDE.md",
      ".claude/skills/harness-workflow/SKILL.md",
      ".claude/skills/harness-recipe-fix-bug/SKILL.md",
    ]);
    assert.ok(
      !paths.includes(".claude/settings.json"),
      "design change: hooks ride leina's agent-gate, not settings.json",
    );
    assert.ok(fs.files.every((f) => f.kind !== "json-merge"), "no json-merge artifacts at all");

    const claudeMd = fs.files[0]!;
    assert.equal(claudeMd.kind, "managed-block");
    assert.equal(claudeMd.blockId, "harness-core");
    assert.ok(claudeMd.content.includes("The `harness-workflow` skill describes the full task procedure."));
    assert.ok(!claudeMd.content.includes("Task contract template"), "compact digest only");

    const skill = fs.files[1]!;
    assert.equal(skill.kind, "owned");
    assert.ok(skill.content.includes("name: harness-workflow"));
    assert.ok(skill.content.includes("leina harness contract new"));
    assert.ok(skill.content.includes("leina harness verify"));
    assert.ok(!skill.content.includes("npx harness"));

    const recipeSkill = fs.files[2]!;
    assert.equal(recipeSkill.kind, "owned");
    assert.ok(recipeSkill.content.includes("name: harness-recipe-fix-bug"));
    assert.ok(recipeSkill.content.includes("(task type: bugfix)"));
    assert.ok(recipeSkill.content.includes("# Recipe: fix a bug"));
  });
});

describe("cursor adapter", () => {
  it("generates the always-apply core, per-rule .mdc files, and hookCommand-wired hooks.json", async () => {
    const bundle = bundleWith([
      rule({ id: "harness/tests-pass", summary: "Tests.", scope: { paths: ["src/**", "test/**"] } }),
    ]);
    bundle.config.hookCommand = "node dist/cli/index.js harness hook";
    const fs = await cursorAdapter.generate(bundle, CTX);
    const byPath = new Map(fs.files.map((f) => [f.path, f]));

    const core = byPath.get(".cursor/rules/harness-core.mdc")!;
    assert.equal(core.kind, "owned");
    assert.ok(core.content.includes("alwaysApply: true"));
    assert.ok(core.content.includes("leina harness verify"));
    assert.ok(!core.content.includes("npx harness"));

    const mdc = byPath.get(".cursor/rules/harness-harness-tests-pass.mdc")!;
    assert.ok(mdc.content.includes("alwaysApply: false"));
    assert.ok(mdc.content.includes("globs: src/**,test/**"));
    assert.ok(mdc.content.includes("_Severity: blocking._"));

    const hooks = byPath.get(".cursor/hooks.json")!;
    assert.equal(hooks.kind, "json-merge");
    assert.equal(hooks.mergeStrategy, "cursor-hooks");
    assert.deepEqual(JSON.parse(hooks.content), {
      beforeShellExecution: ["node dist/cli/index.js harness hook cursor-shell"],
      afterFileEdit: ["node dist/cli/index.js harness hook cursor-after-edit"],
      stop: ["node dist/cli/index.js harness hook cursor-stop"],
    });
  });
});

describe("windsurf adapter", () => {
  it("writes .devin/rules and a byte-identical .windsurf mirror", async () => {
    const fs = await windsurfAdapter.generate(bundleWith([rule({ id: "harness/tests-pass" })]), CTX);
    const paths = fs.files.map((f) => f.path);
    assert.deepEqual(paths, [".devin/rules/harness-core.md", ".windsurf/rules/harness-core.md"]);
    assert.equal(fs.files[0]!.content, fs.files[1]!.content);
    assert.ok(fs.files[0]!.content.includes("trigger: always_on"));
    assert.ok(fs.files[0]!.content.includes("leina harness verify"));
    assert.deepEqual(fs.warnings, []);
  });

  it("packs by priority and truncates to summaries beyond the 12k limit", () => {
    const big = "x".repeat(4_000);
    const rules = [
      rule({ id: "harness/a-big", body: big, summary: "A." }),
      rule({ id: "harness/b-big", body: big, summary: "B." }),
      rule({ id: "harness/c-big", body: big, summary: "C." }),
      rule({ id: "harness/d-advisory", severity: "advisory", body: big, summary: "D summary." }),
    ];
    const { content, truncated } = packWindsurfRules(rules);
    assert.ok(content.length <= WINDSURF_CHAR_LIMIT, `packed ${content.length} > ${WINDSURF_CHAR_LIMIT}`);
    assert.ok(truncated.includes("harness/d-advisory"), "advisory rule loses its full body first");
    assert.ok(content.includes("**harness/d-advisory** [verify/advisory]: D summary."));
  });
});

describe("opencode adapter", () => {
  it("generates rules file, instructions merge, and a plugin dispatching to hookCommand", async () => {
    const fs = await opencodeAdapter.generate(bundleWith([rule({ id: "harness/tests-pass" })]), CTX);
    const byPath = new Map(fs.files.map((f) => [f.path, f]));

    const rules = byPath.get(".harness/generated/opencode-rules.md")!;
    assert.equal(rules.kind, "owned");
    assert.ok(rules.content.includes("Completion protocol"));
    assert.ok(!rules.content.includes("npx harness"));

    const config = byPath.get("opencode.json")!;
    assert.equal(config.kind, "json-merge");
    assert.equal(config.mergeStrategy, "opencode-instructions");
    assert.equal(config.content, ".harness/generated/opencode-rules.md");

    const plugin = byPath.get(".opencode/plugin/harness.js")!;
    assert.equal(plugin.kind, "owned");
    assert.ok(plugin.content.includes('await import("node:child_process")'));
    assert.ok(plugin.content.includes('execFileSync("leina", [...["harness","hook"], event]'));
    assert.ok(plugin.content.includes('"tool.execute.before"'));
  });
});

// ---------------------------------------------------------------------------
// Registry + auto-detection
// ---------------------------------------------------------------------------

describe("registry", () => {
  let repo: TmpRepo;

  beforeEach(async () => {
    repo = await makeTmpRepo(false);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("exposes the five adapters by id", () => {
    assert.deepEqual(
      allAdapters().map((a) => a.id),
      ["agentsmd", "claude-code", "cursor", "windsurf", "opencode"],
    );
    assert.equal(adapterById("cursor")?.displayName, "Cursor");
    assert.equal(adapterById("nope"), undefined);
  });

  it("detects nothing in an empty repo (no platform is ever auto-elected)", async () => {
    const detected = await detectAdapters({ repoRoot: repo.root });
    assert.deepEqual(detected.map((a) => a.id), []);
  });

  it("detects each platform from its filesystem evidence", async () => {
    await repo.write("AGENTS.md", "# notes\n");
    await repo.write("CLAUDE.md", "# notes\n");
    await repo.write(".cursor/rules/.keep", "");
    await repo.write(".devin/rules/.keep", "");
    await repo.write("opencode.json", "{}\n");
    const detected = await detectAdapters({ repoRoot: repo.root });
    assert.deepEqual(
      detected.map((a) => a.id),
      ["agentsmd", "claude-code", "cursor", "windsurf", "opencode"],
    );
  });

  it("selectAdapters honors config.platforms and warns on unknown ids", async () => {
    const config = { ...defaultHarnessConfig(), platforms: ["cursor", "no-such-platform"] };
    const { adapters, warnings } = await selectAdapters(config, { repoRoot: repo.root });
    assert.deepEqual(adapters.map((a) => a.id), ["cursor"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /no-such-platform/);
  });
});

// ---------------------------------------------------------------------------
// Bundle digest
// ---------------------------------------------------------------------------

describe("buildBundle", () => {
  let repo: TmpRepo;
  let restoreHome: () => void;

  beforeEach(async () => {
    repo = await makeTmpRepo(false);
    restoreHome = isolateLeinaHome(path.join(repo.root, "leina-home"));
  });

  afterEach(async () => {
    restoreHome();
    await repo.cleanup();
  });

  it("produces a stable digest for identical inputs", async () => {
    const first = await buildBundle(repo.root);
    const second = await buildBundle(repo.root);
    assert.deepEqual(first.errors, []);
    assert.equal(first.bundle.digest, second.bundle.digest);
    assert.match(first.bundle.digest, /^[0-9a-f]{64}$/);
    assert.ok(first.bundle.rules.some((r) => r.id === "harness/tests-pass"), "builtin rules load");
    assert.ok(first.bundle.recipes.some((r) => r.name === "fix-bug"), "builtin recipes load");
  });

  it("changes the digest when a project rule is added and excludes disabled rules", async () => {
    const before = await buildBundle(repo.root);
    await repo.write(
      ".harness/rules/extra.md",
      jsonFrontmatterDoc({ id: "project/extra", phase: "verify", severity: "advisory" }, "# Extra"),
    );
    const after = await buildBundle(repo.root);
    assert.notEqual(before.bundle.digest, after.bundle.digest);
    assert.ok(after.bundle.rules.every((r) => r.enabled), "bundle carries enabled rules only");
  });
});
