// harness-workspace-trust.test.ts — workspace trust for EXECUTABLE gates.
// Rules of layer 'project' travel with the repo (.harness/rules/), so their
// js/command gates would hand a cloned hostile repo silent code execution
// through the Stop hook's verify run. The engine therefore only executes them
// when the user trusted the workspace (`leina init` → a record in the
// out-of-repo trust store under $LEINA_HOME; a committed .leina/consent grants
// nothing); otherwise they are SKIPPED with a visible result and never fail verify on
// their own. Builtin/user rules (installed package / user's home) and
// non-executable gate types (file/diff/diff-content/checklist) always run.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-workspace-trust.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runVerify } from "../src/application/harness/verify.ts";
import { runGates } from "../src/application/harness/gates/engine.ts";
import { trustWorkspace } from "../src/application/install/trust.ts";
import type { GateContext } from "../src/application/harness/gates/types.ts";
import type { Gate, Rule, RuleLayer } from "../src/domain/harness/model.ts";
import { ShellProcessRunner } from "../src/infrastructure/harness/exec.ts";
import { HarnessGit } from "../src/infrastructure/harness/git.ts";
import {
  isolateLeinaHome,
  jsonFrontmatterDoc,
  makeTmpRepo,
  type TmpRepo,
} from "./helpers/harness-tmprepo.ts";

const ports = { proc: new ShellProcessRunner(), git: new HarnessGit() };

// Builtin rules whose gates need the project toolchain — disabled in the
// fixtures, mirroring harness-verify.test.ts.
const FIXTURE_CONFIG = JSON.stringify({
  rules: {
    "harness/tests-pass": { enabled: false },
    "harness/typecheck": { enabled: false },
    "harness/lint-clean": { enabled: false },
    "harness/no-skipped-tests": { enabled: false },
    "harness/no-secrets": { enabled: false },
    "harness/leina-graph-fresh": { enabled: false },
    "harness/leina-session-summary": { enabled: false },
  },
});

let repo: TmpRepo;
let restoreHome: () => void;

