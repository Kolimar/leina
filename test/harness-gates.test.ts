// harness-gates.test.ts — every gate runner plus the engine, exercised against
// real throwaway git repos (mkdtemp) with the real infrastructure ports
// (ShellProcessRunner + HarnessGit). Ports the substance of the origin
// harness-framework's unit/gates.test.ts to node:test.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-gates.test.ts

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandGate } from "../src/application/harness/gates/command.ts";
import { runFileGate } from "../src/application/harness/gates/file.ts";
import { runDiffGate } from "../src/application/harness/gates/diff.ts";
import { runDiffContentGate } from "../src/application/harness/gates/diff-content.ts";
import { runChecklistGate } from "../src/application/harness/gates/checklist.ts";
import { runJsGate } from "../src/application/harness/gates/js.ts";
import { runGates, isBlockingFailure } from "../src/application/harness/gates/engine.ts";
import { buildReport, renderFeedback } from "../src/application/harness/gates/report.ts";
import type { GateContext } from "../src/application/harness/gates/types.ts";
import type { Rule, TaskContract } from "../src/domain/harness/model.ts";
import { ShellProcessRunner } from "../src/infrastructure/harness/exec.ts";
import { HarnessGit } from "../src/infrastructure/harness/git.ts";
import { makeTmpRepo, type TmpRepo } from "./helpers/harness-tmprepo.ts";

const ports = { proc: new ShellProcessRunner(), git: new HarnessGit() };

let repo: TmpRepo;

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  repoRoot: repo.root,
  changedFiles: [],
  defaultTimeoutMs: 10_000,
  defaultBranch: "main",
  ports,
  ...over,
});

const contract = (over: Partial<TaskContract> = {}): TaskContract => ({
  goal: "x",
  scope: [],
  outOfScope: [],
  criteria: [],
  maxRetries: 3,
  ...over,
});

