// test/project-dir.test.ts — the optional <dir> of the per-project commands
// (src/cli/project-args.ts): defaults to the cwd, resolves to the project root, an explicit
// missing <dir> is a usage error, flag values are never positionals, and the documented
// positional rules of query / affected / path / memory.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikePath } from "../src/cli/project-args.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "leina-pdir-home-"));
after(() => rmSync(HOME, { recursive: true, force: true }));

function runCli(args: string[], cwd?: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, HOME, LEINA_HOME: join(HOME, ".leina") },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

/** A built two-file TS project (alpha → beta) with a `src/deep` subdirectory. */
function builtProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "leina-pdir-proj-")));
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  writeFileSync(join(dir, "src", "b.ts"), "export function beta(): number { return 1; }\n");
  writeFileSync(
    join(dir, "src", "a.ts"),
    'import { beta } from "./b.ts";\nexport function alpha(): number { return beta(); }\n',
  );
  const built = runCli(["build", dir]);
  assert.equal(built.code, 0, built.stderr);
  return dir;
}

test("(pdir-1) from a subdirectory, no <dir>: reads the project's graph, creates nothing there", () => {
  const dir = builtProject();
  try {
    const deep = join(dir, "src", "deep");
    const status = runCli(["status"], deep);
    assert.equal(status.code, 0, status.stderr);
    // startsWith, not a RegExp: a Windows temp path is full of backslash escapes.
    assert.ok(status.stdout.startsWith(`root: ${dir}\n`), status.stdout);
    assert.match(runCli(["affected", "beta"], deep).stdout, /Blast radius of beta/);
    assert.match(runCli(["path", "alpha", "beta"], deep).stdout, /alpha/);
    assert.match(runCli(["query", "alpha"], deep).stdout, /Seeds: alpha/);
    assert.match(runCli(["stats"], deep).stdout, /^nodes: \d+/);
    // `.` and an explicit subdirectory resolve the same way.
    assert.match(runCli(["affected", ".", "beta"], deep).stdout, /Blast radius of beta/);
    assert.match(runCli(["affected", deep, "beta"]).stdout, /Blast radius of beta/);
    assert.deepEqual(readdirSync(deep), [], "no second project under the subdirectory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pdir-2) an explicit <dir> that does not exist is a usage error, never created", () => {
  const parent = mkdtempSync(join(tmpdir(), "leina-pdir-missing-"));
  try {
    const missing = join(parent, "nope");
    for (const args of [
      ["status", missing],
      ["stats", missing],
      ["build", missing],
      ["affected", missing, "Foo"],
      ["query", missing, "how", "is", "trust", "checked"],
      ["memory", "search", missing, "anything"],
      ["memory", "context", missing],
      ["doctor", missing],
    ]) {
      const r = runCli(args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /no such directory: .*nope/, args.join(" "));
      assert.equal(r.stdout, "");
    }
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("(pdir-3) positional rules: affected / path take <dir> first; extra words are usage errors", () => {
  const dir = builtProject();
  try {
    const notDir = runCli(["affected", "alpha", "beta"], dir);
    assert.equal(notDir.code, 2);
    assert.match(notDir.stderr, /'alpha' is not a directory \(with 2 positionals the first one is <dir>\)/);
    const depth = runCli(["affected", ".", "beta", "2"], dir);
    assert.equal(depth.code, 2);
    assert.match(depth.stderr, /the depth is a flag: --depth 2/);
    assert.equal(runCli(["affected", "beta", "--depth", "1"], dir).code, 0);
    const tooMany = runCli(["path", ".", "alpha", "beta", "gamma"], dir);
    assert.equal(tooMany.code, 2);
    assert.match(tooMany.stderr, /unexpected argument 'gamma'/);
    const missing = runCli(["path", "alpha"], dir);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /missing <to>/);
    const extra = runCli(["status", ".", "extra"], dir);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /unexpected argument 'extra' \(status takes at most one <dir>\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pdir-4) query: the first word is <dir> only when it is a directory or path-shaped", () => {
  const dir = builtProject();
  try {
    // `src` is a directory of the project: with more words it is the <dir>.
    const viaDir = runCli(["query", "src", "alpha"], dir);
    assert.match(viaDir.stdout, /Seeds: alpha/);
    // Not a directory → part of the question.
    assert.match(runCli(["query", "who", "calls", "beta"], dir).stdout, /Seeds: .*beta/);
    // Path-shaped and missing → usage error instead of a silent search.
    const typo = runCli(["query", "./srcx", "alpha"], dir);
    assert.equal(typo.code, 2);
    assert.match(typo.stderr, /no such directory/);
    // A lone path is a missing question.
    assert.equal(runCli(["query", "."], dir).code, 2);
    assert.match(runCli(["query", "."], dir).stderr, /missing <question>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pdir-5) flag values are never read as the <dir>", () => {
  const dir = builtProject();
  try {
    const out = join(dir, "viz.html");
    const r = runCli(["visualize", "--out", out], join(dir, "src"));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(out), "the --out value is the output file");
    assert.ok(!existsSync(join(out, ".leina")), "and never a project dir");
    const q = runCli(["memory", "search", "--limit", "3", "anything"], dir);
    assert.equal(q.code, 0, q.stderr);
    assert.match(q.stdout, /No results for "anything"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pdir-6) memory: <dir> is optional, resolves to the project root, ids take one or two positionals", () => {
  const dir = builtProject();
  try {
    const deep = join(dir, "src", "deep");
    const cp = runCli(["memory", "current-project"], deep);
    assert.equal(cp.code, 0, cp.stderr);
    assert.ok(cp.stdout.includes(`root: ${dir}`), cp.stdout);

    const saved = runCli(["memory", "save", "--title", "from deep", "--content", "x"], deep);
    assert.equal(saved.code, 0, saved.stderr);
    const id = /#(\S+) \(new\)/.exec(saved.stdout)![1]!;
    assert.match(runCli(["memory", "get", id], dir).stdout, /title: from deep/);
    assert.match(runCli(["memory", "get", deep, id]).stdout, /title: from deep/);
    assert.match(runCli(["memory", "search", "from", "deep"], dir).stdout, /from deep/);
    assert.match(runCli(["memory", "search", dir, "from", "deep"]).stdout, /from deep/);

    const noId = runCli(["memory", "get"], dir);
    assert.equal(noId.code, 2);
    assert.match(noId.stderr, /leina memory get: missing <id>/);
    const extra = runCli(["memory", "context", ".", "extra"], dir);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /unexpected argument 'extra'/);
    // The snapshot of `memory sync` lands at the project root, not in the subdirectory.
    assert.equal(runCli(["memory", "sync"], deep).code, 0);
    assert.ok(existsSync(join(dir, ".leina", "memory-export.jsonl")));
    assert.deepEqual(readdirSync(deep), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(pdir-7) init takes <dir> as given, wherever the flags sit; deinit refuses a conflicting --project", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "leina-pdir-init-")));
  try {
    const a = join(parent, "a");
    const b = join(parent, "b");
    mkdirSync(a);
    mkdirSync(b);
    const conflict = runCli(["deinit", a, "--project", b]);
    assert.equal(conflict.code, 2);
    assert.match(conflict.stderr, /disagree — give one of them/);
    const missing = runCli(["deinit", join(parent, "nope")]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no such directory/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("(pdir-8) looksLikePath: only unambiguous path shapes", () => {
  for (const w of [".", "..", "./x", "../x", "/abs", "~/x", "~", "C:\\x", ".\\x"]) assert.ok(looksLikePath(w), w);
  for (const w of ["src", "src/cli", "alpha", "how", ".leina", "x.ts"]) assert.ok(!looksLikePath(w), w);
});