beforeEach(async () => {
  repo = await makeTmpRepo();
  restoreHome = isolateLeinaHome(path.join(repo.root, "no-user-config"));
  await repo.write(".harness/config.json", FIXTURE_CONFIG);
  await repo.write("src/app.ts", "export const app = 1;\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "init");
  // No trust record (and no .leina/consent) — the repo starts UNTRUSTED.
});

afterEach(async () => {
  restoreHome();
  await repo.cleanup();
});

function exists(rel: string): Promise<boolean> {
  return fs.access(path.join(repo.root, rel)).then(
    () => true,
    () => false,
  );
}

const UNTRUSTED_DETAIL = /untrusted 'project' layer rule/;

const CMD_MARKER_RULE = jsonFrontmatterDoc(
  {
    id: "project/cmd-marker",
    phase: "verify",
    severity: "blocking",
    gate: { type: "command", run: "touch project-gate-ran.txt" },
  },
  "# Project command gate that leaves a marker",
);

const CMD_FAIL_RULE = jsonFrontmatterDoc(
  {
    id: "project/cmd-fail",
    phase: "verify",
    severity: "blocking",
    gate: { type: "command", run: "exit 1", failureMessage: "must not have run" },
  },
  "# Project command gate that always fails",
);

const FILE_RULE = jsonFrontmatterDoc(
  {
    id: "project/file-gate",
    phase: "verify",
    severity: "blocking",
    gate: { type: "file", path: "src/app.ts", exists: true },
  },
  "# Declarative project gate — no code execution",
);

describe("workspace trust — runVerify end-to-end", () => {
  it("consent unknown: project command gates are skipped, never execute, never fail verify alone", async () => {
    await repo.write(".harness/rules/marker.md", CMD_MARKER_RULE);
    await repo.write(".harness/rules/fail.md", CMD_FAIL_RULE);
    await repo.write(".harness/rules/file.md", FILE_RULE);

    const outcome = await runVerify(repo.root, { ports });
    assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.report.results, null, 2));

    const failRes = outcome.report.results.find((r) => r.ruleId === "project/cmd-fail");
    assert.equal(failRes?.status, "skip");
    assert.match(failRes?.detail ?? "", UNTRUSTED_DETAIL);
    assert.match(failRes?.detail ?? "", /leina init/);

    const markerRes = outcome.report.results.find((r) => r.ruleId === "project/cmd-marker");
    assert.equal(markerRes?.status, "skip");
    assert.equal(await exists("project-gate-ran.txt"), false, "untrusted command gate must not execute");

    // (d) declarative project gates always run.
    const fileRes = outcome.report.results.find((r) => r.ruleId === "project/file-gate");
    assert.equal(fileRes?.status, "pass");
  });

  it("consent disabled: project executable gates stay skipped too (even with a trust record)", async () => {
    trustWorkspace(repo.root);
    await repo.write(".leina/consent", "disabled");
    await repo.write(".harness/rules/marker.md", CMD_MARKER_RULE);

    const outcome = await runVerify(repo.root, { ports });
    const markerRes = outcome.report.results.find((r) => r.ruleId === "project/cmd-marker");
    assert.equal(markerRes?.status, "skip");
    assert.equal(await exists("project-gate-ran.txt"), false);
  });

  it("(trust-store-v1) a committed .leina/consent = enabled does not unlock project executable gates", async () => {
    await repo.write(".leina/consent", "enabled");
    await repo.write(".harness/rules/marker.md", CMD_MARKER_RULE);

    const outcome = await runVerify(repo.root, { ports });
    const markerRes = outcome.report.results.find((r) => r.ruleId === "project/cmd-marker");
    assert.equal(markerRes?.status, "skip");
    assert.match(markerRes?.detail ?? "", UNTRUSTED_DETAIL);
    assert.equal(await exists("project-gate-ran.txt"), false, "self-granted consent must not execute");
  });

  it("trusted workspace (explicit `leina init`): the same project gates execute", async () => {
    trustWorkspace(repo.root);
    await repo.write(".harness/rules/marker.md", CMD_MARKER_RULE);
    await repo.write(".harness/rules/fail.md", CMD_FAIL_RULE);

    const outcome = await runVerify(repo.root, { ports });
    assert.equal(outcome.exitCode, 1);

    const failRes = outcome.report.results.find((r) => r.ruleId === "project/cmd-fail");
    assert.equal(failRes?.status, "fail");
    assert.equal(failRes?.failureMessage, "must not have run");
    assert.equal(await exists("project-gate-ran.txt"), true, "trusted command gate executes");
  });

  it("project js gate: module is not even loaded while untrusted, runs once trusted", async () => {
    await repo.write(
      ".harness/rules/js.md",
      jsonFrontmatterDoc(
        {
          id: "project/js-gate",
          phase: "verify",
          severity: "blocking",
          gate: { type: "js", module: "gates/probe.mjs" },
        },
        "# Project js gate",
      ),
    );
    // Import-time side effect: loading the module at all leaves a marker.
    await repo.write(
      "gates/probe.mjs",
      'import { writeFileSync } from "node:fs";\n' +
        'writeFileSync(new URL("../js-gate-loaded.txt", import.meta.url), "x");\n' +
        "export default async () => ({ pass: true });\n",
    );

    const untrusted = await runVerify(repo.root, { ports });
    const skipped = untrusted.report.results.find((r) => r.ruleId === "project/js-gate");
    assert.equal(skipped?.status, "skip");
    assert.match(skipped?.detail ?? "", UNTRUSTED_DETAIL);
    assert.equal(await exists("js-gate-loaded.txt"), false, "untrusted js module must not be imported");

    trustWorkspace(repo.root);
    const trusted = await runVerify(repo.root, { ports });
    const ran = trusted.report.results.find((r) => r.ruleId === "project/js-gate");
    assert.equal(ran?.status, "pass");
    assert.equal(await exists("js-gate-loaded.txt"), true);
  });

  it("(trust-cfg-1) a config gate override cannot smuggle a command into a builtin rule", async () => {
    // The override would run under the builtin rule's layer, i.e. outside the
    // project-layer trust check. It must be refused, not executed.
    await repo.write(
      ".harness/config.json",
      JSON.stringify({
        rules: { "harness/diff-in-scope": { gate: { type: "command", run: "touch smuggled.txt" } } },
      }),
    );

    const outcome = await runVerify(repo.root, { ports });
    assert.equal(outcome.exitCode, 2);
    assert.ok(outcome.loadErrors.some((e) => e.includes("gate")), JSON.stringify(outcome.loadErrors));
    assert.equal(await exists("smuggled.txt"), false, "config-supplied command must never execute");
  });

  it("(trust-js-1) a repo-planted look-alike never replaces a builtin rule's js module", async () => {
    // harness/leina-session-summary ships ./gates/leina-session-summary.js
    // next to its rule file; the same relative path at the repo root must
    // not be what the builtin (trusted, ungated by consent) rule imports.
    await repo.write(".harness/config.json", "{}");
    await repo.write(
      "gates/leina-session-summary.js",
      'import { writeFileSync } from "node:fs";\n' +
        'writeFileSync(new URL("../planted-module-loaded.txt", import.meta.url), "x");\n' +
        "export default async () => ({ pass: true });\n",
    );

    const outcome = await runVerify(repo.root, { ports, ruleId: "harness/leina-session-summary" });
    assert.ok(
      outcome.report.results.some((r) => r.ruleId === "harness/leina-session-summary"),
      JSON.stringify(outcome.report.results, null, 2),
    );
    assert.equal(await exists("planted-module-loaded.txt"), false, "repo module must not be imported");
  });

  it("user-layer command gate runs even without repo trust (the user's home is trusted)", async () => {
    await repo.write(
      "no-user-config/harness/rules/user-marker.md",
      jsonFrontmatterDoc(
        {
          id: "user/marker",
          phase: "verify",
          severity: "blocking",
          gate: { type: "command", run: "touch user-gate-ran.txt" },
        },
        "# User-layer command gate",
      ),
    );

    const outcome = await runVerify(repo.root, { ports });
    const userRes = outcome.report.results.find((r) => r.ruleId === "user/marker");
    assert.equal(userRes?.status, "pass", JSON.stringify(outcome.report.results, null, 2));
    assert.equal(await exists("user-gate-ran.txt"), true, "user-layer gates are trusted");
  });
});

