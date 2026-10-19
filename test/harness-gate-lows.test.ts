// harness-gate-lows.test.ts — hardening fixes around the gate engine:
//   L1  ReDoS: rule-supplied regexes (expectStdoutMatch, forbidAdded,
//       contentMatch/contentNotMatch) run inside a vm hard timeout — a
//       catastrophic pattern cannot hang verify.
//   L2  Atomic co-owned writes: writeFileAtomic never leaves a truncated
//       CLAUDE.md/opencode.json behind and preserves permissions.
//   L3  maxRetries cap: a hostile contract.json cannot extend the Stop-block
//       loop unboundedly.
//   H5  no-secrets: unquoted assignments and provider-prefixed tokens are
//       detected, and the gate output never re-emits the matched secret.
//
// Secret-looking fixtures are ASSEMBLED from fragments so this file never
// contains a credential-shaped literal (the no-secrets gate scans added lines
// of this repo's own diffs too).
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-gate-lows.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { matchLinesBounded } from "../src/application/harness/gates/engine.ts";
import { runCommandGate } from "../src/application/harness/gates/command.ts";
import { runDiffContentGate } from "../src/application/harness/gates/diff-content.ts";
import { runFileGate } from "../src/application/harness/gates/file.ts";
import { writeFileAtomic } from "../src/application/harness/adapters/writer.ts";
import { decideStop } from "../src/application/harness/hooks.ts";
import { saveContract } from "../src/application/harness/contract-io.ts";
import { builtinRulesDir, parseRuleFile } from "../src/application/harness/loader.ts";
import { gatesOf, type DiffContentGate } from "../src/domain/harness/model.ts";
import type { GitPort } from "../src/domain/harness/ports.ts";
import type { GateContext } from "../src/application/harness/gates/types.ts";
import { ShellProcessRunner } from "../src/infrastructure/harness/exec.ts";
import { isolateLeinaHome, makeTmpRepo } from "./helpers/harness-tmprepo.ts";

const proc = new ShellProcessRunner();

/** Input that makes `(a+)+$`-style patterns backtrack forever. */
const REDOS_INPUT = `${"a".repeat(64)}!`;
const REDOS_PATTERN = "^(a+)+$";

/** GitPort stub: diff-content only calls diffUnified. */
function stubGit(diff: string): GitPort {
  return {
    isRepo: async () => true,
    currentHead: async () => undefined,
    mergeBase: async () => undefined,
    changedFiles: async () => [],
    diffUnified: async () => diff,
  };
}

function stubCtx(root: string, git: GitPort): GateContext {
  return {
    repoRoot: root,
    changedFiles: [],
    defaultTimeoutMs: 10_000,
    defaultBranch: "main",
    ports: { proc, git },
  };
}

function syntheticDiff(file: string, lines: string[]): string {
  return (
    `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n` +
    `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`
  );
}

// ---------------------------------------------------------------------------
// L1 — bounded regex evaluation
// ---------------------------------------------------------------------------

