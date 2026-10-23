// harness-destructive-guard.test.ts — destructiveCommand (shell-words.ts), the
// decision decideDestructiveBash, and its wiring on every shell path: the
// guided no-contract seal, the contract path and Cursor.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-destructive-guard.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { destructiveCommand, gitCommitOrPush, shellWriteTargets } from "../src/application/harness/shell-words.ts";
import { decideCursorShell, decideDestructiveBash, decidePreBash } from "../src/application/harness/hooks.ts";
import { runHarnessHookEvent } from "../src/cli/handlers/harness.ts";
import { runHarnessAgentGate } from "../src/cli/agent-gate.ts";
import { saveContract, writeChecklist } from "../src/application/harness/contract-io.ts";
import { trustWorkspace } from "../src/application/install/trust.ts";
import { HarnessGit } from "../src/infrastructure/harness/git.ts";
import { isolateLeinaHome, makeTmpRepo, type TmpRepo } from "./helpers/harness-tmprepo.ts";

process.env.LEINA_DISABLE_AUTOBUILD = "1";

const CTX = { cwd: "/work/proj/repo", home: "/home/u" };

const BLOCKED: [string, string][] = [
  ["rm -rf /", "rm -r /"],
  ["rm -rf /*", "rm -r /*"],
  ["rm -rf /usr", "rm -r /usr"],
  ["rm -rf /home/", "rm -r /home/"],
  ["rm -rf /tmp", "rm -r /tmp"],
  ["rm -r ~", "rm -r ~"],
  ["rm -rf ~/", "rm -r ~/"],
  ["rm -rf $HOME", "rm -r $HOME"],
  ["rm -rf ${HOME}/*", "rm -r ${HOME}/*"],
  ["rm -rf /home/u", "rm -r /home/u"],
  ["rm -Rf .", "rm -r ."],
  ["rm -fR ./", "rm -r ./"],
  ["rm --recursive --force .", "rm -r ."],
  ["rm -rf ..", "rm -r .."],
  ["rm -rf ../..", "rm -r ../.."],
  ["rm -rf *", "rm -r *"],
  ["rm -rf .*", "rm -r .*"],
  ["rm -rf ./*", "rm -r ./*"],
  ["rm -rf /work/proj/repo", "rm -r /work/proj/repo"],
  ["rm -rf /work/proj", "rm -r /work/proj"],
  ["rm -rf .git", "rm -r .git"],
  ["rm -rf /work/proj/repo/.git", "rm -r /work/proj/repo/.git"],
  ["rm -rf -- .", "rm -r ."],
  ["sudo rm -rf /", "rm -r /"],
  ["\\rm -rf ~", "rm -r ~"],
  ["/bin/rm -rf .", "rm -r ."],
  ["cd .. && rm -rf repo", "rm -r repo"],
  ["cd src && rm -rf ..", "rm -r .."],
  ["ls && rm -rf ~", "rm -r ~"],
  ["sh -c 'rm -rf ~'", "rm -r ~"],
  ["bash -lc \"git reset --hard\"", "git reset --hard"],
  ["eval \"git push -f\"", "git push --force"],
  ["echo $(rm -rf ~)", "rm -r ~"],
  ["echo `rm -rf ~`", "rm -r ~"],
  ["git reset --hard", "git reset --hard"],
  ["git reset --hard HEAD~3", "git reset --hard"],
  ["git -C x reset --hard", "git reset --hard"],
  ["docker exec x git reset --hard", "git reset --hard"],
  ["git clean -f", "git clean -f"],
  ["git clean -fd", "git clean -f"],
  ["git clean -xdf", "git clean -f"],
  ["git clean --force", "git clean -f"],
  ["git push --force", "git push --force"],
  ["git push -f origin main", "git push --force"],
  ["git push -uf origin main", "git push --force"],
  ["git push origin +main", "git push --force"],
  ["git push origin +HEAD:main", "git push --force"],
  ["git branch -D x", "git branch -D"],
  ["git branch -dD x", "git branch -D"],
  ["git branch -d -f x", "git branch -D"],
  ["git branch --delete --force x", "git branch -D"],
  ["psql -c \"DROP TABLE users\"", "SQL DROP"],
  ["psql -c \"drop database prod\"", "SQL DROP"],
  ["sqlite3 db \"DROP SCHEMA x\"", "SQL DROP"],
  ["docker exec db psql -U u -c 'TRUNCATE users'", "SQL TRUNCATE"],
  ["mysql -e \"DELETE FROM users\"", "SQL DELETE without WHERE"],
  ["sqlite3 db \"DELETE FROM t; SELECT 1\"", "SQL DELETE without WHERE"],
  ["duckdb x.db \"SELECT 1; DELETE FROM t\"", "SQL DELETE without WHERE"],
  // value-taking prefix flags (B1)
  ["sudo -u root rm -rf /", "rm -r /"],
  ["doas -u root rm -rf /", "rm -r /"],
  ["env -u FOO rm -rf ~", "rm -r ~"],
  ["nice -n 10 rm -rf ~", "rm -r ~"],
  ["sudo -u root sh -c 'rm -rf /'", "rm -r /"],
  ["sudo --user=root rm -rf /", "rm -r /"],
  ["env -S 'rm -rf ~'", "rm -r ~"],
  ["timeout 5 rm -rf ~", "rm -r ~"],
  ["timeout -s KILL 5 rm -rf ~", "rm -r ~"],
  ["time -f %e rm -rf ~", "rm -r ~"],
  // the outer cd reaches the recursion (B2)
  ["cd .. && sh -c 'rm -rf repo'", "rm -r repo"],
  ["cd .. && eval rm -rf repo", "rm -r repo"],
  ["pushd .. && rm -rf repo", "rm -r repo"],
  // a heredoc fed to a shell is a script (B3)
  ["bash <<'EOF'\nrm -rf ~\nEOF", "rm -r ~"],
  ["sh <<EOF\ngit reset --hard\nEOF", "git reset --hard"],
  ["git commit -F - <<'EOF'\nmsg\nEOF\ngit reset --hard", "git reset --hard"],
];

