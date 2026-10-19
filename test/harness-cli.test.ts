// harness-cli.test.ts — e2e of the `leina harness <sub>` command group, driven
// in-process through handleHarness over throwaway git repos: contract
// lifecycle (new → verify red → check criteria → verify green → end), sync
// idempotency + --check drift, list, and the `hook` transport dispatch.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-cli.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { handleHarness, runHarnessHookEvent } from "../src/cli/handlers/harness.ts";
import { trustWorkspace } from "../src/application/install/trust.ts";
import {
  isolateLeinaHome,
  jsonFrontmatterDoc,
  makeTmpRepo,
  type TmpRepo,
} from "./helpers/harness-tmprepo.ts";

// Builtin rules whose gates need the project toolchain (npm, leina, git
// content scans) — disabled in the fixtures, mirroring harness-verify.test.ts.
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

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Drive the handler in-process from the repo root, capturing IO + exit code. */
async function run(args: string[]): Promise<RunResult> {
  const prevCwd = process.cwd();
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  process.chdir(repo.root);
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    outChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    await handleHarness(args);
    const code = typeof process.exitCode === "number" ? process.exitCode : 0;
    return { stdout: outChunks.join(""), stderr: errChunks.join(""), code };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.chdir(prevCwd);
    process.exitCode = prevExit;
  }
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(repo.root, rel), "utf8");
}

