// harness-verify.test.ts — end-to-end runVerify over throwaway git repos:
// exit-code contract (0/1/2), report persistence, contract-scope enforcement
// through the builtin harness/diff-in-scope gate, and task-type filtering.
// Uses the real infrastructure ports; noisy builtin command/js gates are
// disabled via the fixture's .harness/config.json (npm/leina are not
// available inside the fixture repos).
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-verify.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runVerify } from "../src/application/harness/verify.ts";
import { saveContract } from "../src/application/harness/contract-io.ts";
import { loadRecipes } from "../src/application/harness/recipes.ts";
import { trustWorkspace } from "../src/application/install/trust.ts";
import { ShellProcessRunner } from "../src/infrastructure/harness/exec.ts";
import { HarnessGit } from "../src/infrastructure/harness/git.ts";
import {
  isolateLeinaHome,
  jsonFrontmatterDoc,
  makeTmpRepo,
  type TmpRepo,
} from "./helpers/harness-tmprepo.ts";

const ports = { proc: new ShellProcessRunner(), git: new HarnessGit() };

let repo: TmpRepo;
let restoreHome: () => void;

const RULE_OK = jsonFrontmatterDoc(
  {
    id: "project/always-pass",
    phase: "verify",
    severity: "blocking",
    gate: { type: "command", run: "true" },
  },
  "# Always passes",
);

const RULE_FAIL = jsonFrontmatterDoc(
  {
    id: "project/always-fail",
    phase: "verify",
    severity: "blocking",
    gate: { type: "command", run: "exit 1", failureMessage: "told you so" },
  },
  "# Always fails",
);

beforeEach(async () => {
  repo = await makeTmpRepo();
  // Point the user layer at an empty dir so the developer's real config cannot leak in.
  restoreHome = isolateLeinaHome(path.join(repo.root, "no-user-config"));
  // Disable builtin rules whose gates need the project toolchain (npm, leina):
  // the fixture repo has neither a package.json nor a leina install.
  await repo.write(
    ".harness/config.json",
    JSON.stringify({
      rules: {
        "harness/tests-pass": { enabled: false },
        "harness/typecheck": { enabled: false },
        "harness/lint-clean": { enabled: false },
        "harness/no-skipped-tests": { enabled: false },
        "harness/no-secrets": { enabled: false },
        "harness/leina-graph-fresh": { enabled: false },
        "harness/leina-session-summary": { enabled: false },
      },
    }),
  );
  await repo.write("src/app.ts", "export const app = 1;\n");
  // Workspace trust: project-layer js/command gates only execute in workspaces
  // the user trusted with `leina init` (see test/harness-workspace-trust.test.ts).
  await repo.write(".leina/consent", "enabled");
  trustWorkspace(repo.root);
  repo.git("add", ".");
  repo.git("commit", "-m", "init");
});

afterEach(async () => {
  restoreHome();
  await repo.cleanup();
});