const PASSING = [
  "rm -rf node_modules",
  "rm -rf ./dist",
  "rm -rf /tmp/foo",
  "rm -rf ~/projects/x",
  "rm -f *",
  "rm -r src/*",
  "rm -rf src",
  "rm -rf /work/proj/repo/dist",
  "cd src && rm -rf dist",
  "rm -rf $DIR",
  "git reset --soft HEAD~1",
  "git reset HEAD file",
  "git clean -n",
  "git clean -fdn",
  "git clean --dry-run -f",
  "git push",
  "git push -u origin x",
  "git push --force-with-lease",
  "git push --force-if-includes",
  "git branch -d x",
  "git branch",
  "git commit -m 'reset --hard'",
  "grep -rn \"git reset --hard\" .",
  "echo \"rm -rf /\"",
  "printf 'git push -f'",
  "psql -c \"SELECT 1\"",
  "sqlite3 db \"DELETE FROM t WHERE id = 1\"",
  "cat > m.sql <<'EOF'\nDROP TABLE users;\nEOF",
  "echo 'DROP TABLE x' | cat",
  // heredoc bodies are data (B3)
  "git commit -F - <<'EOF'\nfeat: block git reset --hard\nEOF",
  "cat > notes.md <<'EOF'\nNever run git reset --hard here.\nEOF",
  "gh pr create --body-file - <<'EOF'\nwe block git push --force\nEOF",
  "cat <<-EOF\n\trm -rf ~\n\tEOF",
  "cat <<\"EOF\"\nrm -rf ~\nEOF",
  // comments (warning)
  "npm test # never git reset --hard",
  "npm test #never rm -rf ~",
  "echo a#b; echo $#; echo ${#x}",
  "sudo -u root rm -rf dist",
  "timeout 5 rm -rf dist",
  "cd .. && sh -c 'rm -rf repo/dist'",
];

describe("destructiveCommand — blocked", () => {
  for (const [command, label] of BLOCKED) {
    it(`${JSON.stringify(command)} → ${label}`, () => {
      assert.equal(destructiveCommand(command, CTX), label);
    });
  }
});

describe("destructiveCommand — must pass", () => {
  for (const command of PASSING) {
    it(JSON.stringify(command), () => {
      assert.equal(destructiveCommand(command, CTX), undefined);
    });
  }
});

