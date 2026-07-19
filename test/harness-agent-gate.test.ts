// harness-agent-gate.test.ts — the HARNESS ENFORCEMENT branch of the
// host-neutral agent gate (runHarnessAgentGate) and its PRODUCT INVARIANT:
//
//   con contrato activo (+ consent != disabled)  → PreToolUse edit/bash y Stop
//                                                  PUEDEN bloquear;
//   sin contrato activo                          → JAMÁS bloquea (handled:false,
//                                                  el advisory queda intacto);
//   consent disabled                             → JAMÁS bloquea.
//
// Matrix: {sin contrato, con contrato, consent disabled} ×
//         {pre-edit, pre-bash, stop, session-start}.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-agent-gate.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  hasActiveHarnessContract,
  runHarnessAgentGate,
  type HarnessAgentGateResult,
} from "../src/cli/agent-gate.ts";
import { saveContract, writeChecklist } from "../src/application/harness/contract-io.ts";
import { type TaskContract } from "../src/domain/harness/model.ts";
import {
  isolateLeinaHome,
  jsonFrontmatterDoc,
  makeTmpRepo,
  type TmpRepo,
} from "./helpers/harness-tmprepo.ts";

// Never spawn detached graph builds from in-process gate tests.
process.env.LEINA_DISABLE_AUTOBUILD = "1";

// Builtin rules whose gates need the project toolchain — same fixture policy
// as harness-verify.test.ts / harness-cli.test.ts.
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
});

afterEach(async () => {
  restoreHome();
  await repo.cleanup();
});

async function setConsent(state: "enabled" | "disabled"): Promise<void> {
  await repo.write(".leina/consent", state);
}

