// harness-capabilities.test.ts — the harness.* entries of the capability
// registry (etapa 4 of the harness absorption): declarative contracts (ids,
// transports, mcp tool names, schemas) and the shared use-cases exercised over
// throwaway git repos, mirroring harness-verify.test.ts fixtures.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-capabilities.test.ts

import { afterEach, beforeEach, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  capabilities,
  harnessContractNew,
  harnessContractShow,
  harnessRulesList,
} from "../src/application/capabilities/registry.ts";
import { endContract } from "../src/application/harness/contract-io.ts";
import { runVerify } from "../src/application/harness/verify.ts";
import { trustWorkspace } from "../src/application/install/trust.ts";
import { validateAgainstSchema } from "../src/domain/contracts/schemas.ts";
import { ShellProcessRunner } from "../src/infrastructure/harness/exec.ts";
import { HarnessGit } from "../src/infrastructure/harness/git.ts";
import {
  isolateLeinaHome,
  jsonFrontmatterDoc,
  makeTmpRepo,
  type TmpRepo,
} from "./helpers/harness-tmprepo.ts";

const HARNESS_IDS = [
  "harness.contract.new",
  "harness.contract.show",
  "harness.contract.end",
  "harness.verify",
  "harness.rules.list",
] as const;

const MCP_TOOLS: Record<string, string> = {
  "harness.contract.new": "harness_contract_new",
  "harness.contract.show": "harness_contract_show",
  "harness.contract.end": "harness_contract_end",
  "harness.verify": "harness_verify",
  "harness.rules.list": "harness_rules_list",
};

function cap(id: string) {
  const cc = capabilities.find((c) => c.capability.id === id);
  assert.ok(cc, `capability '${id}' must be in the registry`);
  return cc;
}

// ---------------------------------------------------------------------------
// Declarative contracts — ids, transports, schemas, tool names.
// ---------------------------------------------------------------------------

test("(hcap-1) the 5 harness capabilities exist with cli+mcp transports and schemaVersion 1", () => {
  for (const id of HARNESS_IDS) {
    const cc = cap(id);
    assert.deepEqual(cc.capability.transports, ["cli", "mcp"], `${id} transports`);
    assert.equal(cc.capability.schemaVersion, 1, `${id} schemaVersion`);
    assert.ok(cc.capability.inputSchema, `${id} inputSchema`);
    assert.ok(cc.capability.outputSchema, `${id} outputSchema`);
    assert.equal(cc.capability.inputSchema.type, "object", `${id} input is an object schema`);
  }
});

test("(hcap-2) mcp tool names follow the server convention", () => {
  for (const id of HARNESS_IDS) {
    assert.equal(cap(id).mcp?.tool, MCP_TOOLS[id], `${id} mcp.tool`);
  }
});

test("(hcap-3) cli declarations point at the existing `leina harness` transport", () => {
  assert.equal(cap("harness.contract.new").cli.command, "harness contract new");
  assert.equal(cap("harness.contract.show").cli.command, "harness contract show");
  assert.equal(cap("harness.contract.end").cli.command, "harness contract end");
  assert.equal(cap("harness.verify").cli.command, "harness verify");
  assert.equal(cap("harness.rules.list").cli.command, "harness list");
});

test("(hcap-4) capability entries carry no function references (metadata only)", () => {
  // The v1 `fn` field was removed — both transports converge on the shared
  // use-cases behaviourally (exercised below), not through registry references.
  for (const id of HARNESS_IDS) {
    assert.ok(!("fn" in cap(id).capability), `${id} must not carry a fn field`);
  }
});

test("(hcap-5) every harness input requires root except where MCP overrides it, goal required on contract.new", () => {
  assert.deepEqual(cap("harness.contract.new").capability.inputSchema.required, ["root", "goal"]);
  for (const id of ["harness.contract.show", "harness.contract.end", "harness.rules.list", "harness.verify"]) {
    assert.ok(cap(id).capability.inputSchema.required?.includes("root"), `${id} requires root`);
  }
});

// ---------------------------------------------------------------------------
// Use-case behaviour over a throwaway git repo (fixtures as in
// harness-verify.test.ts: builtin toolchain gates disabled — the tmp repo has
// no npm/leina install).
// ---------------------------------------------------------------------------

const ports = { proc: new ShellProcessRunner(), git: new HarnessGit() };

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

let repo: TmpRepo;
let restoreHome: () => void;