// The repo root and home as Windows reports them (drive letter, backslashes).
const WIN_CTX = { cwd: "D:\\a\\leina\\repo", home: "C:\\Users\\me" };

describe("destructiveCommand — Windows paths", () => {
  const blocked: [string, string][] = [
    ["rm -rf ~", "rm -r ~"],
    ["rm -rf $HOME/", "rm -r $HOME/"],
    ["rm -rf .", "rm -r ."],
    ["rm -rf ..", "rm -r .."],
    ["rm -rf .git", "rm -r .git"],
    ["cd .. && rm -rf repo", "rm -r repo"],
    ["rm -rf 'D:\\a\\leina\\repo'", "rm -r D:\\a\\leina\\repo"],
    ["rm -rf C:/Users/me", "rm -r C:/Users/me"],
    ["rm -rf C:/", "rm -r C:/"],
  ];
  for (const [command, label] of blocked) {
    it(`${JSON.stringify(command)} → ${label}`, () => {
      assert.equal(destructiveCommand(command, WIN_CTX), label);
    });
  }
  for (const command of ["rm -rf dist", "rm -rf ~/projects/x", "rm -rf C:/Users/me/tmp/x", "rm -rf 'D:\\a\\leina\\repo\\dist'"]) {
    it(`${JSON.stringify(command)} passes`, () => {
      assert.equal(destructiveCommand(command, WIN_CTX), undefined);
    });
  }
});

describe("destructiveCommand — recursion depth", () => {
  it("gives up past depth 3", () => {
    assert.equal(destructiveCommand("sh -c \"sh -c \\\"sh -c \\\\\\\"sh -c 'git reset --hard'\\\\\\\"\\\"\"", CTX), undefined);
  });
});

// ---------------------------------------------------------------------------
// decision + wiring
// ---------------------------------------------------------------------------

let repo: TmpRepo;
let leinaHome: string;
let restoreHome: () => void;
const git = new HarnessGit();

beforeEach(async () => {
  repo = await makeTmpRepo();
  leinaHome = await fs.mkdtemp(path.join(os.tmpdir(), "leina-destructive-home-"));
  restoreHome = isolateLeinaHome(leinaHome);
});

afterEach(async () => {
  restoreHome();
  await repo.cleanup();
  await fs.rm(leinaHome, { recursive: true, force: true });
});

async function install(): Promise<void> {
  await repo.write(".harness/config.json", "{}");
  await repo.write(".leina/consent", "enabled");
  trustWorkspace(repo.root);
}

async function gate(command: string): Promise<{ result: { handled: boolean; exitCode?: number }; stderr: string }> {
  const errs: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    errs.push(String(c));
    return true;
  });
  try {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } };
    const result = await runHarnessAgentGate(JSON.stringify(payload), repo.root, undefined, "claude");
    return { result, stderr: errs.join("") };
  } finally {
    process.stderr.write = orig;
  }
}

describe("decideDestructiveBash", () => {
  it("allows without .harness/", async () => {
    assert.deepEqual(await decideDestructiveBash(repo.root, "git reset --hard"), { block: false });
  });

  it("blocks with .harness/, with the message naming the label and the human unblock", async () => {
    await repo.write(".harness/config.json", "{}");
    const d = await decideDestructiveBash(repo.root, "git reset --hard");
    assert.equal(d.block, true);
    if (d.block) {
      assert.equal(d.kind, "destructive");
      assert.match(d.message, /BLOCKED: this command is destructive \(git reset --hard\)/);
      assert.match(d.message, /ask the human to run it themselves \(in Claude Code, by typing `! git reset --hard`\)/);
    }
  });

  it("treats the repo root as the cwd", async () => {
    await repo.write(".harness/config.json", "{}");
    assert.equal((await decideDestructiveBash(repo.root, "rm -rf .")).block, true);
    assert.equal((await decideDestructiveBash(repo.root, "rm -rf dist")).block, false);
  });

  it("allows an undefined command", async () => {
    assert.deepEqual(await decideDestructiveBash(repo.root, undefined), { block: false });
  });
});