async function newContract(overrides: Partial<TaskContract> = {}): Promise<void> {
  const contract: TaskContract = {
    goal: "matrix goal",
    scope: ["src/**"],
    outOfScope: ["vendor/**"],
    criteria: [],
    maxRetries: 3,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  await saveContract(repo.root, contract);
  await writeChecklist(repo.root, contract);
}

interface GateRun {
  result: HarnessAgentGateResult;
  stdout: string;
  stderr: string;
}

async function gate(payload: unknown, event?: string): Promise<GateRun> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    outChunks.push(String(c));
    return true;
  });
  process.stderr.write = ((c: string | Uint8Array) => {
    errChunks.push(String(c));
    return true;
  });
  try {
    const result = await runHarnessAgentGate(JSON.stringify(payload), repo.root, event);
    return { result, stdout: outChunks.join(""), stderr: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const EDIT_OUT_OF_SCOPE = {
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: { file_path: "docs/readme.md" },
};
const BASH_COMMIT = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git commit -m done" },
};
const STOP = { hook_event_name: "Stop" };
const SESSION_START = { hook_event_name: "SessionStart" };

// ---------------------------------------------------------------------------
// CON contrato activo (consent enabled) → puede bloquear
// ---------------------------------------------------------------------------

describe("harness agent gate — WITH active contract (consent enabled)", () => {
  beforeEach(async () => {
    await setConsent("enabled");
    await newContract();
  });

  it("pre-edit: out-of-scope file → BLOCK (exit 2, stderr names the scope)", async () => {
    const run = await gate(EDIT_OUT_OF_SCOPE);
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /BLOCKED: docs\/readme\.md is outside the declared contract scope \[src\/\*\*\]/);
    assert.equal(run.stdout, "");
  });

  it("pre-edit: Devin lowercase vocabulary blocks too", async () => {
    const run = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "edit",
      tool_input: { file_path: "docs/readme.md" },
    });
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
  });

  it("pre-edit: outOfScope glob → BLOCK", async () => {
    // Empty scope so the outOfScope branch (not the scope one) decides.
    await newContract({ scope: [], outOfScope: ["vendor/**"] });
    const run = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "vendor/lib.js" },
    });
    assert.equal(run.result.handled, true);
    assert.equal(run.result.exitCode, 2);
    assert.match(run.stderr, /outOfScope/);
  });

  it("pre-edit: in-scope file → not handled (advisory flow continues)", async () => {
    const run = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts" },
    });
    assert.deepEqual(run.result, { handled: false, exitCode: 0 });
    assert.equal(run.stderr, "");
  });

  it("pre-edit: .harness/state/** is always writable", async () => {
    const run = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: ".harness/state/current/plan.md" },
    });
    assert.equal(run.result.handled, false);
  });

  it("pre-edit: .harness/rules/** is agent-read-only even in guided mode", async () => {
    const run = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: ".harness/rules/tests-pass.md" },
    });
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /agent-read-only/);
  });

  it("pre-edit: .harness/config.json is agent-read-only even in guided mode", async () => {
    const run = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: ".harness/config.json" },
    });
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /agent-read-only/);
  });

  it("pre-bash: git commit with blocking failures in the report → BLOCK (exit 2)", async () => {
    await repo.write(
      ".harness/state/current/verify-report.json",
      JSON.stringify({ summary: { blockingFailures: 3 } }),
    );
    const run = await gate(BASH_COMMIT);
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /3 blocking gate\(s\) are failing/);
  });

  it("pre-bash: benign command → not handled", async () => {
    const run = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    assert.deepEqual(run.result, { handled: false, exitCode: 0 });
    assert.equal(run.stderr, "");
  });

  it("pre-bash: commit-lookalikes are NOT treated as git commit", async () => {
    await repo.write(
      ".harness/state/current/verify-report.json",
      JSON.stringify({ summary: { blockingFailures: 3 } }),
    );
    for (const command of [
      "git log --grep commit",
      'echo "git commit"',
      "echo please run git commit when done",
      "printf 'git push here'",
      "git log | grep commit",
      "git status && npm run push-metrics",
    ]) {
      const run = await gate({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
      assert.deepEqual(run.result, { handled: false, exitCode: 0 }, command);
    }
  });

  it("pre-bash: real commit/push forms ARE caught — chains, global flags, quoting, sh -c", async () => {
    await repo.write(
      ".harness/state/current/verify-report.json",
      JSON.stringify({ summary: { blockingFailures: 1 } }),
    );
    for (const command of [
      "git add -A && git commit -m done",
      "git push origin main",
      "git -C . commit -m x",
      "/usr/bin/git commit -m x",
      'git "commit" -m x',
      "sh -c 'git commit -m x'",
      'bash -c "git push origin main"',
    ]) {
      const run = await gate({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
      assert.deepEqual(run.result, { handled: true, exitCode: 2 }, command);
    }
  });

  it("pre-bash: shell writes to harness rules/config/lockfile are blocked in guided mode", async () => {
    for (const command of [
      "echo hacked > .harness/rules/tests-pass.md",
      "sed -i s/blocking/advisory/ .harness/config.json",
      "rm -rf .harness",
      "cp /tmp/x .harness/harness.lock.json",
      "tee .harness/rules/new.md",
    ]) {
      const run = await gate({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
      assert.deepEqual(run.result, { handled: true, exitCode: 2 }, command);
      assert.match(run.stderr, /agent-read-only/, command);
    }
  });

  it("pre-bash: read-only mentions and state writes stay allowed", async () => {
    for (const command of [
      "cat .harness/config.json",
      "grep -r blocking .harness/rules",
      "echo done > .harness/state/current/plan.md",
      "ls .harness/state/history",
    ]) {
      const run = await gate({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
      assert.deepEqual(run.result, { handled: false, exitCode: 0 }, command);
    }
  });

  it("stop: failing gates → {decision:block} on stdout + retry counter", async () => {
    await repo.write(
      ".harness/rules/fail.md",
      jsonFrontmatterDoc(
        {
          id: "project/always-fail",
          phase: "verify",
          severity: "blocking",
          gate: { type: "command", run: "exit 1", failureMessage: "told you so" },
        },
        "# Always fails",
      ),
    );
    const run = await gate(STOP);
    assert.deepEqual(run.result, { handled: true, exitCode: 0 });
    const decision = JSON.parse(run.stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /told you so|blocking gate/);
    const retries = JSON.parse(
      await fs.readFile(path.join(repo.root, ".harness", "state", "current", "retries.json"), "utf8"),
    );
    assert.equal(retries.count, 1);
  });

  it("stop: retry cap exhausted → yields with an honest summary, never claims success", async () => {
    await newContract({ maxRetries: 1 }); // overwrite the beforeEach contract
    await repo.write(".harness/state/current/retries.json", JSON.stringify({ count: 1 }));
    const run = await gate(STOP);
    assert.deepEqual(run.result, { handled: true, exitCode: 0 });
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /allowing stop so a human can look/);
    assert.match(run.stderr, /Do NOT treat this task as complete/);
  });

  it("stop: all gates green → not handled (advisory save-nudge still owns the event)", async () => {
    // Commit .leina/consent so the diff-in-scope gate sees a clean worktree
    // (untracked files outside src/** would otherwise fail verify).
    repo.git("add", ".leina");
    repo.git("commit", "-m", "consent");
    const run = await gate(STOP);
    assert.deepEqual(run.result, { handled: false, exitCode: 0 });
    assert.equal(run.stdout, "");
  });

  it("stop: stop_hook_active=true never loops", async () => {
    const run = await gate({ hook_event_name: "Stop", stop_hook_active: true });
    assert.deepEqual(run.result, { handled: false, exitCode: 0 });
  });

  it("session-start: handled:false + sessionContext carries the contract", async () => {
    const run = await gate(SESSION_START);
    assert.equal(run.result.handled, false);
    assert.ok(run.result.sessionContext, "session context present with active contract");
    assert.match(run.result.sessionContext ?? "", /matrix goal/);
    assert.match(run.result.sessionContext ?? "", /governed by a harness/);
    assert.equal(run.stdout, "", "the wrapper emits nothing itself — the advisory gate merges it");
  });
});

// ---------------------------------------------------------------------------
// SIN contrato → jamás bloquea, advisory intacto
// ---------------------------------------------------------------------------

describe("harness agent gate — WITHOUT active contract", () => {
  beforeEach(async () => {
    await setConsent("enabled");
  });

  it("hasActiveHarnessContract is false", () => {
    assert.equal(hasActiveHarnessContract(repo.root), false);
  });

  for (const [name, payload] of [
    ["pre-edit", EDIT_OUT_OF_SCOPE],
    ["pre-bash", BASH_COMMIT],
    ["stop", STOP],
    ["session-start", SESSION_START],
  ] as const) {
    it(`${name}: handled:false, zero output — advisory behaviour untouched`, async () => {
      const run = await gate(payload);
      assert.equal(run.result.handled, false);
      assert.equal(run.result.exitCode, 0);
      assert.equal(run.result.sessionContext, undefined);
      assert.equal(run.stdout, "");
      assert.equal(run.stderr, "");
    });
  }

  it("pre-bash with a failing report still does not block without a contract", async () => {
    await repo.write(
      ".harness/state/current/verify-report.json",
      JSON.stringify({ summary: { blockingFailures: 9 } }),
    );
    const run = await gate(BASH_COMMIT);
    assert.equal(run.result.handled, false);
    assert.equal(run.stderr, "");
  });
});

// ---------------------------------------------------------------------------
// consent disabled → jamás bloquea, aunque haya contrato
// ---------------------------------------------------------------------------

describe("harness agent gate — consent disabled", () => {
  beforeEach(async () => {
    await setConsent("disabled");
    await newContract();
  });

  for (const [name, payload] of [
    ["pre-edit", EDIT_OUT_OF_SCOPE],
    ["pre-bash", BASH_COMMIT],
    ["stop", STOP],
    ["session-start", SESSION_START],
  ] as const) {
    it(`${name}: handled:false, zero output`, async () => {
      const run = await gate(payload);
      assert.deepEqual(run.result, { handled: false, exitCode: 0 });
      assert.equal(run.stdout, "");
      assert.equal(run.stderr, "");
    });
  }
});

// ---------------------------------------------------------------------------
// consent unknown (flag ausente) + contrato → SÍ bloquea: harness sync wires
// hooks independientemente de `leina init`, así que un repo harness-governed
// no necesita estar leina-enabled ("no disabled" es la condición, no "enabled").
// ---------------------------------------------------------------------------

describe("harness agent gate — consent unknown (absent) + active contract", () => {
  it("pre-edit out-of-scope still blocks", async () => {
    await newContract();
    const run = await gate(EDIT_OUT_OF_SCOPE);
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /BLOCKED/);
  });
});
