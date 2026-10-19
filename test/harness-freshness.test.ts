// harness-freshness.test.ts — the commit guard's STALE-REPORT logic: a
// persisted verify report is trusted only while the working tree is the one it
// judged (content-based fingerprint, application/harness/freshness.ts).
//
//   read-only git commands (git status refreshing .git/index) → still fresh
//   mtime-only touch of a changed file                         → still fresh
//   task state / leina artifacts written                       → still fresh
//   commit after verify (fixed base)                           → still fresh
//   shell overwrite of a previously CLEAN tracked file         → stale
//   content change of an already-changed file                 → stale
//   new untracked file / deleted tracked file                  → stale
//   report without a fingerprint (older leina, hand-written)   → stale
//
// strict: stale → BLOCK ("verify again"); guided: stale reads as absent.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-freshness.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decideCursorShell, decidePreBash } from "../src/application/harness/hooks.ts";
import { runVerify } from "../src/application/harness/verify.ts";
import { saveContract } from "../src/application/harness/contract-io.ts";
import { fingerprintWorktree, worktreeMatches } from "../src/application/harness/freshness.ts";
import { trustWorkspace } from "../src/application/install/trust.ts";
import { ShellProcessRunner } from "../src/infrastructure/harness/exec.ts";
import { HarnessGit } from "../src/infrastructure/harness/git.ts";
import { isolateLeinaHome, makeTmpRepo, type TmpRepo } from "./helpers/harness-tmprepo.ts";

const git = new HarnessGit();
const ports = { proc: new ShellProcessRunner(), git };

const FIXTURE_RULES = {
  "harness/tests-pass": { enabled: false },
  "harness/typecheck": { enabled: false },
  "harness/lint-clean": { enabled: false },
  "harness/no-skipped-tests": { enabled: false },
  "harness/leina-graph-fresh": { enabled: false },
  "harness/leina-session-summary": { enabled: false },
};

const COMMIT = "git commit -am x";

let repo: TmpRepo;
let leinaHome: string;
let restoreHome: () => void;

async function setStrictness(strictness: "strict" | "guided"): Promise<void> {
  await repo.write(".harness/config.json", JSON.stringify({ strictness, rules: FIXTURE_RULES }));
  repo.git("add", ".harness/config.json");
  repo.git("commit", "-qm", `strictness ${strictness}`);
}

/**
 * Green full verify. `aged` backdates the report so it is older than every
 * file and git-internal mtime: freshness must come from content, not clocks.
 * Without it the report is the newest thing on disk — what an mtime heuristic
 * would wrongly call fresh after a shell overwrite.
 */
async function greenVerify(aged: boolean): Promise<void> {
  const outcome = await runVerify(repo.root, { ports });
  const notGreen = outcome.report.results.filter((r) => r.status !== "pass" && r.status !== "skip");
  assert.equal(outcome.exitCode, 0, JSON.stringify(notGreen));
  if (!aged) return;
  const report = path.join(repo.root, ".harness", "state", "current", "verify-report.json");
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(report, past, past);
}

async function blocked(command = COMMIT): Promise<string | undefined> {
  const decision = await decidePreBash(repo.root, command, git);
  return decision.block ? decision.message : undefined;
}

beforeEach(async () => {
  repo = await makeTmpRepo();
  leinaHome = await fs.mkdtemp(path.join(os.tmpdir(), "leina-freshness-home-"));
  restoreHome = isolateLeinaHome(leinaHome);
  // No .gitignore for .harness/state/ on purpose: task state shows up as
  // untracked and must still never stale a report.
  await repo.write("src/app.ts", "export const app = 1;\n");
  await repo.write("src/clean.ts", "export const clean = 1;\n");
  await repo.write(".leina/consent", "enabled");
  trustWorkspace(repo.root);
  repo.git("add", ".");
  repo.git("commit", "-qm", "init");
  await setStrictness("strict");
  // An in-progress change the green verify covers.
  await repo.write("src/app.ts", "export const app = 2;\n");
});

afterEach(async () => {
  restoreHome();
  await repo.cleanup();
  await fs.rm(leinaHome, { recursive: true, force: true });
});

