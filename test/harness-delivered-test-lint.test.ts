// test/harness-delivered-test-lint.test.ts — the builtin rule that flags tests tied to this checkout.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-delivered-test-lint.test.ts

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runDiffContentGate } from "../src/application/harness/gates/diff-content.ts";
import { builtinRulesDir, parseRuleFile } from "../src/application/harness/loader.ts";
import type { GateContext } from "../src/application/harness/gates/types.ts";
import type { DiffContentGate, Rule } from "../src/domain/harness/model.ts";
import { ShellProcessRunner } from "../src/infrastructure/harness/exec.ts";
import { HarnessGit } from "../src/infrastructure/harness/git.ts";
import { makeTmpRepo, type TmpRepo } from "./helpers/harness-tmprepo.ts";

const ports = { proc: new ShellProcessRunner(), git: new HarnessGit() };
let repo: TmpRepo;
let rule: Rule;

const ctx = (): GateContext => ({
  repoRoot: repo.root,
  changedFiles: [],
  defaultTimeoutMs: 10_000,
  defaultBranch: "main",
  ports,
});

before(async () => {
  const parsed = await parseRuleFile(path.join(builtinRulesDir(), "delivered-test-lint.md"), "builtin");
  assert.ok("rule" in parsed, "error" in parsed ? parsed.error : "");
  rule = parsed.rule;
  repo = await makeTmpRepo();
  await repo.write("README.md", "base\n");
  repo.git("add", "README.md");
  repo.git("commit", "-qm", "base");
});

after(async () => {
  await repo.cleanup();
});

const gate = (i: number): DiffContentGate => (rule.gate as DiffContentGate[])[i]!;

// Writes `line` into a fresh test file and runs the rule's gate `i` over the working tree.
async function check(i: number, line: string): Promise<string> {
  await repo.write("test/sample.test.ts", `${line}\n`);
  try {
    return (await runDiffContentGate(gate(i), ctx())).status;
  } finally {
    repo.git("clean", "-fq", "--", "test/sample.test.ts");
  }
}

describe("harness/delivered-test-lint", () => {
  it("is an advisory verify rule with two diff-content gates over test files", () => {
    assert.equal(rule.severity, "advisory");
    assert.equal(rule.phase, "verify");
    assert.ok(Array.isArray(rule.gate) && rule.gate.length === 2);
    for (const g of rule.gate as DiffContentGate[]) assert.deepEqual(g.paths, ["*test*", "*spec*"]);
  });

  it("flags git history read at a literal commit sha", async () => {
    for (const line of [
      'execFileSync("git", ["show", "1a2b3c4:src/a.ts"]);',
      "git log --oneline 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e",
      'run("git checkout -q a1b2c3d")',
    ]) {
      assert.equal(await check(0, line), "fail", line);
    }
  });

  it("lets relative revisions and plain hex words pass", async () => {
    for (const line of [
      'execFileSync("git", ["log", "-1", "HEAD~1"]);',
      'git("diff", "--cached")',
      'const color = "deadbeef";',
      'git("show", "HEAD:src/a.ts")',
    ]) {
      assert.equal(await check(0, line), "pass", line);
    }
  });

  it("flags a temp dir created inside the repository", async () => {
    for (const line of [
      'const dir = mkdtempSync("tmp-");',
      'const dir = mkdtempSync(join(__dirname, "fixture-"));',
      'const dir = mkdtempSync(path.join(process.cwd(), "x-"));',
      'const dir = mkdtempSync(join(".", "x-"));',
      'd = tempfile.mkdtemp(dir=".")',
      'dir, _ := os.MkdirTemp(".", "x")',
      "TMPDIR=. npm test",
      "env: { TMPDIR: process.cwd() },",
    ]) {
      assert.equal(await check(1, line), "fail", line);
    }
  });

  it("lets the OS temp dir idioms pass", async () => {
    for (const line of [
      'const dir = mkdtempSync(join(tmpdir(), "leina-"));',
      "const dir = mkdtempSync(`${tmpdir()}/x-`);",
      'const dir = mkdtempSync("/tmp/x-");',
      'dir, _ := os.MkdirTemp("", "x")',
      "dir := t.TempDir()",
      "env: { TMPDIR: tmpdir() },",
    ]) {
      assert.equal(await check(1, line), "pass", line);
    }
  });
});