describe("destructive guard on the agent gate", () => {
  it("guided, no contract: exit 2 + message on stderr", async () => {
    await install();
    const run = await gate("git push --force");
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /BLOCKED: this command is destructive \(git push --force\)/);
  });

  it("guided, no contract: a harmless command is not handled", async () => {
    await install();
    const run = await gate("rm -rf dist");
    assert.equal(run.result.handled, false);
    assert.equal(run.stderr, "");
  });

  it("active contract: exit 2 + message", async () => {
    await install();
    const contract = { goal: "g", scope: ["src/**"], outOfScope: [], criteria: [], maxRetries: 3, createdAt: new Date().toISOString() };
    await saveContract(repo.root, contract);
    await writeChecklist(repo.root, contract);
    const run = await gate("sh -c 'rm -rf ~'");
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /destructive \(rm -r ~\)/);
  });

  it("trusted repo without .harness/: not handled", async () => {
    await repo.write(".leina/consent", "enabled");
    trustWorkspace(repo.root);
    const run = await gate("git reset --hard");
    assert.equal(run.result.handled, false);
    assert.equal(run.stderr, "");
  });

  it("untrusted workspace: not handled", async () => {
    await repo.write(".harness/config.json", "{}");
    await repo.write(".leina/consent", "enabled");
    const run = await gate("git reset --hard");
    assert.equal(run.result.handled, false);
    assert.equal(run.stderr, "");
  });
});

describe("destructive guard on decidePreBash / Cursor", () => {
  it("decidePreBash blocks with kind destructive", async () => {
    await repo.write(".harness/config.json", "{}");
    const d = await decidePreBash(repo.root, "git clean -fd", git);
    assert.equal(d.block && d.kind, "destructive");
  });

  it("decideCursorShell denies with the user message", async () => {
    await repo.write(".harness/config.json", "{}");
    const d = await decideCursorShell(repo.root, "git branch -D x", git);
    assert.equal(d.permission, "deny");
    if (d.permission === "deny") {
      assert.equal(d.userMessage, "harness: blocked a destructive command");
      assert.match(d.agentMessage, /destructive \(git branch -D\)/);
    }
  });
});

describe("heredoc and comment reading of the other shell-words readers", () => {
  it("a heredoc body does not count as a git commit", () => {
    assert.equal(gitCommitOrPush("cat > n.md <<'EOF'\ngit commit -m x\nEOF"), undefined);
  });
  it("a comment does not count as a git push", () => {
    assert.equal(gitCommitOrPush("npm test # git push"), undefined);
  });
  it("a heredoc fed to a shell is read as a script", () => {
    assert.equal(gitCommitOrPush("bash <<'EOF'\ngit push\nEOF"), "push");
    assert.deepEqual(shellWriteTargets("bash <<EOF\necho x > .harness/config.json\nEOF"), [".harness/config.json"]);
  });
  it("a heredoc body for cat is not a write target", () => {
    assert.deepEqual(shellWriteTargets("cat <<'EOF'\necho x > .harness/config.json\nEOF"), []);
  });
  it("value-taking prefix flags are skipped by the other readers too", () => {
    assert.equal(gitCommitOrPush("sudo -u root git push"), "push");
    assert.deepEqual(shellWriteTargets("sudo -u root rm .harness/config.json"), [".harness/config.json"]);
  });
  it("the here-string is not a heredoc", () => {
    assert.equal(destructiveCommand("cat <<< x\nrm -rf ~", CTX), "rm -r ~");
  });
});

