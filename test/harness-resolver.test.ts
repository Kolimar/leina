// harness-resolver.test.ts — layered rule loading (builtin < project < user)
// and the enforceability invariant: user-local layers cannot weaken a
// project/builtin blocking rule. Fixtures are built in fresh tmpdirs; the
// user layer is isolated via $LEINA_HOME.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-resolver.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadResolvedRules, filterRules, rulesMissingGates } from "../src/application/harness/resolver.ts";
import { loadConfig } from "../src/application/harness/config-io.ts";
import { builtinRulesDir } from "../src/application/harness/loader.ts";
import type { Rule } from "../src/domain/harness/model.ts";
import {
  isolateLeinaHome,
  jsonFrontmatterDoc,
  makeTmpRepo,
  type TmpRepo,
} from "./helpers/harness-tmprepo.ts";

let repo: TmpRepo;
let restoreHome: () => void;

beforeEach(async () => {
  repo = await makeTmpRepo(false);
  // Point the user layer inside the tmp repo so the developer's real
  // ~/.leina/harness rules cannot leak in.
  restoreHome = isolateLeinaHome(path.join(repo.root, "leina-home"));
});

afterEach(async () => {
  restoreHome();
  await repo.cleanup();
});

const PROJECT_RULE = jsonFrontmatterDoc(
  {
    id: "project/no-console-log",
    phase: "verify",
    severity: "blocking",
    gate: { type: "diff-content", forbidAdded: "console\\.log" },
  },
  "# No console.log",
);

describe("loadResolvedRules", () => {
  it("loads builtin, project and user rules", async () => {
    await repo.write(".harness/rules/no-console-log.md", PROJECT_RULE);
    await repo.write(
      "leina-home/harness/rules/prefer-tabs.md",
      jsonFrontmatterDoc({ id: "user/prefer-tabs", phase: "execute", severity: "advisory" }, "# Tabs"),
    );

    const res = await loadResolvedRules(repo.root);
    const ids = res.rules.map((r) => r.id);
    assert.ok(ids.includes("harness/tests-pass"), "builtin layer (assets/harness/rules)");
    assert.ok(ids.includes("project/no-console-log"), "project layer");
    assert.ok(ids.includes("user/prefer-tabs"), "user layer addition");
    assert.deepEqual(res.errors, []);
  });

  it("applies project config overrides to builtin rules", async () => {
    await repo.write(
      ".harness/config.json",
      JSON.stringify({ rules: { "harness/lint-clean": { severity: "blocking" } } }),
    );
    const res = await loadResolvedRules(repo.root);
    const lint = res.rules.find((r) => r.id === "harness/lint-clean");
    assert.equal(lint?.severity, "blocking");
  });

  it("ignores a user rule file that weakens a project blocking rule", async () => {
    await repo.write(".harness/rules/no-console-log.md", PROJECT_RULE);
    await repo.write(
      "leina-home/harness/rules/weaken-attempt.md",
      jsonFrontmatterDoc(
        { id: "project/no-console-log", phase: "verify", severity: "advisory" },
        "# Downgrade attempt",
      ),
    );

    const res = await loadResolvedRules(repo.root);
    const rule = res.rules.find((r) => r.id === "project/no-console-log");
    assert.equal(rule?.severity, "blocking");
    assert.equal(rule?.layer, "project");
    assert.ok(res.warnings.some((w) => w.includes("weaken")));
  });

  it("a user rule file may replace a non-blocking project rule", async () => {
    await repo.write(
      ".harness/rules/advisory.md",
      jsonFrontmatterDoc({ id: "project/style", phase: "execute", severity: "advisory" }, "# v1"),
    );
    await repo.write(
      "leina-home/harness/rules/advisory.md",
      jsonFrontmatterDoc({ id: "project/style", phase: "execute", severity: "advisory", version: 2 }, "# v2"),
    );
    const res = await loadResolvedRules(repo.root);
    const rule = res.rules.find((r) => r.id === "project/style");
    assert.equal(rule?.layer, "user");
    assert.equal(rule?.version, 2);
  });

  it("reports duplicate rule ids within one layer", async () => {
    await repo.write(".harness/rules/a.md", PROJECT_RULE);
    await repo.write(".harness/rules/b.md", PROJECT_RULE);
    const res = await loadResolvedRules(repo.root);
    assert.ok(res.errors.some((e) => e.includes('duplicate rule id "project/no-console-log"')));
  });

  it("reports invalid rule files as errors", async () => {
    await repo.write(
      ".harness/rules/bad.md",
      jsonFrontmatterDoc({ id: "nonamespace" }, "# Broken"),
    );
    const res = await loadResolvedRules(repo.root);
    assert.ok(res.errors.some((e) => e.includes("bad.md")));
  });
});