describe("L1: bounded regex evaluation (ReDoS)", () => {
  it("a catastrophic pattern is cut off by the vm timeout instead of hanging", () => {
    const started = Date.now();
    const res = matchLinesBounded(REDOS_PATTERN, "", [REDOS_INPUT], 150);
    const elapsed = Date.now() - started;
    assert.ok("error" in res, "expected an error result");
    assert.match(res.error, /timed out/);
    assert.ok(elapsed < 3000, `evaluation must be interrupted quickly (took ${elapsed}ms)`);
  });

  it("an invalid pattern maps to an error, a sane pattern matches with a masked excerpt", () => {
    const invalid = matchLinesBounded("(", "", ["x"]);
    assert.ok("error" in invalid);
    assert.match(invalid.error, /Invalid regular expression/);

    const sane = matchLinesBounded("b(o)om", "i", ["quiet line", "a BOOM here"]);
    assert.ok("matches" in sane);
    assert.deepEqual(sane.matches, [{ index: 1, masked: "BOO***" }]);
  });

  it("command gate: catastrophic expectStdoutMatch errors within the gate timeout", async () => {
    const repo = await makeTmpRepo(false);
    try {
      const started = Date.now();
      const r = await runCommandGate(
        {
          type: "command",
          run: `echo ${REDOS_INPUT}`,
          expectExitCode: 0,
          expectStdoutMatch: REDOS_PATTERN,
          timeoutMs: 400,
        },
        stubCtx(repo.root, stubGit("")),
      );
      const elapsed = Date.now() - started;
      assert.equal(r.status, "error");
      assert.match(r.detail, /timed out/);
      assert.ok(elapsed < 3000, `gate must not hang (took ${elapsed}ms)`);
    } finally {
      await repo.cleanup();
    }
  });

  it("diff-content gate: catastrophic forbidAdded errors within the gate timeout", async () => {
    const repo = await makeTmpRepo(false);
    try {
      const started = Date.now();
      const r = await runDiffContentGate(
        { type: "diff-content", forbidAdded: "(a+)+$", ignoreCase: false, timeoutMs: 400 },
        stubCtx(repo.root, stubGit(syntheticDiff("src/x.ts", [REDOS_INPUT]))),
      );
      const elapsed = Date.now() - started;
      assert.equal(r.status, "error");
      assert.match(r.detail, /timed out/);
      assert.ok(elapsed < 3000, `gate must not hang (took ${elapsed}ms)`);
    } finally {
      await repo.cleanup();
    }
  });

  it("(file-redos-1) file gate: catastrophic contentMatch / contentNotMatch error within the gate timeout", async () => {
    // The file gate is declarative, so it runs even in an untrusted workspace —
    // its patterns must be as bounded as the executable gates' ones.
    const repo = await makeTmpRepo(false);
    try {
      await repo.write("notes.md", `header\n${REDOS_INPUT}\n`);
      for (const key of ["contentMatch", "contentNotMatch"] as const) {
        const started = Date.now();
        const r = await runFileGate(
          { type: "file", path: "notes.md", exists: true, [key]: REDOS_PATTERN, timeoutMs: 400 },
          stubCtx(repo.root, stubGit("")),
        );
        const elapsed = Date.now() - started;
        assert.equal(r.status, "error", key);
        assert.match(r.detail, new RegExp(`${key} regex evaluation failed: .*timed out`), key);
        assert.ok(elapsed < 3000, `${key}: gate must not hang (took ${elapsed}ms)`);
      }
    } finally {
      await repo.cleanup();
    }
  });

  it("(file-redos-2) file gate keeps multiline semantics and reports invalid patterns", async () => {
    const repo = await makeTmpRepo(false);
    try {
      await repo.write("plan.md", "# Plan\n\n## Steps\n- one\n");
      const ctx = stubCtx(repo.root, stubGit(""));
      const run = (gate: Partial<{ contentMatch: string; contentNotMatch: string }>) =>
        runFileGate({ type: "file", path: "plan.md", exists: true, ...gate }, ctx);
      assert.equal((await run({ contentMatch: "^## Steps$" })).status, "pass", "^/$ match per line");
      assert.equal((await run({ contentMatch: "Plan\\n\\n## Steps" })).status, "pass", "spans lines");
      assert.equal((await run({ contentMatch: "^- two$" })).status, "fail");
      assert.equal((await run({ contentNotMatch: "^- one$" })).status, "fail");
      assert.equal((await run({ contentNotMatch: "^TODO" })).status, "pass");
      const invalid = await run({ contentMatch: "(" });
      assert.equal(invalid.status, "error");
      assert.match(invalid.detail, /invalid contentMatch regex/);
    } finally {
      await repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// L2 — atomic co-owned writes
// ---------------------------------------------------------------------------

describe("L2: writeFileAtomic", () => {
  it("writes content and leaves no temp file behind", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "leina-atomic-"));
    try {
      const target = path.join(dir, "CLAUDE.md");
      await writeFileAtomic(target, "first\n");
      await writeFileAtomic(target, "second\n");
      assert.equal(await fs.readFile(target, "utf8"), "second\n");
      const leftovers = (await fs.readdir(dir)).filter((f) => f.includes("harness-tmp"));
      assert.deepEqual(leftovers, []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves the target's existing permissions and honors an explicit mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "leina-atomic-"));
    try {
      const secretive = path.join(dir, "settings.json");
      await fs.writeFile(secretive, "{}\n", { mode: 0o600 });
      await writeFileAtomic(secretive, '{"v":1}\n');
      assert.equal((await fs.stat(secretive)).mode & 0o777, 0o600);

      const script = path.join(dir, "hook.sh");
      await writeFileAtomic(script, "#!/bin/sh\n", 0o755);
      assert.equal((await fs.stat(script)).mode & 0o777, 0o755);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "a failed write leaves the original file intact (no truncation)",
    { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "leina-atomic-"));
      try {
        const target = path.join(dir, "opencode.json");
        await fs.writeFile(target, '{"original":true}\n', "utf8");
        await fs.chmod(dir, 0o555); // temp-file creation in the same dir must fail
        await assert.rejects(writeFileAtomic(target, '{"clobbered":true}\n'));
        await fs.chmod(dir, 0o755);
        assert.equal(await fs.readFile(target, "utf8"), '{"original":true}\n');
        const leftovers = (await fs.readdir(dir)).filter((f) => f.includes("harness-tmp"));
        assert.deepEqual(leftovers, []);
      } finally {
        await fs.chmod(dir, 0o755).catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// L3 — maxRetries cap
// ---------------------------------------------------------------------------

describe("L3: maxRetries cap in the stop gate", () => {
  it("a huge contract maxRetries is capped — the loop yields at the ceiling, not at 9999", async () => {
    const repo = await makeTmpRepo(false);
    const restoreHome = isolateLeinaHome(path.join(repo.root, "no-user-config"));
    try {
      await saveContract(repo.root, {
        goal: "cap me",
        scope: [],
        outOfScope: [],
        criteria: [],
        maxRetries: 9999,
      });
      await repo.write(".harness/state/current/retries.json", JSON.stringify({ count: 10 }));

      // Every stop runs a fresh verify: commands "fail" instantly and, outside
      // git, the builtin no-secrets gate errors — the chain is still red.
      const failingProc = { runShell: async () => ({ exitCode: 1, stdout: "", all: "", timedOut: false }) };
      const ports = { proc: failingProc, git: { ...stubGit(""), isRepo: async () => false, changedFiles: async () => null } };
      const decision = await decideStop(repo.root, ports, true);
      assert.equal(decision.kind, "yield");
      const message = decision.kind === "yield" ? decision.message : "";
      assert.match(message, /after 10 attempts/);
      assert.ok(!message.includes("9999"), "the declared (uncapped) value must not drive the loop");
    } finally {
      restoreHome();
      await repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// H5 — no-secrets: unquoted values, provider prefixes, masked output
// ---------------------------------------------------------------------------

describe("no-secrets rule + diff-content masking", () => {
  const j = (...parts: string[]) => parts.join("");

  async function loadNoSecretsGate(): Promise<DiffContentGate> {
    const parsed = await parseRuleFile(path.join(builtinRulesDir(), "no-secrets.md"), "builtin");
    if ("error" in parsed) assert.fail(parsed.error);
    const gate = gatesOf(parsed.rule)[0];
    if (gate?.type !== "diff-content") assert.fail(`expected a diff-content gate, got ${gate?.type}`);
    return gate;
  }

  it("detects unquoted api_key assignments and provider-prefixed tokens", async () => {
    const gate = await loadNoSecretsGate();
    const re = new RegExp(gate.forbidAdded, gate.ignoreCase ? "i" : "");

    const positives = [
      j("api_key=", "sk-", "abc123def456ghi789jkl"), // the classic unquoted .env leak
      j("api_key: ", "sk-", "abc123def456ghi789jkl"),
      j("DB_PASSWORD=", "hunter2hunter2hunter2"),
      j("ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZab1234"),
      j("xoxb-", "123456789012-abcdefghijk"),
      j("AIza", "SyA1234567890abcdefghijklmnopqr"),
      j("sk_live_", "4eC39HqLyjWDarjtT1zdp7dc"),
      j("Authorization: Bearer ", "t0ken4b5c6d7e8f9a0b1c2d3e4f5"),
      j("postgres://admin:", "s3cretpw", "@db.internal:5432/app"),
    ];
    for (const p of positives) assert.ok(re.test(p), `should detect: ${p.slice(0, 12)}…`);

    const negatives = [
      "const token = requestAccessToken;",
      "secret: process.env.APP_SECRET,",
      "token = jwt.sign(payload, opts)",
      'placeholder: "YOUR_API_KEY"',
      "redis://localhost:6379/0",
      "export const app = 1;",
    ];
    for (const n of negatives) assert.ok(!re.test(n), `false positive on: ${n}`);
  });

  it("gate output reports location + masked prefix, never the secret itself", async () => {
    const gate = await loadNoSecretsGate();
    const token = j("sk-", "abc123def456ghi789jkl");
    const secretLine = j("api_key=", token);
    const repo = await makeTmpRepo(false);
    try {
      const r = await runDiffContentGate(
        gate,
        stubCtx(repo.root, stubGit(syntheticDiff("src/config.ts", ["export const x = 1;", secretLine]))),
      );
      assert.equal(r.status, "fail");
      assert.ok(r.output?.includes("src/config.ts:2"), r.output);
      assert.ok(r.output?.includes("api***"), r.output);
      assert.ok(!r.output?.includes(token), "the secret must never be re-emitted");
      assert.ok(!r.detail.includes(token));
    } finally {
      await repo.cleanup();
    }
  });
});