describe("commit guard freshness — stays fresh", () => {
  it("(fresh-1) a read-only git status that rewrites .git/index does not stale a green report", async () => {
    await greenVerify(true);
    // Same content, new mtime: git status refreshes the index stat cache and rewrites .git/index.
    const now = new Date();
    await fs.utimes(path.join(repo.root, "src", "clean.ts"), now, now);
    const indexBefore = (await fs.stat(path.join(repo.root, ".git", "index"))).mtimeMs;
    repo.git("status");
    assert.ok((await fs.stat(path.join(repo.root, ".git", "index"))).mtimeMs >= indexBefore);
    assert.equal(await blocked(), undefined);
  });

  it("(fresh-2) touching an already-changed file without changing its content stays fresh", async () => {
    await greenVerify(true);
    const now = new Date();
    await fs.utimes(path.join(repo.root, "src", "app.ts"), now, now);
    assert.equal(await blocked(), undefined);
  });

  it("(fresh-3) task state and leina artifacts written after verify do not stale it", async () => {
    await greenVerify(true);
    await repo.write(".harness/state/current/plan.md", "# plan, edited after verify\n");
    await repo.write(".leina/session.memory-loaded", "memory-loaded\n");
    assert.equal(await blocked(), undefined);
  });

  it("(fresh-4) committing after verify keeps the report fresh for the push (contract base)", async () => {
    await saveContract(repo.root, {
      goal: "g",
      scope: [],
      outOfScope: [],
      criteria: [],
      maxRetries: 3,
      baseRef: (await git.currentHead(repo.root))!,
    });
    await greenVerify(true);
    repo.git("commit", "-qam", "the verified change");
    assert.equal(await blocked("git push origin main"), undefined);
  });
});

describe("commit guard freshness — goes stale", () => {
  it("(stale-1) a shell overwrite of a previously CLEAN tracked file (secret added) blocks the commit", async () => {
    await greenVerify(false);
    const keyId = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    await fs.writeFile(path.join(repo.root, "src", "clean.ts"), `export const k = "${keyId}";\n`);
    assert.match((await blocked()) ?? "", /verify report is stale/);
  });

  it("(stale-2) changing the content of an already-changed file blocks", async () => {
    await greenVerify(false);
    await repo.write("src/app.ts", "export const app = 3;\n");
    assert.match((await blocked()) ?? "", /stale/);
  });

  it("(stale-3) a new untracked file blocks", async () => {
    await greenVerify(false);
    await repo.write("src/new.ts", "export const n = 1;\n");
    assert.match((await blocked()) ?? "", /stale/);
  });

  it("(stale-4) deleting a tracked file blocks", async () => {
    await greenVerify(false);
    await fs.rm(path.join(repo.root, "src", "clean.ts"));
    assert.match((await blocked()) ?? "", /stale/);
  });

  it("(stale-5) a report without a fingerprint cannot vouch for any tree", async () => {
    await repo.write(
      ".harness/state/current/verify-report.json",
      JSON.stringify({ summary: { blockingFailures: 0 } }),
    );
    assert.match((await blocked()) ?? "", /stale/);
  });

  it("(stale-6) guided mode: a stale report reads as absent (allowed), a fresh red one blocks", async () => {
    await setStrictness("guided");
    await greenVerify(false);
    await repo.write("src/app.ts", "export const app = 3;\n");
    assert.equal(await blocked(), undefined, "stale green → absent → guided allows");

    await repo.write(
      ".harness/state/current/verify-report.json",
      JSON.stringify({
        summary: { blockingFailures: 2 },
        worktree: await fingerprintWorktree(repo.root, git, undefined),
      }),
    );
    assert.match((await blocked()) ?? "", /2 blocking gate\(s\) are failing/);
  });

  it("(stale-7) the Cursor shell guard applies the same freshness rule", async () => {
    await setStrictness("guided");
    await repo.write(
      ".harness/state/current/verify-report.json",
      JSON.stringify({ summary: { blockingFailures: 1 }, worktree: await fingerprintWorktree(repo.root, git, undefined) }),
    );
    assert.equal((await decideCursorShell(repo.root, COMMIT, git)).permission, "deny");
    await repo.write("src/app.ts", "export const app = 3;\n");
    assert.equal((await decideCursorShell(repo.root, COMMIT, git)).permission, "allow", "stale red reads as absent");
  });
});

describe("worktree fingerprint", () => {
  it("(fp-1) round-trips, ignores excluded paths and rejects malformed records", async () => {
    const recorded = await fingerprintWorktree(repo.root, git, undefined);
    assert.ok(recorded);
    assert.deepEqual(recorded.files, ["src/app.ts"]);
    assert.ok(recorded.identities["src/app.ts"]?.sha256);
    assert.equal(await worktreeMatches(repo.root, git, recorded), true);
    for (const bad of [undefined, null, {}, { version: 1, files: "x", identities: {} }, { ...recorded, version: 99 }]) {
      assert.equal(await worktreeMatches(repo.root, git, bad), false, JSON.stringify(bad));
    }
    assert.equal(
      await worktreeMatches(repo.root, git, { ...recorded, identities: { "src/app.ts": null } }),
      false,
    );
  });
});