describe("enforceability invariant across layers", () => {
  it("config.local.json cannot disable a builtin blocking rule", async () => {
    await repo.write(
      ".harness/config.local.json",
      JSON.stringify({ rules: { "harness/tests-pass": { enabled: false } } }),
    );
    const res = await loadResolvedRules(repo.root);
    const rule = res.rules.find((r) => r.id === "harness/tests-pass");
    assert.equal(rule?.enabled, true);
    assert.ok(res.warnings.some((w) => w.includes("harness/tests-pass")));
  });

  it("project config.json CAN disable a builtin blocking rule", async () => {
    await repo.write(
      ".harness/config.json",
      JSON.stringify({ rules: { "harness/tests-pass": { enabled: false } } }),
    );
    const res = await loadResolvedRules(repo.root);
    const rule = res.rules.find((r) => r.id === "harness/tests-pass");
    assert.equal(rule?.enabled, false);
    assert.deepEqual(res.warnings, []);
  });

  // A config `gate` would keep the rule's original (trusted) layer while the
  // command comes from the repo — gates are declared in rule files only.
  for (const file of [".harness/config.json", ".harness/config.local.json", "leina-home/harness/config.json"]) {
    it(`(resolver-gate-1) ${file} cannot override a rule's gate — reported, never applied`, async () => {
      await repo.write(
        file,
        JSON.stringify({
          rules: { "harness/tests-pass": { gate: { type: "command", run: "touch pwned.txt" } } },
        }),
      );
      const res = await loadResolvedRules(repo.root);
      assert.ok(
        res.errors.some((e) => e.includes("rules.harness/tests-pass.gate") && e.includes("rule files")),
        JSON.stringify(res.errors),
      );
      const rule = res.rules.find((r) => r.id === "harness/tests-pass");
      assert.equal((rule?.gate as { run?: string }).run, "npm test");
    });
  }

  // A user rule file restating a builtin blocking rule. `over` is merged on top
  // of the shipped frontmatter of harness/tests-pass.
  const userTestsPass = (over: Record<string, unknown>): string =>
    jsonFrontmatterDoc(
      {
        id: "harness/tests-pass",
        phase: "verify",
        severity: "blocking",
        gate: { type: "command", run: "npm test", expectExitCode: 0 },
        ...over,
      },
      "# User restatement",
    );

  const builtinTestsPassGate = async (): Promise<unknown> =>
    (await loadResolvedRules(repo.root)).rules.find((r) => r.id === "harness/tests-pass" && r.layer === "builtin")
      ?.gate;

  for (const [what, over] of [
    ["downgrade to advisory", { severity: "advisory" }],
    ["disable", { enabled: false }],
    ["gate change", { gate: { type: "command", run: "true", expectExitCode: 0 } }],
    ["phase change", { phase: "deliver" }],
    ["scope change", { scope: { paths: ["nothing/**"] } }],
  ] as const) {
    it(`(inv-1) user rule file vs a BUILTIN blocking rule — ${what}: ignored with a warning`, async () => {
      const shipped = await builtinTestsPassGate();
      await repo.write("leina-home/harness/rules/tests-pass.md", userTestsPass(over));
      const res = await loadResolvedRules(repo.root);
      const rule = res.rules.find((r) => r.id === "harness/tests-pass");
      assert.equal(rule?.layer, "builtin", what);
      assert.deepEqual(rule?.gate, shipped, what);
      assert.ok(res.warnings.some((w) => w.includes("harness/tests-pass") && w.includes("weaken")), what);
    });
  }

  it("(inv-2) a user rule file may restate a blocking rule without weakening it (same gate/phase/scope)", async () => {
    const shipped = await builtinTestsPassGate();
    await repo.write(
      "leina-home/harness/rules/tests-pass.md",
      jsonFrontmatterDoc(
        { id: "harness/tests-pass", phase: "verify", severity: "blocking", gate: shipped, tags: ["mine"] },
        "# Same wall, my words",
      ),
    );
    const res = await loadResolvedRules(repo.root);
    const rule = res.rules.find((r) => r.id === "harness/tests-pass");
    assert.equal(rule?.layer, "user");
    assert.deepEqual(rule?.tags, ["mine"]);
    assert.deepEqual(res.warnings, []);
  });

  it("(inv-3) config.local cannot demote a rule the PROJECT config promoted to blocking", async () => {
    await repo.write(
      ".harness/config.json",
      JSON.stringify({ rules: { "harness/lint-clean": { severity: "blocking" } } }),
    );
    await repo.write(
      ".harness/config.local.json",
      JSON.stringify({ rules: { "harness/lint-clean": { severity: "advisory" } } }),
    );
    const res = await loadResolvedRules(repo.root);
    const rule = res.rules.find((r) => r.id === "harness/lint-clean");
    assert.equal(rule?.severity, "blocking");
    assert.ok(res.warnings.some((w) => w.includes("harness/lint-clean")));
  });

  it("(inv-4) a rejected local override keeps the project config's own fields", async () => {
    await repo.write(
      ".harness/config.json",
      JSON.stringify({ rules: { "harness/lint-clean": { severity: "blocking" } } }),
    );
    await repo.write(
      ".harness/config.local.json",
      JSON.stringify({ rules: { "harness/lint-clean": { enabled: false } } }),
    );
    const res = await loadResolvedRules(repo.root);
    const rule = res.rules.find((r) => r.id === "harness/lint-clean");
    assert.equal(rule?.severity, "blocking", "project promotion survives");
    assert.equal(rule?.enabled, true);
  });

  it("(inv-5) a user rule file cannot weaken a rule the project config promoted to blocking", async () => {
    await repo.write(
      ".harness/config.json",
      JSON.stringify({ rules: { "harness/lint-clean": { severity: "blocking" } } }),
    );
    await repo.write(
      "leina-home/harness/rules/lint-clean.md",
      jsonFrontmatterDoc(
        { id: "harness/lint-clean", phase: "verify", severity: "advisory", gate: { type: "command", run: "true", expectExitCode: 0 } },
        "# Swap the gate",
      ),
    );
    const res = await loadResolvedRules(repo.root);
    const rule = res.rules.find((r) => r.id === "harness/lint-clean");
    assert.equal(rule?.layer, "builtin");
    assert.notEqual((rule?.gate as { run?: string }).run, "true");
    assert.ok(res.warnings.some((w) => w.includes("harness/lint-clean")));
  });

  it("(inv-6) a project config field beats the user config without a spurious warning", async () => {
    await repo.write(
      "leina-home/harness/config.json",
      JSON.stringify({ rules: { "harness/tests-pass": { enabled: false } } }),
    );
    await repo.write(
      ".harness/config.json",
      JSON.stringify({ rules: { "harness/tests-pass": { enabled: true } } }),
    );
    const res = await loadResolvedRules(repo.root);
    assert.equal(res.rules.find((r) => r.id === "harness/tests-pass")?.enabled, true);
    assert.deepEqual(res.warnings, []);
  });

  it("(inv-7) local layers may still disable the user's OWN additions", async () => {
    await repo.write(
      "leina-home/harness/rules/mine.md",
      jsonFrontmatterDoc(
        { id: "user/mine", phase: "verify", severity: "blocking", gate: { type: "file", path: "x", exists: true } },
        "# Mine",
      ),
    );
    await repo.write(".harness/config.local.json", JSON.stringify({ rules: { "user/mine": { enabled: false } } }));
    const res = await loadResolvedRules(repo.root);
    assert.equal(res.rules.find((r) => r.id === "user/mine")?.enabled, false);
    assert.deepEqual(res.warnings, []);
  });

  it("user-layer config.json is treated as local (cannot weaken)", async () => {
    await repo.write(
      "leina-home/harness/config.json",
      JSON.stringify({ rules: { "harness/no-secrets": { enabled: false } } }),
    );
    const res = await loadResolvedRules(repo.root);
    const rule = res.rules.find((r) => r.id === "harness/no-secrets");
    assert.equal(rule?.enabled, true);
    assert.ok(res.warnings.some((w) => w.includes("harness/no-secrets")));
  });
});

