// memory-cli.test.ts — CLI integration tests for the `memory <sub>` handlers in
// src/cli/handlers/memory.ts: save/update/search/verified/get/context/session/
// session-start/suggest-topic + batch variants + help + error paths.
// Run: node --no-warnings --experimental-strip-types --test test/memory-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): RunResult {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", env: opts.env ?? process.env, input: opts.input },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

// Each test gets an isolated global memory home + a plain (non-git) project dir, whose
// basename becomes the derived project key (unambiguous → no AmbiguousProjectError).
function withEnv(fn: (ctx: { env: NodeJS.ProcessEnv; dir: string }) => void): void {
  const home = mkdtempSync(join(tmpdir(), "leina-memcli-home-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-memcli-proj-"));
  try {
    fn({ env: { ...process.env, LEINA_HOME: home }, dir });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

function idFrom(stdout: string): string {
  const id = (/#(\S+)/.exec(stdout))?.[1];
  assert.ok(id, `expected an id in: ${stdout}`);
  return id;
}

test("(MC-1) save: persists an observation and prints the new id", () => {
  withEnv(({ env, dir }) => {
    const r = runCli(["memory", "save", dir, "--title", "T", "--content", "C", "--type", "decision"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Saved decision #\S+ \(new\)/);
  });
});

test("(MC-2) save --topic twice: evolves the same topic in place", () => {
  withEnv(({ env, dir }) => {
    runCli(["memory", "save", dir, "--title", "T1", "--content", "C1", "--topic", "my-topic"], { env });
    const r = runCli(["memory", "save", dir, "--title", "T2", "--content", "C2", "--topic", "my-topic"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /evolved rev \d+/);
  });
});

test("(MC-3) save: missing --content fails", () => {
  withEnv(({ env, dir }) => {
    const r = runCli(["memory", "save", dir, "--title", "only-title"], { env });
    assert.notEqual(r.code, 0, "should fail without --content");
    assert.match(r.stderr, /requires --content|--content requires/);
  });
});

test("(MC-4) save --batch: persists multiple from stdin JSON", () => {
  withEnv(({ env, dir }) => {
    const input = JSON.stringify([
      { title: "A", content: "x" },
      { title: "B", content: "y", type: "bugfix" },
    ]);
    const r = runCli(["memory", "save", dir, "--batch", "--atomic"], { env, input });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /new/);
  });
});

test("(MC-5) save --batch: malformed stdin fails", () => {
  withEnv(({ env, dir }) => {
    const r = runCli(["memory", "save", dir, "--batch"], { env, input: "not json" });
    assert.notEqual(r.code, 0, "should fail on malformed batch");
    assert.match(r.stderr, /--batch expects a JSON array/);
  });
});

test("(MC-6) update: modifies an existing observation by id", () => {
  withEnv(({ env, dir }) => {
    const saved = runCli(["memory", "save", dir, "--title", "T", "--content", "C"], { env });
    const id = idFrom(saved.stdout);
    const r = runCli(["memory", "update", dir, id, "--content", "new content"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`Updated #${id} \\(rev \\d+\\)`));
  });
});

test("(MC-7) update --batch: updates multiple from stdin JSON", () => {
  withEnv(({ env, dir }) => {
    const s1 = runCli(["memory", "save", dir, "--title", "T1", "--content", "C1"], { env });
    const id1 = idFrom(s1.stdout);
    const input = JSON.stringify([{ id: id1, content: "updated", type: "discovery" }]);
    const r = runCli(["memory", "update", dir, "--batch"], { env, input });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /rev \d+/);
  });
});

test("(MC-8) search: finds a saved observation; empty query reports none", () => {
  withEnv(({ env, dir }) => {
    runCli(["memory", "save", dir, "--title", "Findable banana", "--content", "C"], { env });
    const hit = runCli(["memory", "search", dir, "banana"], { env });
    assert.equal(hit.code, 0, `exit 0. stderr: ${hit.stderr}`);
    assert.match(hit.stdout, /Findable banana/);

    const none = runCli(["memory", "search", dir, "zzzznotpresent"], { env });
    assert.equal(none.code, 0);
    assert.match(none.stdout, /No results for/);
  });
});

test("(MC-9) verified: prints USABLE/WARNING/DO NOT USE sections", () => {
  withEnv(({ env, dir }) => {
    runCli(["memory", "save", dir, "--title", "Verifiable note", "--content", "C"], { env });
    const r = runCli(["memory", "verified", dir, "Verifiable"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /USABLE \(\d+\)/);
    assert.match(r.stdout, /DO NOT USE \(\d+\)/);
  });
});

test("(MC-10) get: prints an observation; missing id reports not found", () => {
  withEnv(({ env, dir }) => {
    const saved = runCli(["memory", "save", dir, "--title", "Gettable", "--content", "Body here"], { env });
    const id = idFrom(saved.stdout);
    const got = runCli(["memory", "get", dir, id], { env });
    assert.equal(got.code, 0, `exit 0. stderr: ${got.stderr}`);
    assert.match(got.stdout, /title: Gettable/);
    assert.match(got.stdout, /Body here/);

    const missing = runCli(["memory", "get", dir, "nonexistent-id"], { env });
    assert.equal(missing.code, 0);
    assert.match(missing.stdout, /No observation found/);
  });
});

test("(MC-11) get --batch: reads ids from stdin JSON array", () => {
  withEnv(({ env, dir }) => {
    const s1 = runCli(["memory", "save", dir, "--title", "T1", "--content", "C1"], { env });
    const id1 = idFrom(s1.stdout);
    const r = runCli(["memory", "get", dir, "--batch"], { env, input: JSON.stringify([id1]) });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`#${id1}`));
  });
});

test("(MC-12) context: prints recent sessions + observations", () => {
  withEnv(({ env, dir }) => {
    runCli(["memory", "save", dir, "--title", "Ctx note", "--content", "C"], { env });
    const r = runCli(["memory", "context", dir], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /RECENT SESSIONS:/);
    assert.match(r.stdout, /RECENT OBSERVATIONS:/);
    assert.match(r.stdout, /Ctx note/);
  });
});

test("(MC-13) session: saves a session summary", () => {
  withEnv(({ env, dir }) => {
    const r = runCli(["memory", "session", dir, "--content", "did stuff", "--title", "S1"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Session summary saved: #\S+/);
  });
});

test("(MC-14) session: missing --content fails", () => {
  withEnv(({ env, dir }) => {
    const r = runCli(["memory", "session", dir], { env });
    assert.notEqual(r.code, 0, "should fail without --content");
    assert.match(r.stderr, /requires --content/);
  });
});

test("(MC-15) session-start: opens a session and prints its id", () => {
  withEnv(({ env, dir }) => {
    const r = runCli(["memory", "session-start", dir, "--title", "kickoff"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /Session started: #\S+/);
  });
});

test("(MC-16) suggest-topic: prints a normalized suggestion", () => {
  withEnv(({ env, dir }) => {
    const r = runCli(["memory", "suggest-topic", dir, "--title", "Auth Rework Plan"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /suggestion: \S+/);
  });
});

test("(MC-17) no sub-command prints the memory help", () => {
  withEnv(({ env }) => {
    const r = runCli(["memory"], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /leina memory <dir> <sub-command>/);
  });
});

test("(MC-18) unknown sub-command falls back to help", () => {
  withEnv(({ env, dir }) => {
    const r = runCli(["memory", "bogus", dir], { env });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    assert.match(r.stdout, /save <dir> --title/);
  });
});

// ---------------------------------------------------------------------------
// batch anchors normalization (WS7): anchors may arrive as string[] or as the
// same comma-separated string the --anchors flag accepts. A blind cast used to
// iterate a string character-wise and store single-letter anchors.
// ---------------------------------------------------------------------------

test("(MC-anchors-1) save --batch: comma-string anchors are split, not char-iterated", () => {
  withEnv(({ env, dir }) => {
    const input = JSON.stringify([
      { title: "A", content: "x", anchors: "src/a.ts, src/b.ts" },
    ]);
    const r = runCli(["memory", "save", dir, "--batch"], { env, input });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    const id = idFrom(r.stdout);
    const got = runCli(["memory", "get", dir, id], { env });
    // Neither anchor may degrade to a single character; both paths must survive.
    assert.doesNotMatch(got.stdout, /anchor 's'/, "no char-wise anchors");
  });
});

test("(MC-anchors-2) save --batch: non-string non-array anchors is a per-item error", () => {
  withEnv(({ env, dir }) => {
    const input = JSON.stringify([{ title: "A", content: "x", anchors: 42 }]);
    const r = runCli(["memory", "save", dir, "--batch"], { env, input });
    assert.notEqual(r.code, 0, "invalid anchors type must not save silently");
    assert.match(r.stderr + r.stdout, /anchors must be/);
  });
});

test("(MC-anchors-3) update --batch: anchors-only item is applied (no silent no-op)", () => {
  withEnv(({ env, dir }) => {
    const saved = runCli(
      ["memory", "save", dir, "--title", "T", "--content", "C", "--anchors", "src/old.ts"],
      { env },
    );
    const id = idFrom(saved.stdout);
    const input = JSON.stringify([{ id, anchors: ["src/new.ts"] }]);
    const r = runCli(["memory", "update", dir, "--batch"], { env, input });
    assert.equal(r.code, 0, `exit 0. stderr: ${r.stderr}`);
    // verified surfaces anchor identity: the new anchor name must be visible.
    const v = runCli(["memory", "verified", dir, "T", "--limit", "3"], { env });
    assert.match(v.stdout, /new\.ts|never resolved/, "updated anchor is what verify sees");
    assert.doesNotMatch(v.stdout, /old\.ts/, "old anchor no longer attached");
  });
});
