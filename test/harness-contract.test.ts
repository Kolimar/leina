// harness-contract.test.ts — contract persistence under .harness/state/:
// load/save round-trip, validation errors, checklist generation, and the
// end/archive flow to state/history/<timestamp>/.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-contract.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  checklistPath,
  contractPath,
  endContract,
  ensureStateDir,
  loadContract,
  saveContract,
  stateDir,
  writeChecklist,
} from "../src/application/harness/contract-io.ts";
import type { TaskContract } from "../src/domain/harness/model.ts";
import { makeTmpRepo, type TmpRepo } from "./helpers/harness-tmprepo.ts";

let repo: TmpRepo;

const CONTRACT: TaskContract = {
  goal: "port the harness core",
  taskType: "feature",
  scope: ["src/**", "test/**"],
  outOfScope: ["assets/**"],
  criteria: [
    { text: "all gates pass", done: false },
    { text: "tests added", done: true },
  ],
  maxRetries: 3,
  baseRef: "abc123",
  createdAt: "2026-07-18T00:00:00.000Z",
};

beforeEach(async () => {
  repo = await makeTmpRepo(false);
});

afterEach(async () => {
  await repo.cleanup();
});

describe("contract persistence", () => {
  it("returns empty when no contract exists", async () => {
    const loaded = await loadContract(repo.root);
    assert.equal(loaded.contract, undefined);
    assert.equal(loaded.error, undefined);
  });

  it("round-trips save → load", async () => {
    await saveContract(repo.root, CONTRACT);
    const loaded = await loadContract(repo.root);
    assert.equal(loaded.error, undefined);
    assert.deepEqual(loaded.contract, CONTRACT);
    assert.equal(contractPath(repo.root), path.join(repo.root, ".harness", "state", "current", "contract.json"));
  });

  it("reports malformed JSON as an error", async () => {
    await repo.write(".harness/state/current/contract.json", "{ nope");
    const loaded = await loadContract(repo.root);
    assert.ok(loaded.error?.includes("invalid JSON"));
  });

  it("reports schema violations as an error", async () => {
    await repo.write(".harness/state/current/contract.json", JSON.stringify({ scope: ["src/**"] }));
    const loaded = await loadContract(repo.root);
    assert.ok(loaded.error?.includes("goal"));
  });
});

describe("state dir is self-ignoring", () => {
  it("(state-ignore-2) saveContract and writeChecklist drop `*` into .harness/state/.gitignore", async () => {
    await saveContract(repo.root, CONTRACT);
    const ignore = path.join(repo.root, ".harness", "state", ".gitignore");
    assert.equal(await fs.readFile(ignore, "utf8"), "*\n");

    // Idempotent and non-clobbering: a user-tuned file is left alone.
    await fs.writeFile(ignore, "*\n!keep.md\n");
    await writeChecklist(repo.root, CONTRACT);
    assert.equal(await fs.readFile(ignore, "utf8"), "*\n!keep.md\n");
  });

  it("(state-ignore-3) ensureStateDir creates current/ and the ignore file", async () => {
    const dir = await ensureStateDir(repo.root);
    assert.equal(dir, stateDir(repo.root));
    assert.ok((await fs.stat(dir)).isDirectory());
    assert.equal(await fs.readFile(path.join(repo.root, ".harness", "state", ".gitignore"), "utf8"), "*\n");
  });
});

describe("checklist generation", () => {
  it("writes one checkbox per criterion, preserving done state", async () => {
    await writeChecklist(repo.root, CONTRACT);
    const text = await fs.readFile(checklistPath(repo.root), "utf8");
    assert.ok(text.includes("- [ ] all gates pass"));
    assert.ok(text.includes("- [x] tests added"));
    assert.ok(text.startsWith("# Acceptance criteria"));
  });

  it("writes nothing when there are no criteria", async () => {
    await writeChecklist(repo.root, { ...CONTRACT, criteria: [] });
    await assert.rejects(fs.access(checklistPath(repo.root)));
  });
});

describe("endContract", () => {
  it("archives state/current to state/history/<timestamp>", async () => {
    await saveContract(repo.root, CONTRACT);
    await writeChecklist(repo.root, CONTRACT);

    const result = await endContract(repo.root, new Date("2026-07-18T10:20:30.456Z"));
    assert.ok(result.ok);
    assert.ok(result.archivedTo.endsWith(path.join("state", "history", "2026-07-18T10-20-30")));

    // current/ is gone; the archive holds contract + checklist.
    await assert.rejects(fs.access(stateDir(repo.root)));
    const archived = await fs.readdir(result.archivedTo);
    assert.deepEqual(archived.sort(), ["checklist.md", "contract.json"]);
  });

  it("fails gracefully when no contract is active", async () => {
    const result = await endContract(repo.root);
    assert.ok(!result.ok);
    assert.equal(result.error, "no active contract");
  });

  it("suffixes the archive dir when two contracts end within the same second", async () => {
    const sameInstant = new Date("2026-07-18T10:20:30.456Z");
    await saveContract(repo.root, CONTRACT);
    const first = await endContract(repo.root, sameInstant);
    assert.ok(first.ok);

    await saveContract(repo.root, CONTRACT);
    const second = await endContract(repo.root, sameInstant);
    assert.ok(second.ok);
    assert.notEqual(second.archivedTo, first.archivedTo);
    assert.ok(second.archivedTo.endsWith("2026-07-18T10-20-30-2"));
  });
});