describe("second correction round: arithmetic, heredoc substitutions, long value flags", () => {
  const CF = ".harness/config.json";
  it("R1: arithmetic << is a shift, not a heredoc", () => {
    assert.equal(destructiveCommand("echo $((1<<2))\nrm -rf ~", CTX), "rm -r ~");
    assert.equal(gitCommitOrPush("echo $((1<<2))\ngit commit -m x"), "commit");
    assert.ok(shellWriteTargets(`echo $((1<<2))\necho x > ${CF}`).includes(CF));
    assert.equal(destructiveCommand("echo $((x<<=1))\nrm -rf ~", CTX), "rm -r ~");
    assert.equal(destructiveCommand("((y <<= 2))\nrm -rf ~", CTX), "rm -r ~");
  });
  it("R2: an unquoted heredoc body runs its command substitutions", () => {
    assert.equal(destructiveCommand("cat <<EOF\n$(rm -rf ~)\nEOF", CTX), "rm -r ~");
    assert.equal(destructiveCommand("cat <<EOF\n`rm -rf ~`\nEOF", CTX), "rm -r ~");
    assert.equal(gitCommitOrPush("cat <<EOF\n$(git commit -m x)\nEOF"), "commit");
    assert.ok(shellWriteTargets(`cat <<EOF\n$(echo x > ${CF})\nEOF`).includes(CF));
  });
  it("R2: quoted delimiters and plain text stay literal", () => {
    assert.equal(destructiveCommand("cat <<'EOF'\n$(rm -rf ~)\nEOF", CTX), undefined);
    assert.equal(destructiveCommand('cat <<"EOF"\n$(rm -rf ~)\nEOF', CTX), undefined);
    assert.equal(destructiveCommand("cat <<\\EOF\n$(rm -rf ~)\nEOF", CTX), undefined);
    assert.equal(destructiveCommand("cat <<EOF\n$(echo hi)\nEOF", CTX), undefined);
    assert.equal(destructiveCommand("cat <<EOF\nrm -rf ~ is bad\nEOF", CTX), undefined);
  });
  it("R3: clustered and long value flags consume the next word", () => {
    for (const c of [
      "sudo -Hu root rm -rf /",
      "sudo -iu root rm -rf /",
      "sudo --user root rm -rf /",
      "sudo --chdir /tmp rm -rf /",
      "timeout --signal KILL 5 rm -rf ~",
      "timeout --kill-after 3 5 rm -rf ~",
      "env --unset FOO rm -rf ~",
      "env --split-string 'rm -rf ~'",
      "nice --adjustment 10 rm -rf ~",
      "time --format x rm -rf ~",
      "xargs --max-args 1 rm -rf ~",
      "sudo -uroot rm -rf /",
      "sudo --user=root rm -rf /",
    ]) assert.ok(destructiveCommand(c, CTX) !== undefined, c);
  });
});

describe("destructive guard: strictness, config, hook transport, order", () => {
  async function hook(command: string): Promise<{ stderr: string; code: number }> {
    const prev = process.exitCode;
    process.exitCode = undefined;
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      errs.push(String(c));
      return true;
    });
    try {
      await runHarnessHookEvent("pre-bash", JSON.stringify({ tool_name: "Bash", tool_input: { command } }), repo.root);
      return { stderr: errs.join(""), code: typeof process.exitCode === "number" ? process.exitCode : 0 };
    } finally {
      process.stderr.write = orig;
      process.exitCode = prev;
    }
  }

  it("strictness strict: still blocks on the gate", async () => {
    await install();
    await repo.write(".harness/config.json", JSON.stringify({ strictness: "strict" }));
    const run = await gate("git reset --hard");
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /destructive \(git reset --hard\)/);
  });

  it("an unreadable config: still blocks on the gate", async () => {
    await install();
    await repo.write(".harness/config.json", "{ nope");
    const run = await gate("rm -rf ~");
    assert.deepEqual(run.result, { handled: true, exitCode: 2 });
    assert.match(run.stderr, /destructive \(rm -r ~\)/);
  });

  it("leina harness hook pre-bash: exit 2 + message", async () => {
    await install();
    const run = await hook("sudo -u root rm -rf /");
    assert.equal(run.code, 2);
    assert.match(run.stderr, /destructive \(rm -r \/\)/);
  });

  it("leina harness hook pre-bash: a heredoc body about git is allowed", async () => {
    await install();
    const run = await hook("git commit -F - <<'EOF'\nblock git reset --hard\nEOF");
    assert.doesNotMatch(run.stderr, /destructive/);
  });

  it("a command that hits both the integrity seal and the guard reports integrity", async () => {
    await repo.write(".harness/config.json", "{}");
    const d = await decidePreBash(repo.root, "git reset --hard && echo x > .harness/config.json", git);
    assert.equal(d.block && d.kind, "integrity");
  });
});