beforeEach(async () => {
  repo = await makeTmpRepo();
  restoreHome = isolateLeinaHome(path.join(repo.root, "no-user-config"));
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

describe("harness capability use-cases (tmp repo)", () => {
  it("contract.new creates the contract with baseRef, refuses a second one, show/end round-trip", async () => {
    const created = await harnessContractNew(
      repo.root,
      { goal: "expose harness caps", taskType: "feature", scope: ["src/**"], criteria: ["c1"] },
      new HarnessGit(),
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(created.ok && /^[0-9a-f]{40}$/.test(created.contract.baseRef ?? ""), "baseRef recorded from git HEAD");

    const newSchema = cap("harness.contract.new").capability.outputSchema;
    assert.deepEqual(validateAgainstSchema(created, newSchema), { valid: true, errors: [] });

    // Persisted artifacts: contract.json + checklist.md.
    const contractRaw = JSON.parse(
      await fs.readFile(path.join(repo.root, ".harness", "state", "current", "contract.json"), "utf8"),
    );
    assert.equal(contractRaw.goal, "expose harness caps");
    assert.deepEqual(contractRaw.scope, ["src/**"]);
    const checklist = await fs.readFile(
      path.join(repo.root, ".harness", "state", "current", "checklist.md"),
      "utf8",
    );
    assert.match(checklist, /- \[ \] c1/);

    // Second contract refused while one is active.
    const dup = await harnessContractNew(repo.root, { goal: "second" });
    assert.equal(dup.ok, false);
    assert.ok(!dup.ok && dup.error.includes("already active"));

    // show → active contract, schema-valid.
    const shown = await harnessContractShow(repo.root);
    assert.equal(shown.active, true);
    assert.equal(shown.contract?.goal, "expose harness caps");
    const showSchema = cap("harness.contract.show").capability.outputSchema;
    assert.deepEqual(validateAgainstSchema(shown, showSchema), { valid: true, errors: [] });

    // end → archived to history, schema-valid; second end fails cleanly.
    const ended = await endContract(repo.root);
    assert.equal(ended.ok, true);
    assert.ok(ended.ok && ended.archivedTo.includes(path.join(".harness", "state", "history")));
    const endSchema = cap("harness.contract.end").capability.outputSchema;
    assert.deepEqual(validateAgainstSchema(ended, endSchema), { valid: true, errors: [] });
    const history = await fs.readdir(path.join(repo.root, ".harness", "state", "history"));
    assert.equal(history.length, 1);

    const shownAfter = await harnessContractShow(repo.root);
    assert.equal(shownAfter.active, false);
    assert.equal(shownAfter.contract, undefined);

    const endedAgain = await endContract(repo.root);
    assert.equal(endedAgain.ok, false);
    assert.ok(!endedAgain.ok && endedAgain.error.includes("no active contract"));
  });

  it("contract.new validates task type and maxRetries without touching state", async () => {
    const badType = await harnessContractNew(repo.root, { goal: "g", taskType: "yolo" });
    assert.equal(badType.ok, false);
    assert.ok(!badType.ok && badType.error.includes("unknown task type"));

    const badRetries = await harnessContractNew(repo.root, { goal: "g", maxRetries: 0 });
    assert.equal(badRetries.ok, false);

    // (cli-retries-mcp) above the stop gate's cap is rejected, not silently capped.
    const overCap = await harnessContractNew(repo.root, { goal: "g", maxRetries: 11 });
    assert.ok(!overCap.ok && overCap.error.includes("at most 10"));

    const blankGoal = await harnessContractNew(repo.root, { goal: "   " });
    assert.equal(blankGoal.ok, false);

    await assert.rejects(
      fs.access(path.join(repo.root, ".harness", "state", "current", "contract.json")),
      "no contract persisted after rejected inputs",
    );
  });

  it("rules.list projects resolved rules (builtin + project) with layer/phase/gates", async () => {
    await repo.write(".harness/rules/ok.md", RULE_OK);
    const listed = await harnessRulesList(repo.root);

    const listSchema = cap("harness.rules.list").capability.outputSchema;
    assert.deepEqual(validateAgainstSchema(listed, listSchema), { valid: true, errors: [] });
    assert.deepEqual(listed.errors, []);

    const projectRule = listed.rules.find((r) => r.id === "project/always-pass");
    assert.ok(projectRule, "project rule resolved");
    assert.equal(projectRule.layer, "project");
    assert.equal(projectRule.phase, "verify");
    assert.equal(projectRule.severity, "blocking");
    assert.equal(projectRule.enabled, true);
    assert.deepEqual(projectRule.gates, ["command"]);

    const testsPass = listed.rules.find((r) => r.id === "harness/tests-pass");
    assert.ok(testsPass, "builtin rule resolved");
    assert.equal(testsPass.layer, "builtin");
    assert.equal(testsPass.enabled, false, "fixture config override applies");
  });

  it("verify runs the gates through the injected ports: green then red, schema-valid outcome", async () => {
    await repo.write(".harness/rules/ok.md", RULE_OK);
    const green = await runVerify(repo.root, { ports });
    assert.equal(green.exitCode, 0, JSON.stringify(green.report.results));
    assert.equal(green.report.summary.blockingFailures, 0);

    const verifySchema = cap("harness.verify").capability.outputSchema;
    assert.deepEqual(validateAgainstSchema(green, verifySchema), { valid: true, errors: [] });

    await repo.write(".harness/rules/fail.md", RULE_FAIL);
    const red = await runVerify(repo.root, { ports });
    assert.equal(red.exitCode, 1);
    assert.ok(red.report.summary.blockingFailures >= 1);
    const failing = red.report.results.find((r) => r.ruleId === "project/always-fail");
    assert.equal(failing?.failureMessage, "told you so");
    assert.deepEqual(validateAgainstSchema(red, verifySchema), { valid: true, errors: [] });

    // --rule restriction, as the MCP executor exposes it.
    const only = await runVerify(repo.root, { ports, ruleId: "project/always-pass" });
    assert.equal(only.exitCode, 0);
    assert.deepEqual(
      only.report.results.map((r) => r.ruleId),
      ["project/always-pass"],
    );
  });
});