before(async () => {
  repo = await makeTmpRepo();
  await repo.write("src/app.ts", "export const app = 1;\n");
  await repo.write("README.md", "# fixture\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "init");
});

after(async () => {
  await repo.cleanup();
});

describe("command gate", () => {
  it("passes on expected exit code", async () => {
    const r = await runCommandGate({ type: "command", run: "true", expectExitCode: 0 }, ctx());
    assert.equal(r.status, "pass");
  });

  it("fails on unexpected exit code and captures output", async () => {
    const r = await runCommandGate({ type: "command", run: "echo boom && exit 3", expectExitCode: 0 }, ctx());
    assert.equal(r.status, "fail");
    assert.ok(r.output?.includes("boom"));
  });

  it("captures stderr in the combined output", async () => {
    const r = await runCommandGate(
      { type: "command", run: "echo warn >&2; exit 1", expectExitCode: 0 },
      ctx(),
    );
    assert.equal(r.status, "fail");
    assert.ok(r.output?.includes("warn"));
  });

  it("checks expectStdoutMatch", async () => {
    const ok = await runCommandGate(
      { type: "command", run: "echo hello-world", expectExitCode: 0, expectStdoutMatch: "hello-\\w+" },
      ctx(),
    );
    assert.equal(ok.status, "pass");
    const bad = await runCommandGate(
      { type: "command", run: "echo nope", expectExitCode: 0, expectStdoutMatch: "hello" },
      ctx(),
    );
    assert.equal(bad.status, "fail");
  });

  it("passes gate env vars through", async () => {
    const r = await runCommandGate(
      {
        type: "command",
        run: 'test "$HARNESS_PROBE" = on',
        expectExitCode: 0,
        env: { HARNESS_PROBE: "on" },
      },
      ctx(),
    );
    assert.equal(r.status, "pass");
  });

  it("times out", async () => {
    const r = await runCommandGate(
      { type: "command", run: "sleep 5", expectExitCode: 0, timeoutMs: 200 },
      ctx(),
    );
    assert.equal(r.status, "timeout");
  });
});

describe("file gate", () => {
  it("checks existence and minBytes", async () => {
    assert.equal((await runFileGate({ type: "file", path: "README.md", exists: true }, ctx())).status, "pass");
    assert.equal((await runFileGate({ type: "file", path: "missing.md", exists: true }, ctx())).status, "fail");
    assert.equal(
      (await runFileGate({ type: "file", path: "README.md", exists: true, minBytes: 10_000 }, ctx())).status,
      "fail",
    );
  });

  it("supports exists: false", async () => {
    assert.equal((await runFileGate({ type: "file", path: "missing.md", exists: false }, ctx())).status, "pass");
    assert.equal((await runFileGate({ type: "file", path: "README.md", exists: false }, ctx())).status, "fail");
  });

  it("checks content patterns", async () => {
    assert.equal(
      (await runFileGate({ type: "file", path: "README.md", exists: true, contentMatch: "fixture" }, ctx()))
        .status,
      "pass",
    );
    assert.equal(
      (await runFileGate({ type: "file", path: "README.md", exists: true, contentNotMatch: "fixture" }, ctx()))
        .status,
      "fail",
    );
  });

  it("resolves glob paths, including dotted directories", async () => {
    await repo.write(".harness/state/current/plan.md", "# plan\n");
    const r = await runFileGate(
      { type: "file", path: ".harness/state/**/plan.md", exists: true, contentMatch: "plan" },
      ctx(),
    );
    assert.equal(r.status, "pass");
  });
});

describe("checklist gate", () => {
  it("fails on unchecked items and passes when all checked", async () => {
    await repo.write("checklist.md", "- [x] one\n- [ ] two\n");
    const fail = await runChecklistGate(
      { type: "checklist", path: "checklist.md", requireAllChecked: true },
      ctx(),
    );
    assert.equal(fail.status, "fail");
    assert.ok(fail.output?.includes("two"));

    await repo.write("checklist.md", "- [x] one\n- [X] two\n");
    const pass = await runChecklistGate(
      { type: "checklist", path: "checklist.md", requireAllChecked: true },
      ctx(),
    );
    assert.equal(pass.status, "pass");
  });

  it("fails on a checklist with no items", async () => {
    await repo.write("empty.md", "nothing here\n");
    const r = await runChecklistGate({ type: "checklist", path: "empty.md", requireAllChecked: true }, ctx());
    assert.equal(r.status, "fail");
  });

  it("skips when the file is missing and no contract declares criteria", async () => {
    const r = await runChecklistGate({ type: "checklist", path: "nope.md", requireAllChecked: true }, ctx());
    assert.equal(r.status, "skip");
  });

  it("fails when the file is missing but the contract declares criteria", async () => {
    const r = await runChecklistGate(
      { type: "checklist", path: "nope.md", requireAllChecked: true },
      ctx({ contract: contract({ criteria: [{ text: "c1", done: false }] }) }),
    );
    assert.equal(r.status, "fail");
  });
});

describe("diff gate", () => {
  it("flags files outside allowedPaths, including untracked files", async () => {
    await repo.write("src/app.ts", "export const app = 2;\n");
    await repo.write("docs/new.md", "out of scope\n");
    const changed = ["src/app.ts", "docs/new.md"];

    const fail = await runDiffGate({ type: "diff", allowedPaths: ["src/**"] }, ctx({ changedFiles: changed }));
    assert.equal(fail.status, "fail");
    assert.ok(fail.detail.includes("docs/new.md"));

    const pass = await runDiffGate(
      { type: "diff", allowedPaths: ["src/**", "docs/**"] },
      ctx({ changedFiles: changed }),
    );
    assert.equal(pass.status, "pass");
  });

  it("takes allowedPaths from the active contract scope", async () => {
    const r = await runDiffGate(
      { type: "diff" },
      ctx({ changedFiles: ["docs/new.md"], contract: contract({ scope: ["src/**"] }) }),
    );
    assert.equal(r.status, "fail");
  });

  it("enforces forbiddenPaths from the contract outOfScope", async () => {
    const r = await runDiffGate(
      { type: "diff" },
      ctx({ changedFiles: ["src/app.ts"], contract: contract({ outOfScope: ["src/**"] }) }),
    );
    assert.equal(r.status, "fail");
    assert.ok(r.detail.includes("forbidden"));
  });

  it("enforces requireChangesIn and maxChangedFiles", async () => {
    const missing = await runDiffGate(
      { type: "diff", requireChangesIn: ["test/**"] },
      ctx({ changedFiles: ["src/app.ts"] }),
    );
    assert.equal(missing.status, "fail");

    const tooMany = await runDiffGate(
      { type: "diff", maxChangedFiles: 1 },
      ctx({ changedFiles: ["a", "b"] }),
    );
    assert.equal(tooMany.status, "fail");
  });

  it("passes when nothing is declared", async () => {
    const r = await runDiffGate({ type: "diff" }, ctx({ changedFiles: ["anything"] }));
    assert.equal(r.status, "pass");
  });

  it("exempts harness metadata and sync-generated artifacts from the scope check", async () => {
    const r = await runDiffGate(
      { type: "diff", allowedPaths: ["src/**"] },
      ctx({
        changedFiles: ["src/app.ts", ".harness/config.json", "AGENTS.md", ".claude/settings.json"],
        generatedPaths: ["AGENTS.md", ".claude/settings.json"],
      }),
    );
    assert.equal(r.status, "pass");
  });

  it("skips outside a git repository", async () => {
    const bare = await makeTmpRepo(false);
    try {
      const r = await runDiffGate({ type: "diff", allowedPaths: ["src/**"] }, ctx({ repoRoot: bare.root }));
      assert.equal(r.status, "skip");
    } finally {
      await bare.cleanup();
    }
  });
});

describe("diff-content gate", () => {
  it("catches forbidden added lines and passes clean diffs", async () => {
    await repo.write("src/app.ts", 'export const app = 2;\nconst apiKey = "sk_live_x";\n');
    const hit = await runDiffContentGate(
      { type: "diff-content", forbidAdded: "api[_-]?key\\s*=", ignoreCase: true },
      ctx(),
    );
    assert.equal(hit.status, "fail");
    // Location + masked prefix only — the offending line is never echoed
    // (a matched secret must not flow into the report/model context).
    assert.ok(hit.output?.includes("src/app.ts:2"), hit.output);
    assert.ok(hit.output?.includes("api***"), hit.output);
    assert.ok(!hit.output?.includes("sk_live_x"));

    await repo.write("src/app.ts", "export const app = 2;\n");
    const clean = await runDiffContentGate(
      { type: "diff-content", forbidAdded: "api[_-]?key", ignoreCase: true },
      ctx(),
    );
    assert.equal(clean.status, "pass");
  });

  it("sees content in brand-new UNTRACKED files (secrets cannot hide before git add)", async () => {
    await repo.write("src/fresh-file.ts", 'const apiKey = "sk_live_untracked_secret_x";\n');
    try {
      const hit = await runDiffContentGate(
        { type: "diff-content", forbidAdded: "api[_-]?key\\s*=", ignoreCase: true },
        ctx(),
      );
      assert.equal(hit.status, "fail");
      // The untracked file IS scanned, but its content is reported masked.
      assert.ok(hit.output?.includes("src/fresh-file.ts:1"), hit.output);
      assert.ok(!hit.output?.includes("sk_live_untracked_secret_x"));
    } finally {
      repo.git("clean", "-fq", "--", "src/fresh-file.ts");
    }
  });

  it("cached diff is strictly the index — untracked content is NOT appended", async () => {
    await repo.write("src/loose.ts", 'const apiKey = "sk_live_cached_check_x";\n');
    try {
      const workingTree = await ports.git.diffUnified(repo.root, {});
      assert.ok(workingTree?.includes("sk_live_cached_check_x"), "working-tree diff sees untracked");
      const index = await ports.git.diffUnified(repo.root, { cached: true });
      assert.ok(!index?.includes("sk_live_cached_check_x"), "--cached does not");
    } finally {
      repo.git("clean", "-fq", "--", "src/loose.ts");
    }
  });

  it("respects path filters", async () => {
    await repo.write("docs/todo.md", "TODO: later\n");
    repo.git("add", "docs/todo.md");
    try {
      const scoped = await runDiffContentGate(
        { type: "diff-content", forbidAdded: "TODO", ignoreCase: false, paths: ["src"] },
        ctx(),
      );
      assert.equal(scoped.status, "pass");
    } finally {
      repo.git("rm", "--cached", "-q", "docs/todo.md");
    }
  });

  it("reports an invalid regex as an error", async () => {
    const r = await runDiffContentGate({ type: "diff-content", forbidAdded: "(", ignoreCase: false }, ctx());
    assert.equal(r.status, "error");
  });
});

describe("js gate", () => {
  it("runs a repo-relative module and maps its result", async () => {
    await repo.write(
      "gates/ok.mjs",
      "export default async (ctx) => ({ pass: ctx.changedFiles.length === 0, message: 'checked' });\n",
    );
    const r = await runJsGate({ type: "js", module: "gates/ok.mjs" }, ctx());
    assert.equal(r.status, "pass");
    assert.equal(r.detail, "checked");
  });

  it("fails when the module says no, and errors on bad shapes", async () => {
    await repo.write("gates/no.mjs", "export default async () => ({ pass: false, message: 'nope' });\n");
    const fail = await runJsGate({ type: "js", module: "gates/no.mjs" }, ctx());
    assert.equal(fail.status, "fail");

    await repo.write("gates/bad.mjs", "export default async () => 42;\n");
    const bad = await runJsGate({ type: "js", module: "gates/bad.mjs" }, ctx());
    assert.equal(bad.status, "error");

    const missing = await runJsGate({ type: "js", module: "gates/missing.mjs" }, ctx());
    assert.equal(missing.status, "error");
  });

  it("resolves the module next to the rule file when absent from the repo", async () => {
    await repo.write("rules-dir/near-rule.mjs", "export default async () => ({ pass: true });\n");
    const r = await runJsGate(
      { type: "js", module: "near-rule.mjs" },
      ctx({ ruleSourcePath: `${repo.root}/rules-dir/rule.md` }),
    );
    assert.equal(r.status, "pass");
  });

  // Import-time side effect: a marker next to the module proves it was loaded.
  const markerModule = (marker: string, result: string): string =>
    'import { writeFileSync } from "node:fs";\n' +
    `writeFileSync(new URL("./${marker}", import.meta.url), "x");\n` +
    `export default async () => (${result});\n`;

  it("(js-res-1) builtin/user rules load the module next to their rule file — never a repo look-alike", async () => {
    const ruleDir = await fs.mkdtemp(path.join(os.tmpdir(), "leina-js-trusted-"));
    try {
      await repo.write("gates/shadow.mjs", markerModule("shadow-loaded.txt", '{ pass: false, message: "repo module" }'));
      await fs.mkdir(path.join(ruleDir, "gates"));
      await fs.writeFile(
        path.join(ruleDir, "gates", "shadow.mjs"),
        'export default async () => ({ pass: true, message: "shipped module" });\n',
      );
      for (const ruleLayer of ["builtin", "user"] as const) {
        const r = await runJsGate(
          { type: "js", module: "./gates/shadow.mjs" },
          ctx({ ruleLayer, ruleSourcePath: path.join(ruleDir, "rule.md") }),
        );
        assert.equal(r.status, "pass", ruleLayer);
        assert.equal(r.detail, "shipped module", ruleLayer);
      }
      assert.equal(existsSync(path.join(repo.root, "gates", "shadow-loaded.txt")), false, "repo module never imported");
    } finally {
      await fs.rm(ruleDir, { recursive: true, force: true });
    }
  });

  it("(js-res-2) project rules cannot load a module outside the repo (../, absolute, escaping symlink)", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "leina-js-outside-"));
    const link = path.join(repo.root, "linked-out");
    try {
      const evil = path.join(outside, "evil.mjs");
      await fs.writeFile(evil, markerModule("evil-loaded.txt", "{ pass: true }"));
      await fs.symlink(outside, link);
      const projectCtx = ctx({ ruleLayer: "project", ruleSourcePath: path.join(repo.root, ".harness", "rules", "r.md") });
      for (const module of [path.relative(repo.root, evil), evil, "linked-out/evil.mjs"]) {
        const r = await runJsGate({ type: "js", module }, projectCtx);
        assert.equal(r.status, "error", module);
        assert.match(r.detail, /outside the repository|repo-relative/, module);
      }
      assert.equal(existsSync(path.join(outside, "evil-loaded.txt")), false, "escaping module never imported");
    } finally {
      await fs.rm(link, { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("(js-res-3) project rules still load repo-relative and in-repo near-rule modules", async () => {
    await repo.write("gates/in-repo.mjs", "export default async () => ({ pass: true, message: 'in repo' });\n");
    await repo.write(".harness/rules/near.mjs", "export default async () => ({ pass: true, message: 'near rule' });\n");
    const projectCtx = ctx({ ruleLayer: "project", ruleSourcePath: path.join(repo.root, ".harness", "rules", "r.md") });
    assert.equal((await runJsGate({ type: "js", module: "gates/in-repo.mjs" }, projectCtx)).detail, "in repo");
    assert.equal((await runJsGate({ type: "js", module: "near.mjs" }, projectCtx)).detail, "near rule");
  });
});

describe("engine", () => {
  const mkRule = (id: string, over: Partial<Rule>): Rule => ({
    id,
    version: 1,
    phase: "verify",
    severity: "blocking",
    scope: {},
    enabled: true,
    tags: [],
    body: "remediation text",
    sourcePath: "/x.md",
    layer: "project",
    ...over,
  });

  it("skips gates whose onlyIfChanged does not match", async () => {
    const rule = mkRule("project/skippy", {
      gate: { type: "command", run: "exit 1", expectExitCode: 0, onlyIfChanged: ["src/**"] },
    });
    const results = await runGates([rule], ctx({ changedFiles: ["docs/readme.md"] }));
    assert.equal(results[0]?.status, "skip");
  });

  it("attaches failureMessage and remediation on failure", async () => {
    const rule = mkRule("project/fails", {
      gate: { type: "command", run: "exit 1", expectExitCode: 0, failureMessage: "fix it like this" },
    });
    const results = await runGates([rule], ctx());
    assert.equal(results[0]?.status, "fail");
    assert.equal(results[0]?.failureMessage, "fix it like this");
    assert.equal(results[0]?.remediation, "remediation text");
    assert.ok(isBlockingFailure(results[0]));
  });

  it("runs multiple gates and keeps planning order (serial last)", async () => {
    const rules = [
      mkRule("project/a", { gate: { type: "command", run: "true", expectExitCode: 0 } }),
      mkRule("project/b", { gate: { type: "file", path: "README.md", exists: true } }),
      mkRule("project/c", { gate: { type: "command", run: "exit 1", expectExitCode: 0, serial: true } }),
    ];
    const results = await runGates(rules, ctx());
    assert.deepEqual(results.map((r) => r.ruleId), ["project/a", "project/b", "project/c"]);
    assert.deepEqual(results.map((r) => r.status), ["pass", "pass", "fail"]);
  });

  it("times out non-command gates through the engine wrapper (fail-closed)", async () => {
    await repo.write("gates/slow.mjs", "export default () => new Promise(() => {});\n");
    const rule = mkRule("project/slow", { gate: { type: "js", module: "gates/slow.mjs", timeoutMs: 200 } });
    const results = await runGates([rule], ctx());
    assert.equal(results[0]?.status, "timeout");
    assert.ok(isBlockingFailure(results[0]));
  });

  it("renderFeedback names failing gates and the leina command", async () => {
    const rule = mkRule("project/fails", {
      gate: { type: "command", run: "exit 1", expectExitCode: 0, failureMessage: "do the fix" },
    });
    const results = await runGates([rule], ctx());
    const feedback = renderFeedback(buildReport(["verify"], new Date(), results));
    assert.ok(feedback.includes("leina harness verify"));
    assert.ok(feedback.includes("[project/fails]"));
    assert.ok(feedback.includes("do the fix"));
  });
});