describe("runVerify", () => {
  it("exits 0 when all blocking gates pass and persists the report", async () => {
    await repo.write(".harness/rules/ok.md", RULE_OK);
    const outcome = await runVerify(repo.root, { ports });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.report.summary.blockingFailures, 0);

    const persisted = JSON.parse(
      await fs.readFile(path.join(repo.root, ".harness", "state", "current", "verify-report.json"), "utf8"),
    );
    assert.equal(persisted.schemaVersion, 1);
    assert.ok(Array.isArray(persisted.results));
  });

  it("(state-ignore-1) without `leina init`, the state dir ignores itself — the report never shows up as a change", async () => {
    await repo.write(".harness/rules/ok.md", RULE_OK);
    repo.git("add", ".");
    repo.git("commit", "-m", "rule");
    await runVerify(repo.root, { ports });

    assert.equal(await fs.readFile(path.join(repo.root, ".harness", "state", ".gitignore"), "utf8"), "*\n");
    const changed = (await ports.git.changedFiles(repo.root, undefined)) ?? [];
    assert.deepEqual(
      changed.filter((f) => f.startsWith(".harness/state/")),
      [],
      "verify-report.json (test output) must never reach the diff gates",
    );
  });

  it("exits 1 on a blocking failure and carries the failureMessage", async () => {
    await repo.write(".harness/rules/fail.md", RULE_FAIL);
    const outcome = await runVerify(repo.root, { ports });
    assert.equal(outcome.exitCode, 1);
    const failing = outcome.report.results.find((r) => r.ruleId === "project/always-fail");
    assert.equal(failing?.failureMessage, "told you so");
  });

  it("exits 2 on an invalid rule file", async () => {
    await repo.write(".harness/rules/bad.md", jsonFrontmatterDoc({ id: "nonamespace" }, "body"));
    const outcome = await runVerify(repo.root, { ports });
    assert.equal(outcome.exitCode, 2);
    assert.ok(outcome.loadErrors.length > 0);
  });

  it("enforces the contract scope through the builtin diff gate", async () => {
    await saveContract(repo.root, {
      goal: "change only src",
      scope: ["src/**"],
      outOfScope: [],
      criteria: [],
      maxRetries: 3,
    });
    await repo.write("docs/out-of-scope.md", "oops\n");

    const outcome = await runVerify(repo.root, { ports });
    assert.equal(outcome.exitCode, 1);
    const diffResult = outcome.report.results.find((r) => r.ruleId === "harness/diff-in-scope");
    assert.equal(diffResult?.status, "fail");
    assert.ok(diffResult?.detail.includes("docs/out-of-scope.md"));
  });

  it("filters rules by contract task type", async () => {
    await repo.write(
      ".harness/rules/feature-only.md",
      jsonFrontmatterDoc(
        {
          id: "project/feature-only",
          phase: "verify",
          severity: "blocking",
          scope: { taskTypes: ["feature"] },
          gate: { type: "command", run: "exit 1" },
        },
        "# Only for features",
      ),
    );
    await saveContract(repo.root, {
      goal: "docs task",
      taskType: "docs",
      scope: [],
      outOfScope: [],
      criteria: [],
      maxRetries: 3,
    });
    const outcome = await runVerify(repo.root, { ports });
    const ids = outcome.report.results.map((r) => r.ruleId);
    assert.ok(!ids.includes("project/feature-only"));
  });

  it("restricts to a single rule with options.ruleId", async () => {
    await repo.write(".harness/rules/ok.md", RULE_OK);
    await repo.write(".harness/rules/fail.md", RULE_FAIL);
    const outcome = await runVerify(repo.root, { ports, ruleId: "project/always-pass" });
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.report.results.map((r) => r.ruleId), ["project/always-pass"]);
  });

  it("uses the contract baseRef for changed-file resolution", async () => {
    const head = ports.git; // capture initial HEAD before further commits
    const baseRef = (await head.currentHead(repo.root))!;
    await repo.write("src/extra.ts", "export const extra = 1;\n");
    repo.git("add", "src/extra.ts");
    repo.git("commit", "-m", "second");

    await saveContract(repo.root, {
      goal: "scope by baseRef",
      scope: ["docs/**"],
      outOfScope: [],
      criteria: [],
      maxRetries: 3,
      baseRef,
    });
    const outcome = await runVerify(repo.root, { ports });
    const diffResult = outcome.report.results.find((r) => r.ruleId === "harness/diff-in-scope");
    // src/extra.ts was committed AFTER baseRef, so it is in the diff and out of scope.
    assert.equal(diffResult?.status, "fail");
    assert.ok(diffResult?.detail.includes("src/extra.ts"));
  });

  it("skips a gate whose onlyIfChanged does not match the diff", async () => {
    await repo.write(
      ".harness/rules/scoped.md",
      jsonFrontmatterDoc(
        {
          id: "project/scoped",
          phase: "verify",
          severity: "blocking",
          gate: { type: "command", run: "exit 1", onlyIfChanged: ["rust/**"] },
        },
        "# Never triggered here",
      ),
    );
    await repo.write("src/app.ts", "export const app = 2;\n");
    const outcome = await runVerify(repo.root, { ports });
    const scoped = outcome.report.results.find((r) => r.ruleId === "project/scoped");
    assert.equal(scoped?.status, "skip");
  });
});