async function exists(rel: string): Promise<boolean> {
  return fs.access(path.join(repo.root, rel)).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// contract lifecycle + verify red→green
// ---------------------------------------------------------------------------

describe("leina harness contract + verify (e2e)", () => {
  it("new seeds contract.json + checklist.md with the git base ref", async () => {
    const res = await run([
      "contract", "new",
      "--goal", "add the thing",
      "--type", "bugfix",
      "--scope", "src/**",
      "--out-of-scope", "docs/**",
      "--criterion", "c1",
      "--criterion", "c2",
      "--max-retries", "5",
    ]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /contract created/);

    const contract = JSON.parse(await read(".harness/state/current/contract.json"));
    assert.equal(contract.goal, "add the thing");
    assert.equal(contract.taskType, "bugfix");
    assert.deepEqual(contract.scope, ["src/**"]);
    assert.deepEqual(contract.outOfScope, ["docs/**"]);
    assert.equal(contract.criteria.length, 2);
    assert.equal(contract.maxRetries, 5);
    assert.match(contract.baseRef, /^[0-9a-f]{40}$/);

    const checklist = await read(".harness/state/current/checklist.md");
    assert.match(checklist, /- \[ \] c1/);
    assert.match(checklist, /- \[ \] c2/);
  });

  it("refuses a second contract while one is active (exit 2)", async () => {
    await run(["contract", "new", "--goal", "first"]);
    const res = await run(["contract", "new", "--goal", "second"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /already active/);
  });

  it("show prints the active contract; exit 1 when none", async () => {
    const none = await run(["contract", "show"]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no active contract/);

    await run(["contract", "new", "--goal", "visible goal"]);
    const res = await run(["contract", "show"]);
    assert.equal(res.code, 0);
    assert.match(res.stderr, /goal: visible goal/);
  });

  it("verify is red with unchecked criteria, green after checking them, and end archives", async () => {
    await run(["contract", "new", "--goal", "g", "--scope", "src/**", "--criterion", "c1"]);

    const red = await run(["verify", "--json"]);
    assert.equal(red.code, 1, red.stderr);
    const redReport = JSON.parse(red.stdout);
    const checklist = redReport.results.find((r: { ruleId: string }) => r.ruleId === "harness/criteria-checklist");
    assert.equal(checklist.status, "fail");

    const edit = await run(["contract", "edit", "--check-criterion", "c1"]);
    assert.equal(edit.code, 0, edit.stderr);
    assert.match(await read(".harness/state/current/checklist.md"), /- \[x\] c1/);

    const green = await run(["verify"]);
    assert.equal(green.code, 0, green.stderr);
    assert.ok(await exists(".harness/state/current/verify-report.json"));

    const end = await run(["contract", "end"]);
    assert.equal(end.code, 0);
    assert.match(end.stderr, /state archived/);
    assert.equal(await exists(".harness/state/current/contract.json"), false);
    const history = await fs.readdir(path.join(repo.root, ".harness", "state", "history"));
    assert.equal(history.length, 1);
  });

  it("contract edit widens scope explicitly and rejects unknown criteria", async () => {
    await run(["contract", "new", "--goal", "g", "--scope", "src/**"]);
    const widen = await run(["contract", "edit", "--add-scope", "lib/**"]);
    assert.equal(widen.code, 0);
    const contract = JSON.parse(await read(".harness/state/current/contract.json"));
    assert.deepEqual(contract.scope, ["src/**", "lib/**"]);

    const bad = await run(["contract", "edit", "--check-criterion", "nope"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /no criterion with text/);
  });

  it("rejects an unknown task type (exit 2)", async () => {
    const res = await run(["contract", "new", "--goal", "g", "--type", "yolo"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /unknown task type/);
  });
});

// ---------------------------------------------------------------------------
// sync — idempotency + --check drift
// ---------------------------------------------------------------------------

describe("leina harness sync (e2e)", () => {
  it("generates artifacts, is idempotent, and --check reports drift", async () => {
    // Evidence-based detection: sync targets AGENTS.md only when it exists.
    await repo.write("AGENTS.md", "");
    const first = await run(["sync"]);
    assert.equal(first.code, 0, first.stderr);
    assert.ok(await exists("AGENTS.md"), "agentsmd baseline artifact");
    assert.ok(await exists(".harness/harness.lock.json"));
    const agents = await read("AGENTS.md");
    assert.match(agents, /harness:begin/);

    const second = await run(["sync"]);
    assert.equal(second.code, 0);
    assert.equal(await read("AGENTS.md"), agents, "second sync is byte-identical");
    assert.ok(!second.stderr.includes('created'), "no re-created artifacts on second run");

    const clean = await run(["sync", "--check"]);
    assert.equal(clean.code, 0);
    assert.match(clean.stderr, /artifacts up to date/);

    // Losing the block (file emptied) is drift; the file itself remains the
    // platform evidence, so the adapter is still selected.
    await repo.write("AGENTS.md", "");
    const drift = await run(["sync", "--check"]);
    assert.equal(drift.code, 1);
    assert.match(drift.stderr, /stale/);
    assert.equal(await read("AGENTS.md"), "", "--check never writes");
  });

  it("--platforms restricts the adapter set and warns on unknown ids", async () => {
    const res = await run(["sync", "--platforms", "agentsmd,doesnotexist"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /no adapter implemented for platform "doesnotexist"/);
    assert.ok(await exists("AGENTS.md"));
    assert.equal(await exists("CLAUDE.md"), false, "claude-code adapter not selected");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("leina harness list (e2e)", () => {
  it("lists resolved rules with layer/phase and honors --json", async () => {
    const res = await run(["list"]);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /harness\/tests-pass/);
    assert.match(res.stdout, /builtin/);
    assert.match(res.stdout, /rule\(s\)/);

    const json = await run(["list", "--json"]);
    const rules = JSON.parse(json.stdout);
    assert.ok(Array.isArray(rules) && rules.length > 0);
    const testsPass = rules.find((r: { id: string }) => r.id === "harness/tests-pass");
    assert.equal(testsPass.enabled, false, "fixture config override applies");
    assert.equal(testsPass.layer, "builtin");

    const intakeOnly = await run(["list", "--phase", "intake", "--json"]);
    for (const rule of JSON.parse(intakeOnly.stdout)) assert.equal(rule.phase, "intake");
  });
});

// ---------------------------------------------------------------------------
// hook transport (runHarnessHookEvent — same dispatch as `leina harness hook`)
// ---------------------------------------------------------------------------

describe("leina harness hook (transport)", () => {
  async function runHook(event: string, payload: unknown): Promise<RunResult> {
    const prevExit = process.exitCode;
    process.exitCode = undefined;
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
      await runHarnessHookEvent(event, JSON.stringify(payload), repo.root);
      const code = typeof process.exitCode === "number" ? process.exitCode : 0;
      return { stdout: outChunks.join(""), stderr: errChunks.join(""), code };
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      process.exitCode = prevExit;
    }
  }

  it("session-start prints contract status + intake rules on stdout", async () => {
    await run(["contract", "new", "--goal", "hooked goal", "--scope", "src/**"]);
    const res = await runHook("session-start", {});
    assert.equal(res.code, 0);
    assert.match(res.stdout, /governed by a harness/);
    assert.match(res.stdout, /hooked goal/);
    assert.match(res.stdout, /harness\/contract-interview/);
  });

  it("pre-edit blocks out-of-scope files with exit 2 and allows in-scope ones", async () => {
    await run(["contract", "new", "--goal", "g", "--scope", "src/**"]);

    const blocked = await runHook("pre-edit", { tool_input: { file_path: "docs/readme.md" } });
    assert.equal(blocked.code, 2);
    assert.match(blocked.stderr, /BLOCKED: docs\/readme\.md is outside the declared contract scope/);

    const allowed = await runHook("pre-edit", { tool_input: { file_path: "src/app.ts" } });
    assert.equal(allowed.code, 0);
    assert.equal(allowed.stderr, "");
  });

  it("pre-bash blocks git commit while the persisted report has blocking failures", async () => {
    await repo.write(
      ".harness/state/current/verify-report.json",
      JSON.stringify({ summary: { blockingFailures: 2 } }),
    );
    const blocked = await runHook("pre-bash", { tool_input: { command: "git commit -m done" } });
    assert.equal(blocked.code, 2);
    assert.match(blocked.stderr, /2 blocking gate\(s\) are failing/);

    const benign = await runHook("pre-bash", { tool_input: { command: "ls -la" } });
    assert.equal(benign.code, 0);
    assert.equal(benign.stderr, "");
  });

  it("cursor-shell answers the Cursor permission protocol on stdout", async () => {
    await repo.write(
      ".harness/state/current/verify-report.json",
      JSON.stringify({ summary: { blockingFailures: 1 } }),
    );
    const deny = await runHook("cursor-shell", { command: "git push origin main" });
    assert.equal(JSON.parse(deny.stdout).permission, "deny");

    const allow = await runHook("cursor-shell", { command: "npm test" });
    assert.equal(JSON.parse(allow.stdout).permission, "allow");
  });

  it("stop blocks with a machine decision while gates fail, then yields at the retry cap", async () => {
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
    await run(["contract", "new", "--goal", "g", "--max-retries", "1"]);

    const first = await runHook("stop", {});
    assert.equal(first.code, 0);
    const decision = JSON.parse(first.stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /blocking gate\(s\) failing/);

    const second = await runHook("stop", {});
    assert.equal(second.stdout, "", "retry cap reached — no block decision");
    assert.match(second.stderr, /allowing stop so a human can look/);
  });

  it("rejects unknown hook events with exit 2", async () => {
    const res = await runHook("no-such-event", {});
    assert.equal(res.code, 2);
    assert.match(res.stderr, /unknown hook event/);
  });
});

// ---------------------------------------------------------------------------
// group help
// ---------------------------------------------------------------------------

describe("leina harness (group)", () => {
  it("prints the group help without a sub-command", async () => {
    const res = await run([]);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /leina harness — rules \+ executable gates/);
    assert.match(res.stdout, /contract new/);
  });

  it("unknown sub-command → help + exit 1", async () => {
    const res = await run(["frobnicate"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /unknown harness sub-command/);
  });
});