describe("workspace trust — engine policy unit", () => {
  const ctx = (): GateContext => ({
    repoRoot: repo.root,
    changedFiles: [],
    defaultTimeoutMs: 10_000,
    defaultBranch: "main",
    ports,
  });

  const mkRule = (id: string, layer: RuleLayer, gate: Gate): Rule => ({
    id,
    version: 1,
    phase: "verify",
    severity: "blocking",
    scope: {},
    enabled: true,
    tags: [],
    gate,
    body: "remediation",
    sourcePath: "/x.md",
    layer,
  });

  const touchGate = (marker: string): Gate => ({ type: "command", run: `touch ${marker}`, expectExitCode: 0 });

  it("policy denies ONLY project-layer executable gates; builtin/user and declarative run", async () => {
    const rules = [
      mkRule("harness/builtin-cmd", "builtin", touchGate("builtin-ran.txt")),
      mkRule("user/user-cmd", "user", touchGate("user-ran.txt")),
      mkRule("project/project-cmd", "project", touchGate("project-ran.txt")),
      mkRule("project/project-file", "project", { type: "file", path: "src/app.ts", exists: true }),
    ];
    const results = await runGates(rules, ctx(), 4, { allowProjectExecutableGates: false });
    const byId = new Map(results.map((r) => [r.ruleId, r]));

    assert.equal(byId.get("harness/builtin-cmd")?.status, "pass");
    assert.equal(byId.get("user/user-cmd")?.status, "pass");
    assert.equal(byId.get("project/project-cmd")?.status, "skip");
    assert.match(byId.get("project/project-cmd")?.detail ?? "", UNTRUSTED_DETAIL);
    assert.equal(byId.get("project/project-file")?.status, "pass");

    assert.equal(await exists("builtin-ran.txt"), true);
    assert.equal(await exists("user-ran.txt"), true);
    assert.equal(await exists("project-ran.txt"), false, "denied gate must not run its command");
  });

  it("policy allowing project gates (or omitted policy) executes them", async () => {
    const allowed = await runGates(
      [mkRule("project/allowed", "project", touchGate("allowed-ran.txt"))],
      ctx(),
      4,
      { allowProjectExecutableGates: true },
    );
    assert.equal(allowed[0]?.status, "pass");
    assert.equal(await exists("allowed-ran.txt"), true);

    // No policy at all (direct engine callers, historical shape): runs.
    const legacy = await runGates([mkRule("project/legacy", "project", touchGate("legacy-ran.txt"))], ctx());
    assert.equal(legacy[0]?.status, "pass");
    assert.equal(await exists("legacy-ran.txt"), true);
  });
});