describe("loadConfig layering", () => {
  it("merges config layers with local field-level rule merge", async () => {
    await repo.write(
      ".harness/config.json",
      JSON.stringify({
        defaultBranch: "trunk",
        rules: { "project/x": { severity: "blocking" } },
      }),
    );
    await repo.write(
      ".harness/config.local.json",
      JSON.stringify({ rules: { "project/x": { enabled: true } } }),
    );
    const loaded = await loadConfig(repo.root);
    assert.equal(loaded.config.defaultBranch, "trunk");
    // Field-level merge: the local `enabled` does not wipe the project severity.
    assert.equal(loaded.config.rules["project/x"]?.severity, "blocking");
    assert.equal(loaded.config.rules["project/x"]?.enabled, true);
    // Only `enabled` came from a local layer.
    assert.deepEqual(Object.keys(loaded.localRuleOverrides["project/x"] ?? {}), ["enabled"]);
  });

  it("reports malformed JSON without crashing", async () => {
    await repo.write(".harness/config.json", "{ nope");
    const loaded = await loadConfig(repo.root);
    assert.ok(loaded.errors.some((e) => e.includes("invalid JSON")));
    assert.equal(loaded.config.defaultBranch, "main");
  });
});

describe("filterRules", () => {
  const mk = (over: Partial<Rule>): Rule => ({
    id: "project/x",
    version: 1,
    phase: "verify",
    severity: "blocking",
    scope: {},
    enabled: true,
    tags: [],
    body: "",
    sourcePath: "/x.md",
    layer: "project",
    ...over,
  });

  it("filters by phase", () => {
    const rules = [mk({ id: "project/a", phase: "plan" }), mk({ id: "project/b", phase: "verify" })];
    assert.deepEqual(filterRules(rules, { phases: ["verify"] }).map((r) => r.id), ["project/b"]);
  });

  it("drops disabled rules", () => {
    assert.deepEqual(filterRules([mk({ enabled: false })]), []);
  });

  it("filters by scope paths against changed files", () => {
    const rules = [mk({ scope: { paths: ["src/**"] } })];
    assert.deepEqual(filterRules(rules, { changedFiles: ["docs/readme.md"] }), []);
    assert.equal(filterRules(rules, { changedFiles: ["src/a.ts"] }).length, 1);
  });

  it("filters by task type only when the rule declares taskTypes", () => {
    const scoped = mk({ scope: { taskTypes: ["feature"] } });
    const open = mk({ id: "project/open" });
    assert.deepEqual(filterRules([scoped, open], { taskType: "docs" }).map((r) => r.id), ["project/open"]);
    assert.equal(filterRules([scoped, open], { taskType: "feature" }).length, 2);
  });

  it("applies taskTypes-scoped rules when the contract declared no type (fail-closed)", () => {
    const scoped = mk({ scope: { taskTypes: ["feature"] } });
    assert.equal(filterRules([scoped], {}).length, 1);
  });

  it("filters by scope languages against changed-file extensions", () => {
    const rules = [mk({ scope: { languages: ["typescript"] } })];
    assert.equal(filterRules(rules, { changedFiles: ["src/a.ts"] }).length, 1);
    assert.equal(filterRules(rules, { changedFiles: ["src/a.tsx", "README.md"] }).length, 1);
    assert.deepEqual(filterRules(rules, { changedFiles: ["src/a.py", "README.md"] }), []);
    // Bare entries match as extensions; without changedFiles the rule applies.
    assert.equal(filterRules([mk({ scope: { languages: ["rs"] } })], { changedFiles: ["lib.rs"] }).length, 1);
    assert.equal(filterRules(rules, {}).length, 1);
  });

  it("flags blocking verify rules without gates", () => {
    const missing = mk({ id: "project/gateless" });
    const ok = mk({ id: "project/gated", gate: { type: "command", run: "true", expectExitCode: 0 } });
    assert.deepEqual(rulesMissingGates([missing, ok]).map((r) => r.id), ["project/gateless"]);
  });
});

describe("builtin rules dir", () => {
  it("resolves to the bundled assets and parses every shipped rule", async () => {
    assert.ok(builtinRulesDir().endsWith(`assets${path.sep}harness${path.sep}rules${path.sep}`));
    const res = await loadResolvedRules(repo.root);
    // Every bundled rule must parse with the hand-rolled validators.
    assert.deepEqual(res.errors, []);
    assert.ok(res.rules.filter((r) => r.layer === "builtin").length >= 10);
  });
});
