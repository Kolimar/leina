// harness-stop-reuse.test.ts — the Stop gate reuses the last FULL verify when it provably
// still holds (same HEAD, working-tree fingerprint, rules/config/contract and trust) instead
// of re-running every gate, keeps the retry accounting of a fresh run, and never reuses a
// partial run, a report without a reuse key, or a report about another tree.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-stop-reuse.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { decideStop } from "../src/application/harness/hooks.ts";
import { reusePersistedVerify, runVerify } from "../src/application/harness/verify.ts";
import { saveContract } from "../src/application/harness/contract-io.ts";
import { trustWorkspace } from "../src/application/install/trust.ts";
import { ShellProcessRunner } from "../src/infrastructure/harness/exec.ts";
import { HarnessGit } from "../src/infrastructure/harness/git.ts";
import type { ProcessRunnerPort } from "../src/domain/harness/ports.ts";
import {
  isolateLeinaHome,
  jsonFrontmatterDoc,
  makeTmpRepo,
  writeFreshVerifyReport,
  type TmpRepo,
} from "./helpers/harness-tmprepo.ts";

/** A real shell runner that counts how many gate commands ran. */
function countingRunner(): { proc: ProcessRunnerPort; calls: () => number } {
  const inner = new ShellProcessRunner();
  let n = 0;
  const proc: ProcessRunnerPort = {
    runShell: (...args: Parameters<ProcessRunnerPort["runShell"]>) => {
      n += 1;
      return inner.runShell(...args);
    },
  };
  return { proc, calls: () => n };
}

const ruleDoc = (run: string): string =>
  jsonFrontmatterDoc(
    { id: "project/check", phase: "verify", severity: "blocking", gate: { type: "command", run, failureMessage: "check failed" } },
    "# Check",
  );

let repo: TmpRepo;
let restoreHome: () => void;
let leinaHome: string;
let runner: ReturnType<typeof countingRunner>;
let ports: { proc: ProcessRunnerPort; git: HarnessGit };

async function setUp(run: string): Promise<void> {
  await repo.write(".harness/rules/check.md", ruleDoc(run));
  repo.git("add", ".");
  repo.git("commit", "-m", "rule");
}

const retries = async (): Promise<number> =>
  JSON.parse(await fs.readFile(path.join(repo.root, ".harness", "state", "current", "retries.json"), "utf8")).count;

beforeEach(async () => {
  repo = await makeTmpRepo();
  leinaHome = path.join(repo.root, "..", `${path.basename(repo.root)}-home`);
  restoreHome = isolateLeinaHome(leinaHome);
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
  await repo.write(".leina/consent", "enabled");
  trustWorkspace(repo.root);
  repo.git("add", ".");
  repo.git("commit", "-m", "init");
  runner = countingRunner();
  ports = { proc: runner.proc, git: new HarnessGit() };
});

afterEach(async () => {
  restoreHome();
  await repo.cleanup();
  await fs.rm(leinaHome, { recursive: true, force: true });
});

describe("Stop gate reuses the last full verify", () => {
  it("(stop-reuse-1) an unchanged tree reuses a passing report — no gate runs again", async () => {
    await setUp("true");
    assert.equal((await decideStop(repo.root, ports, false)).kind, "allow");
    const ran = runner.calls();
    assert.ok(ran > 0, "the first stop runs the gates");
    assert.equal((await decideStop(repo.root, ports, false)).kind, "allow");
    assert.equal(runner.calls(), ran, "the second stop reuses the report");
  });

  it("(stop-reuse-2) a reused failure blocks with the same retry accounting and says it was reused", async () => {
    await setUp("exit 1");
    const first = await decideStop(repo.root, ports, false);
    assert.equal(first.kind, "block");
    assert.equal(await retries(), 1);
    const ran = runner.calls();

    const second = await decideStop(repo.root, ports, true);
    assert.equal(second.kind, "block");
    assert.equal(runner.calls(), ran, "nothing changed — the failing report is reused");
    assert.equal(await retries(), 2, "a reused failure counts like a fresh one");
    assert.match(second.kind === "block" ? second.reason : "", /reused instead of re-running every gate/);
    assert.match(second.kind === "block" ? second.reason : "", /leina harness verify/);

    assert.equal((await decideStop(repo.root, ports, true)).kind, "block");
    const atCap = await decideStop(repo.root, ports, true);
    assert.equal(atCap.kind, "yield", "the cap still bounds the loop");
    assert.match(atCap.kind === "yield" ? atCap.message : "", /the last verify \(working tree unchanged since\)/);
    assert.equal(await retries(), 0);
  });

  it("(stop-reuse-3) a changed file re-runs the gates", async () => {
    await setUp("exit 1");
    await decideStop(repo.root, ports, false);
    const ran = runner.calls();
    await repo.write("src/app.ts", "export const app = 2;\n");
    await decideStop(repo.root, ports, true);
    assert.ok(runner.calls() > ran, "the edit invalidates the report");
  });

  it("(stop-reuse-4) a commit re-runs the gates even when the changed set is empty again", async () => {
    await setUp("true");
    await decideStop(repo.root, ports, false);
    const ran = runner.calls();
    await repo.write("src/app.ts", "export const app = 3;\n");
    repo.git("commit", "-am", "edit");
    await decideStop(repo.root, ports, false);
    assert.ok(runner.calls() > ran, "HEAD moved — the report judged another tree");
  });

  it("(stop-reuse-5) a new contract or a user-layer config change re-runs the gates", async () => {
    await setUp("true");
    await decideStop(repo.root, ports, false);
    let ran = runner.calls();
    await saveContract(repo.root, { goal: "ship", scope: [], outOfScope: [], criteria: [], maxRetries: 3 });
    await decideStop(repo.root, ports, false);
    assert.ok(runner.calls() > ran, "the contract lives in excluded state — the inputs digest catches it");

    ran = runner.calls();
    await fs.mkdir(path.join(leinaHome, "harness"), { recursive: true });
    await fs.writeFile(
      path.join(leinaHome, "harness", "config.json"),
      JSON.stringify({ verify: { parallelism: 1 } }),
      "utf8",
    );
    await decideStop(repo.root, ports, false);
    assert.ok(runner.calls() > ran, "an out-of-tree config layer changes the inputs digest");
  });

  it("(stop-reuse-6) a partial run or a report without a reuse key is never reused", async () => {
    await setUp("true");
    const partial = await runVerify(repo.root, { ports, ruleId: "project/check" });
    assert.equal(partial.persisted, false);
    assert.equal(await reusePersistedVerify(repo.root, ports), undefined, "no full report yet");

    await writeFreshVerifyReport(repo.root, 0);
    assert.equal(await reusePersistedVerify(repo.root, ports), undefined, "a report from an older leina has no reuse key");

    await runVerify(repo.root, { ports });
    const reused = await reusePersistedVerify(repo.root, ports);
    assert.equal(reused?.reused, true);
    assert.equal(reused?.exitCode, 0);
    assert.equal(reused?.persisted, false);
  });
});
