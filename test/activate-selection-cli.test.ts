// activate-selection-cli.test.ts — end-to-end asset selection through
// `leina activate --preset/--skills/--agents`: filtered share population, selection
// persistence + reuse, repopulation on change, and the stale host-link sweep.
// Run: node --no-warnings --experimental-strip-types --test test/activate-selection-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function makeSandbox(): { env: NodeJS.ProcessEnv; home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "leina-sel-cli-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEINA_HOME: join(home, ".leina"),
    HOME: home,
    USERPROFILE: home,
  };
  // Point APPDATA into the sandbox so devinConfigRoot() resolves to <home>/.config/devin
  // on Windows too — the exact path these tests assert on every platform.
  env.APPDATA = join(home, ".config");
  return { env, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runActivate(env: NodeJS.ProcessEnv, ...extra: string[]) {
  // `activate` now requires an explicit host selection; reproduce the historical
  // devin wiring so these asset-selection assertions hold unchanged.
  const args = extra.includes("--hosts") ? extra : [...extra, "--hosts", "devin"];
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, "activate", ...args],
    { encoding: "utf8", env },
  );
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const lsDirs = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")).sort() : [];

test("(sel-a) --preset minimal installs only the core group (skills; no agents)", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const r = runActivate(env, "--preset", "minimal");
    assert.equal(r.status, 0, r.stderr);
    const shareSkills = lsDirs(join(home, ".leina", "share", "skills"));
    assert.deepEqual(shareSkills, ["_shared", "leina-setup"]);
    assert.deepEqual(lsDirs(join(home, ".leina", "share", "agents")), []);
    // Host links mirror the share exactly.
    assert.deepEqual(lsDirs(join(home, ".config", "devin", "skills")), ["_shared", "leina-setup"]);
    assert.deepEqual(lsDirs(join(home, ".config", "devin", "agents")), []);
    // Selection persisted.
    assert.ok(existsSync(join(home, ".leina", "share", ".selection.json")));
  } finally {
    cleanup();
  }
});

test("(sel-b) plain re-activate keeps the persisted selection; changing it repopulates + sweeps", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    // Full first: everything installed and linked.
    assert.equal(runActivate(env, "--preset", "full").status, 0);
    const fullSkills = lsDirs(join(home, ".config", "devin", "skills"));
    assert.ok(fullSkills.includes("github-pr"), "full install links github-pr");

    // Plain re-activate (no flags): selection unchanged, share up-to-date.
    const again = runActivate(env);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /up-to-date/);

    // Shrink to minimal: repopulates on the SAME version and sweeps now-dangling links.
    const shrink = runActivate(env, "--preset", "minimal");
    assert.equal(shrink.status, 0, shrink.stderr);
    assert.match(shrink.stdout, /populated/);
    assert.match(shrink.stdout, /swept \d+ stale host link/);
    assert.deepEqual(lsDirs(join(home, ".leina", "share", "skills")), ["_shared", "leina-setup"]);
    const hostSkills = lsDirs(join(home, ".config", "devin", "skills"));
    assert.ok(!hostSkills.includes("github-pr"), "github-pr link swept after deselection");
    assert.deepEqual(hostSkills, ["_shared", "leina-setup"]);
  } finally {
    cleanup();
  }
});

test("(sel-c) --skills with dependency closure: delegator pulls its agent artifacts", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const r = runActivate(env, "--skills", "sdd-explore", "--agents", "none");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /auto-included \(required\/dependency\): agent:sdd-explore/);
    const shareAgents = lsDirs(join(home, ".leina", "share", "agents"));
    assert.deepEqual(shareAgents, ["sdd-explore"]);
    const shareSkills = lsDirs(join(home, ".leina", "share", "skills"));
    assert.deepEqual(shareSkills, ["_shared", "leina-setup", "sdd-explore"]);
  } finally {
    cleanup();
  }
});

test("(sel-d) unknown names and preset+list combinations fail hard with exit 1", () => {
  const { env, home, cleanup } = makeSandbox();
  try {
    const typo = runActivate(env, "--skills", "grph-viz");
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /unknown skill "grph-viz"/);
    assert.ok(!existsSync(join(home, ".leina", "share")), "nothing installed on invalid input");

    const both = runActivate(env, "--preset", "sdd", "--skills", "graph-viz");
    assert.equal(both.status, 1);
    assert.match(both.stderr, /not both/);
  } finally {
    cleanup();
  }
});
