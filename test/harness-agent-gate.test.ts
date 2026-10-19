// harness-agent-gate.test.ts — the HARNESS ENFORCEMENT branch of the
// host-neutral agent gate (runHarnessAgentGate) and its PRODUCT INVARIANT:
//
//   con contrato activo (+ workspace confiado)   → PreToolUse edit/bash y Stop
//                                                  PUEDEN bloquear;
//   sin contrato activo                          → JAMÁS bloquea (handled:false,
//                                                  el advisory queda intacto);
//   consent disabled / workspace no confiado     → JAMÁS bloquea ni inyecta.
//
// Matrix: {sin contrato, con contrato, consent disabled, no confiado} ×
//         {pre-edit, pre-bash, stop, session-start}.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-agent-gate.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hasActiveHarnessContract,
  runHarnessAgentGate,
  type HarnessAgentGateResult,
} from "../src/cli/agent-gate.ts";
import { saveContract, writeChecklist } from "../src/application/harness/contract-io.ts";
import { trustWorkspace } from "../src/application/install/trust.ts";
import { type TaskContract } from "../src/domain/harness/model.ts";
import {
  isolateLeinaHome,
  jsonFrontmatterDoc,
  makeTmpRepo,
  type TmpRepo,
  writeFreshVerifyReport,
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
let leinaHome: string;
let restoreHome: () => void;

beforeEach(async () => {
  repo = await makeTmpRepo();
  // Outside the repo: the trust store lives under $LEINA_HOME and must not
  // show up as untracked files to the diff-scope gate.
  leinaHome = await fs.mkdtemp(path.join(os.tmpdir(), "leina-agent-gate-home-"));
  restoreHome = isolateLeinaHome(leinaHome);
  await repo.write(".harness/config.json", FIXTURE_CONFIG);
  await repo.write("src/app.ts", "export const app = 1;\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "init");
});

afterEach(async () => {
  restoreHome();
  await repo.cleanup();
  await fs.rm(leinaHome, { recursive: true, force: true });
});

/** What `leina init` / `leina deinit` leave behind: the consent flag, plus trust on init. */
async function setConsent(state: "enabled" | "disabled"): Promise<void> {
  await repo.write(".leina/consent", state);
  if (state === "enabled") trustWorkspace(repo.root);
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

  it("(integrity-user-1) pre-edit: the user-level harness and the trust store are agent-read-only", async () => {
    // $LEINA_HOME/harness feeds the user rule/config layers of EVERY repo, and
    // $LEINA_HOME/trust decides where the harness runs — outside the repo, but ours.
    for (const target of [
      path.join(leinaHome, "harness", "rules", "tests-pass.md"),
      path.join(leinaHome, "harness", "config.json"),
      path.join(leinaHome, "trust", "0123abcd"),
    ]) {
      const run = await gate({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: target } });
      assert.deepEqual(run.result, { handled: true, exitCode: 2 }, target);
      assert.match(run.stderr, /agent-read-only/, target);
    }
    const elsewhere = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(os.tmpdir(), "unrelated-notes.md") },
    });
    assert.deepEqual(elsewhere.result, { handled: false, exitCode: 0 }, "other outside paths stay unpoliced");
  });

  it("(integrity-user-2) pre-bash: shell writes to the user-level harness are blocked, reads allowed", async () => {
    for (const command of [
      `echo weak > ${path.join(leinaHome, "harness", "rules", "x.md")}`,
      "sed -i s/blocking/advisory/ ~/.leina/harness/config.json",
      'rm -rf "$LEINA_HOME/harness"',
    ]) {
      const run = await gate({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
      assert.deepEqual(run.result, { handled: true, exitCode: 2 }, command);
    }
    const read = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `cat ${path.join(leinaHome, "harness", "config.json")}` },
    });
    assert.deepEqual(read.result, { handled: false, exitCode: 0 });
  });

  it("pre-bash: git commit with blocking failures in the report → BLOCK (exit 2)", async () => {
    await writeFreshVerifyReport(repo.root, 3);
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
    await writeFreshVerifyReport(repo.root, 3);
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
    await writeFreshVerifyReport(repo.root, 1);
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

  it("(shell-commit-1) pre-bash: commits behind &, subshells, substitutions and redirections are caught", async () => {
    await writeFreshVerifyReport(repo.root, 1);
    for (const command of [
      "git status & git commit -am x",
      "(git commit -am x)",
      "cd src && (git add . && git commit -m x)",
      "$(git commit -am x)",
      "echo `git commit -am x`",
      "{ git commit -am x; }",
      "npm test; git commit -am x",
      "git commit -m x 2>&1 | tail -5",
      "git status &>/dev/null && git push origin main",
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
      // (shell-integrity-2) every writer form still caught after the per-segment rework
      "printf '{}' | tee .harness/config.json",
      "echo x >.harness/rules/a.md",
      "echo x 2>.harness/rules/a.md",
      "cat > .harness/config.json <<'EOF'",
      "cd .harness && echo x > config.json",
      "cd .harness/rules; rm tests-pass.md",
      "sh -c 'echo x > .harness/config.json'",
      "eval 'rm .harness/config.json'",
      "git checkout -- .harness/config.json",
      "git rm .harness/rules/tests-pass.md",
      "dd if=/dev/zero of=.harness/config.json",
      "sudo rm .harness/config.json",
      "LC_ALL=C truncate -s0 .harness/config.json",
      "touch .harness/rules/new.md",
      "ln -sf /tmp/x .harness/rules/x.md",
      "mv /tmp/x .harness/config.json",
      "perl -pi -e s/a/b/ .harness/config.json",
      "rm .harness/state/../config.json",
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
      // (shell-integrity-1) read-only mentions next to an unrelated write hint
      "cat .harness/config.json 2>/dev/null",
      "grep foo .harness/rules > /tmp/out.txt",
      "npm install && cat .harness/config.json",
      "git commit -m 'docs: .harness/rules -> x'",
      "cp .harness/config.json /tmp/backup.json",
      "diff .harness/config.json /tmp/x.json > /tmp/d.txt",
      "sed -n 1,5p .harness/config.json",
      "rm -rf .harness/state/history",
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
// config inválida / strictness local → fail CLOSED. Una config rota no puede
// convertir el commit-block de un repo strict en allow.
// ---------------------------------------------------------------------------

describe("harness agent gate — config integrity (trusted, active contract)", () => {
  const STRICT_CONFIG = JSON.stringify({ ...JSON.parse(FIXTURE_CONFIG), strictness: "strict" });

  beforeEach(async () => {
    await setConsent("enabled");
    await newContract();
    await repo.write(".harness/config.json", STRICT_CONFIG);
  });

  it("(cfg-closed-1) invalid config.local.json: git commit is blocked naming the config error", async () => {
    await repo.write(".harness/config.local.json", JSON.stringify({ verify: { parallelism: 0 } }));
    const run = await gate(BASH_COMMIT);
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /harness config is invalid/);
    assert.match(run.stderr, /parallelism/);
  });

  it("(cfg-closed-2) malformed config.local.json: in-scope edits are blocked, task state stays writable", async () => {
    await repo.write(".harness/config.local.json", "{ nope");
    const edit = await gate({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "src/app.ts" } });
    assert.deepEqual(edit.result, { handled: true, exitCode: 2 });
    assert.match(edit.stderr, /harness config is invalid/);
    assert.match(edit.stderr, /config\.local\.json/);

    const state = await gate({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: ".harness/state/current/plan.md" },
    });
    assert.deepEqual(state.result, { handled: false, exitCode: 0 });
  });

  it("(cfg-closed-3) config.local strictness guided cannot unlock a commit without a verify report", async () => {
    await repo.write(".harness/config.local.json", JSON.stringify({ strictness: "guided" }));
    const run = await gate(BASH_COMMIT);
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /no verify report found and strictness is "strict"/);
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
    await writeFreshVerifyReport(repo.root, 9);
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
// workspace NO confiado + contrato → jamás bloquea ni inyecta. La confianza es
// el registro fuera del repo que escribe `leina init` ($LEINA_HOME/trust/);
// un clon hostil puede commitear contrato, reglas y hasta `.leina/consent =
// enabled`, pero no ese registro.
// ---------------------------------------------------------------------------

describe("harness agent gate — untrusted workspace + active contract", () => {
  const MATRIX = [
    ["pre-edit", EDIT_OUT_OF_SCOPE],
    ["pre-bash", BASH_COMMIT],
    ["stop", STOP],
    ["session-start", SESSION_START],
  ] as const;

  beforeEach(async () => {
    await newContract();
    await repo.write(
      ".harness/state/current/verify-report.json",
      JSON.stringify({ summary: { blockingFailures: 3 } }),
    );
    await repo.write(
      ".harness/rules/marker.md",
      jsonFrontmatterDoc(
        {
          id: "project/marker",
          phase: "verify",
          severity: "blocking",
          gate: { type: "file", path: "never-there.txt", exists: true },
        },
        "# Always fails (declarative — would run even untrusted)",
      ),
    );
  });

  for (const [name, payload] of MATRIX) {
    it(`(gate-trust-1) consent unknown, no trust record — ${name}: silent no-op`, async () => {
      const run = await gate(payload);
      assert.deepEqual(run.result, { handled: false, exitCode: 0 });
      assert.equal(run.stdout, "");
      assert.equal(run.stderr, "");
    });

    it(`(gate-trust-2) committed .leina/consent = enabled, no trust record — ${name}: silent no-op`, async () => {
      await repo.write(".leina/consent", "enabled");
      const run = await gate(payload);
      assert.deepEqual(run.result, { handled: false, exitCode: 0 });
      assert.equal(run.stdout, "");
      assert.equal(run.stderr, "");
    });
  }

  it("(gate-trust-3) stop in an untrusted workspace never runs verify", async () => {
    await fs.rm(path.join(repo.root, ".harness", "state", "current", "verify-report.json"));
    await gate(STOP);
    assert.equal(
      await fs.access(path.join(repo.root, ".harness", "state", "current", "verify-report.json")).then(
        () => true,
        () => false,
      ),
      false,
      "no verify run, no persisted report",
    );
  });
});