describe("outside a git repository (changed files unknown)", () => {
  it("(verify-nogit-1) fails closed: onlyIfChanged gates run and diff gates error instead of skipping", async () => {
    const bare = await makeTmpRepo(false);
    const restore = isolateLeinaHome(path.join(bare.root, "no-user-config"));
    try {
      await bare.write(
        ".harness/config.json",
        JSON.stringify({
          rules: {
            "harness/tests-pass": { enabled: false },
            "harness/typecheck": { enabled: false },
            "harness/lint-clean": { enabled: false },
            "harness/no-skipped-tests": { enabled: false },
            "harness/leina-graph-fresh": { enabled: false },
            "harness/leina-session-summary": { enabled: false },
          },
        }),
      );
      // Same shape as the builtin tests-pass rule: a command scoped by onlyIfChanged.
      await bare.write(
        ".harness/rules/tests.md",
        jsonFrontmatterDoc(
          {
            id: "project/tests",
            phase: "verify",
            severity: "blocking",
            gate: { type: "command", run: "exit 1", onlyIfChanged: ["src/**"] },
          },
          "# Tests",
        ),
      );
      await bare.write("src/app.ts", "export const app = 1;\n");
      trustWorkspace(bare.root);

      const outcome = await runVerify(bare.root, { ports });
      const byId = new Map(outcome.report.results.map((r) => [r.ruleId, r]));
      assert.equal(byId.get("project/tests")?.status, "fail", "the command ran instead of being skipped");
      assert.equal(byId.get("harness/no-secrets")?.status, "error");
      assert.match(byId.get("harness/no-secrets")?.detail ?? "", /not a git repository/);
      assert.equal(outcome.exitCode, 1);
      assert.ok(
        outcome.warnings.some((w) => w.includes("changed files are unknown")),
        `warnings: ${outcome.warnings.join(" | ")}`,
      );
    } finally {
      restore();
      await bare.cleanup();
    }
  });
});

describe("filtered runs (--rule / --phase)", () => {
  const reportPath = () => path.join(repo.root, ".harness", "state", "current", "verify-report.json");
  const persistedFailures = async (): Promise<number> =>
    JSON.parse(await fs.readFile(reportPath(), "utf8")).summary.blockingFailures;

  it("(verify-partial-1) a --rule run never replaces the full report the commit guard reads", async () => {
    await repo.write(".harness/rules/ok.md", RULE_OK);
    await repo.write(".harness/rules/fail.md", RULE_FAIL);
    const full = await runVerify(repo.root, { ports });
    assert.equal(full.exitCode, 1);
    assert.equal(full.persisted, true);
    assert.equal(await persistedFailures(), 1);

    const partial = await runVerify(repo.root, { ports, ruleId: "project/always-pass" });
    assert.equal(partial.exitCode, 0);
    assert.equal(partial.persisted, false);
    assert.equal(await persistedFailures(), 1, "the red full report is still what the guard sees");
  });

  it("(verify-partial-2) a phase subset is not persisted; the default phases or a superset are", async () => {
    await repo.write(".harness/rules/fail.md", RULE_FAIL);
    const subset = await runVerify(repo.root, { ports, phases: ["deliver"] });
    assert.equal(subset.persisted, false);
    await assert.rejects(fs.access(reportPath()), "nothing persisted by a phase subset");

    const superset = await runVerify(repo.root, { ports, phases: ["intake", "verify", "deliver"] });
    assert.equal(superset.persisted, true);
    assert.equal(await persistedFailures(), 1);
  });

  it("(verify-partial-3) an unknown rule id is a usage error (exit 2), not an empty green run", async () => {
    const outcome = await runVerify(repo.root, { ports, ruleId: "does/not-exist" });
    assert.equal(outcome.exitCode, 2);
    assert.match(outcome.usageError ?? "", /unknown rule "does\/not-exist"/);
    assert.deepEqual(outcome.loadErrors, [outcome.usageError]);
    assert.equal(outcome.persisted, false);
    await assert.rejects(fs.access(reportPath()));
  });

  it("(verify-partial-4) a known rule that does not apply to the run is reported, not silently green", async () => {
    const outcome = await runVerify(repo.root, { ports, ruleId: "harness/tests-pass" });
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.report.results, []);
    assert.ok(
      outcome.warnings.some((w) => /harness\/tests-pass.*does not apply/.test(w)),
      `warnings: ${outcome.warnings.join(" | ")}`,
    );
  });
});

describe("recipes", () => {
  it("loads builtin recipes and lets a project override by name", async () => {
    const builtin = await loadRecipes(repo.root);
    assert.deepEqual(builtin.errors, []);
    const names = builtin.recipes.map((r) => r.name);
    assert.ok(names.includes("fix-bug"));
    assert.ok(names.includes("add-endpoint"));

    await repo.write(
      ".harness/recipes/fix-bug.md",
      jsonFrontmatterDoc({ name: "fix-bug", description: "project override", taskType: "bugfix" }, "# Custom"),
    );
    const overridden = await loadRecipes(repo.root);
    const fixBug = overridden.recipes.find((r) => r.name === "fix-bug");
    assert.equal(fixBug?.description, "project override");
    assert.ok(fixBug?.sourcePath.includes(".harness"));
  });
});
