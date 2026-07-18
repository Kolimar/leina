// harness-sync.test.ts — the impure half of the sync engine: applyFileSets
// (writer.ts), the only piece that touches disk. Covers the origin lockfile v1
// format, idempotency, --check drift for CI, orphan cleanup, the
// conflict ≠ orphan distinction, hand-edit conflicts + --force, JSON-merge
// application, and coexistence of the leina protocol block with the harness
// managed block inside one AGENTS.md.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-sync.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultHarnessConfig, type Rule } from "../src/domain/harness/model.ts";
import { sha256 } from "../src/application/harness/adapters/managed-block.ts";
import { agentsmdAdapter } from "../src/application/harness/adapters/agentsmd.ts";
import { type AdapterFileSet, type Lockfile, applyFileSets, lockfilePath, parseLockfile, readLockfile } from "../src/application/harness/adapters/writer.ts";
import { type FileSet, type RuleBundle } from "../src/application/harness/adapters/types.ts";
import { PROTOCOL_END, PROTOCOL_START } from "../src/application/install/protocol.ts";
import { makeTmpRepo, type TmpRepo } from "./helpers/harness-tmprepo.ts";

let repo: TmpRepo;

beforeEach(async () => {
  repo = await makeTmpRepo(false);
});

afterEach(async () => {
  await repo.cleanup();
});

const HASH = "f".repeat(64);

function sets(...files: FileSet["files"]): AdapterFileSet[] {
  return [{ adapter: "test", fileSet: { files, warnings: [] } }];
}

function owned(p: string, content: string): FileSet["files"][number] {
  return { path: p, kind: "owned", content };
}

function block(p: string, content: string, blockId = "harness-core"): FileSet["files"][number] {
  return { path: p, kind: "managed-block", blockId, content };
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

describe("applyFileSets — lockfile", () => {
  it("writes the origin v1 lockfile format", async () => {
    await applyFileSets(repo.root, sets(owned("gen/a.md", "AAA\n"), block("AGENTS.md", "body")), {
      sourceHash: HASH,
    });
    const lock = JSON.parse(await read(".harness/harness.lock.json"));
    assert.equal(lock.version, 1);
    assert.equal(lock.sourceHash, HASH);
    assert.equal(lock.artifacts.length, 2);
    const ownedEntry = lock.artifacts.find((a: { path: string }) => a.path === "gen/a.md");
    assert.deepEqual(ownedEntry, {
      path: "gen/a.md",
      adapter: "test",
      kind: "owned",
      contentHash: sha256("AAA\n"),
    });
    const blockEntry = lock.artifacts.find((a: { path: string }) => a.path === "AGENTS.md");
    assert.equal(blockEntry.kind, "managed-block");
    assert.equal(blockEntry.blockId, "harness-core");
    assert.equal(blockEntry.contentHash, sha256(await read("AGENTS.md")));
    assert.equal(lockfilePath(repo.root), path.join(repo.root, ".harness", "harness.lock.json"));
  });

  it("parseLockfile accepts the v1 shape and rejects malformed documents", () => {
    const good: Lockfile = {
      version: 1,
      sourceHash: HASH,
      artifacts: [{ path: "a", adapter: "x", kind: "owned", contentHash: "h" }],
    };
    assert.deepEqual(parseLockfile(good), good);
    assert.equal(parseLockfile({ version: 2, sourceHash: HASH, artifacts: [] }), undefined);
    assert.equal(parseLockfile({ version: 1, artifacts: [] }), undefined);
    assert.equal(
      parseLockfile({ version: 1, sourceHash: HASH, artifacts: [{ path: "a", adapter: "x", kind: "weird", contentHash: "h" }] }),
      undefined,
    );
    assert.equal(parseLockfile([1]), undefined);
  });

  it("readLockfile tolerates a missing or corrupt lockfile", async () => {
    assert.equal(await readLockfile(repo.root), undefined);
    await repo.write(".harness/harness.lock.json", "{corrupt");
    assert.equal(await readLockfile(repo.root), undefined);
  });
});

describe("applyFileSets — idempotency and drift", () => {
  it("create → unchanged: the second run is a no-op with zero drift", async () => {
    const s = sets(owned("gen/a.md", "AAA\n"), block("AGENTS.md", "rules body"));
    const first = await applyFileSets(repo.root, s, { sourceHash: HASH });
    assert.deepEqual(first.items.map((i) => i.action), ["created", "created"]);

    const second = await applyFileSets(repo.root, s, { sourceHash: HASH });
    assert.deepEqual(second.items.map((i) => i.action), ["unchanged", "unchanged"]);
    assert.equal(second.driftCount, 0);
    assert.equal(second.conflictCount, 0);
  });

  it("--check reports drift without writing anything (CI mode)", async () => {
    const outcome = await applyFileSets(repo.root, sets(owned("gen/a.md", "AAA\n")), {
      sourceHash: HASH,
      check: true,
    });
    assert.equal(outcome.driftCount, 1);
    assert.equal(await exists("gen/a.md"), false, "check mode must not create files");
    assert.equal(await exists(".harness/harness.lock.json"), false, "check mode must not write the lockfile");
  });

  it("--check is clean right after a real sync, and dirty after a content change", async () => {
    const s = sets(owned("gen/a.md", "v1\n"));
    await applyFileSets(repo.root, s, { sourceHash: HASH });
    const clean = await applyFileSets(repo.root, s, { sourceHash: HASH, check: true });
    assert.equal(clean.driftCount, 0);

    const stale = await applyFileSets(repo.root, sets(owned("gen/a.md", "v2\n")), {
      sourceHash: HASH,
      check: true,
    });
    assert.equal(stale.driftCount, 1);
    assert.equal(await read("gen/a.md"), "v1\n", "check mode leaves the stale file untouched");
  });

  it("updates owned files that only harness has touched", async () => {
    await applyFileSets(repo.root, sets(owned("gen/a.md", "v1\n")), { sourceHash: HASH });
    const outcome = await applyFileSets(repo.root, sets(owned("gen/a.md", "v2\n")), { sourceHash: HASH });
    assert.deepEqual(outcome.items.map((i) => i.action), ["updated"]);
    assert.equal(await read("gen/a.md"), "v2\n");
  });
});

describe("applyFileSets — conflicts (hand edits)", () => {
  it("refuses to clobber a hand-edited owned file without --force", async () => {
    await applyFileSets(repo.root, sets(owned("gen/a.md", "v1\n")), { sourceHash: HASH });
    await repo.write("gen/a.md", "MY OWN CONTENT\n");

    const conflicted = await applyFileSets(repo.root, sets(owned("gen/a.md", "v2\n")), { sourceHash: HASH });
    assert.equal(conflicted.items[0]!.action, "conflict");
    assert.equal(conflicted.conflictCount, 1);
    assert.equal(await read("gen/a.md"), "MY OWN CONTENT\n");

    const forced = await applyFileSets(repo.root, sets(owned("gen/a.md", "v2\n")), {
      sourceHash: HASH,
      force: true,
    });
    assert.equal(forced.items[0]!.action, "updated");
    assert.equal(await read("gen/a.md"), "v2\n");
  });

  it("keeps the previous lockfile hash for a conflicted artifact (recovery path)", async () => {
    await applyFileSets(repo.root, sets(owned("gen/a.md", "v1\n")), { sourceHash: HASH });
    await repo.write("gen/a.md", "HAND EDIT\n");
    await applyFileSets(repo.root, sets(owned("gen/a.md", "v2\n")), { sourceHash: HASH });

    const lock = await readLockfile(repo.root);
    const entry = lock!.artifacts.find((a) => a.path === "gen/a.md");
    assert.equal(entry?.contentHash, sha256("v1\n"), "conflict preserves the last-written hash");
  });

  it("refuses to clobber a hand-edited managed block without --force", async () => {
    await applyFileSets(repo.root, sets(block("AGENTS.md", "rules v1")), { sourceHash: HASH });
    const tampered = (await read("AGENTS.md")).replace("rules v1", "rules v1 EDITED");
    await repo.write("AGENTS.md", tampered);

    const conflicted = await applyFileSets(repo.root, sets(block("AGENTS.md", "rules v2")), { sourceHash: HASH });
    assert.equal(conflicted.items[0]!.action, "conflict");
    assert.ok((await read("AGENTS.md")).includes("EDITED"));

    const forced = await applyFileSets(repo.root, sets(block("AGENTS.md", "rules v2")), {
      sourceHash: HASH,
      force: true,
    });
    assert.equal(forced.items[0]!.action, "updated");
    assert.ok((await read("AGENTS.md")).includes("rules v2"));
    assert.ok(!(await read("AGENTS.md")).includes("EDITED"));
  });
});

describe("applyFileSets — orphan cleanup", () => {
  it("deletes an untouched orphaned owned file when its artifact disappears", async () => {
    await applyFileSets(repo.root, sets(owned("gen/a.md", "AAA\n"), owned("gen/b.md", "BBB\n")), {
      sourceHash: HASH,
    });
    const outcome = await applyFileSets(repo.root, sets(owned("gen/a.md", "AAA\n")), { sourceHash: HASH });
    assert.equal(await exists("gen/b.md"), false, "orphan removed");
    const removal = outcome.items.find((i) => i.path === "gen/b.md");
    assert.equal(removal?.action, "updated");
    assert.match(removal?.detail ?? "", /orphaned/);
    const lock = await readLockfile(repo.root);
    assert.ok(!lock!.artifacts.some((a) => a.path === "gen/b.md"), "orphan leaves the lockfile");
  });

  it("reports a hand-edited orphan as conflict and keeps the file", async () => {
    await applyFileSets(repo.root, sets(owned("gen/b.md", "BBB\n")), { sourceHash: HASH });
    await repo.write("gen/b.md", "USER DATA NOW\n");
    const outcome = await applyFileSets(repo.root, sets(owned("gen/a.md", "AAA\n")), { sourceHash: HASH });
    const item = outcome.items.find((i) => i.path === "gen/b.md");
    assert.equal(item?.action, "conflict");
    assert.equal(await read("gen/b.md"), "USER DATA NOW\n");
  });

  it("strips an orphaned managed block from its host file, keeping user content", async () => {
    await repo.write("AGENTS.md", "# User heading\n");
    await applyFileSets(repo.root, sets(block("AGENTS.md", "ephemeral rules")), { sourceHash: HASH });
    const outcome = await applyFileSets(repo.root, [{ adapter: "test", fileSet: { files: [], warnings: [] } }], {
      sourceHash: HASH,
    });
    const item = outcome.items.find((i) => i.path === "AGENTS.md");
    assert.equal(item?.detail, "removed orphaned block");
    const content = await read("AGENTS.md");
    assert.ok(content.includes("# User heading"));
    assert.ok(!content.includes("ephemeral rules"));
    assert.ok(!content.includes("harness:begin"));
  });

  it("an orphaned managed block hand-edited INSIDE conflicts instead of vanishing", async () => {
    await repo.write("AGENTS.md", "# User heading\n");
    await applyFileSets(repo.root, sets(block("AGENTS.md", "ephemeral rules")), { sourceHash: HASH });
    const tampered = (await read("AGENTS.md")).replace("ephemeral rules", "ephemeral rules + MY NOTES");
    await repo.write("AGENTS.md", tampered);

    const outcome = await applyFileSets(repo.root, [{ adapter: "test", fileSet: { files: [], warnings: [] } }], {
      sourceHash: HASH,
    });
    const item = outcome.items.find((i) => i.path === "AGENTS.md");
    assert.equal(item?.action, "conflict");
    assert.ok((await read("AGENTS.md")).includes("MY NOTES"), "hand-edited block left in place");

    const forced = await applyFileSets(repo.root, [{ adapter: "test", fileSet: { files: [], warnings: [] } }], {
      sourceHash: HASH,
      force: true,
    });
    const forcedItem = forced.items.find((i) => i.path === "AGENTS.md");
    assert.equal(forcedItem?.detail, "removed orphaned block");
    assert.ok(!(await read("AGENTS.md")).includes("MY NOTES"));
  });

  it("a conflicted-but-still-desired artifact is NOT treated as an orphan", async () => {
    await applyFileSets(repo.root, sets(owned("gen/a.md", "v1\n")), { sourceHash: HASH });
    await repo.write("gen/a.md", "HAND EDIT\n");
    // Same artifact still desired: conflict, but never deletion.
    const outcome = await applyFileSets(repo.root, sets(owned("gen/a.md", "v2\n")), { sourceHash: HASH });
    assert.deepEqual(outcome.items.map((i) => i.action), ["conflict"]);
    assert.equal(await exists("gen/a.md"), true);
    assert.equal(outcome.items.filter((i) => i.path === "gen/a.md").length, 1, "one item, not conflict+orphan");
  });
});

describe("applyFileSets — json-merge artifacts", () => {
  it("applies cursor-hooks and opencode-instructions merges and stays idempotent", async () => {
    await repo.write("opencode.json", `${JSON.stringify({ theme: "dark", instructions: ["docs/notes.md"] })}\n`);
    const s = sets(
      {
        path: ".cursor/hooks.json",
        kind: "json-merge",
        mergeStrategy: "cursor-hooks",
        content: JSON.stringify({ stop: ["leina harness hook cursor-stop"] }),
      },
      {
        path: "opencode.json",
        kind: "json-merge",
        mergeStrategy: "opencode-instructions",
        content: ".harness/generated/opencode-rules.md",
      },
    );

    const first = await applyFileSets(repo.root, s, { sourceHash: HASH });
    assert.deepEqual(first.items.map((i) => i.action), ["created", "updated"]);

    const hooks = JSON.parse(await read(".cursor/hooks.json"));
    assert.equal(hooks.version, 1);
    assert.deepEqual(hooks.hooks.stop, [{ command: "leina harness hook cursor-stop" }]);

    const opencode = JSON.parse(await read("opencode.json"));
    assert.equal(opencode.theme, "dark");
    assert.deepEqual(opencode.instructions, ["docs/notes.md", ".harness/generated/opencode-rules.md"]);

    const second = await applyFileSets(repo.root, s, { sourceHash: HASH });
    assert.deepEqual(second.items.map((i) => i.action), ["unchanged", "unchanged"]);
    assert.equal(second.driftCount, 0);
  });

  it("surfaces merge failures as error items without touching the file", async () => {
    await repo.write("opencode.json", "{invalid json");
    const outcome = await applyFileSets(
      repo.root,
      sets({ path: "opencode.json", kind: "json-merge", mergeStrategy: "opencode-instructions", content: "x.md" }),
      { sourceHash: HASH },
    );
    assert.equal(outcome.items[0]!.action, "error");
    assert.equal(outcome.conflictCount, 1);
    assert.equal(await read("opencode.json"), "{invalid json");
  });

  it("rejects a json-merge artifact without a mergeStrategy (adapter bug guard)", async () => {
    const outcome = await applyFileSets(
      repo.root,
      sets({ path: "some.json", kind: "json-merge", content: "{}" }),
      { sourceHash: HASH },
    );
    assert.equal(outcome.items[0]!.action, "error");
    assert.match(outcome.items[0]!.detail ?? "", /mergeStrategy/);
  });
});

describe("AGENTS.md coexistence — leina protocol block + harness managed block", () => {
  it("updates the harness block without disturbing leina's protocol block, and vice versa", async () => {
    const leinaBlock = `${PROTOCOL_START}\n## Leina protocol\n\nRun leina audit before starting.\n${PROTOCOL_END}\n`;
    await repo.write("AGENTS.md", `# Project\n\n${leinaBlock}`);

    // Real adapter output, not a synthetic body.
    const bundle: RuleBundle = {
      rules: [
        {
          id: "harness/tests-pass",
          version: 1,
          phase: "verify",
          severity: "blocking",
          scope: {},
          enabled: true,
          tags: [],
          summary: "Tests must pass.",
          body: "# Tests must pass",
          sourcePath: "/r.md",
          layer: "builtin",
        } satisfies Rule,
      ],
      recipes: [],
      config: defaultHarnessConfig(),
      digest: HASH,
    };
    const fileSet = await agentsmdAdapter.generate(bundle, { repoRoot: repo.root });
    const apply = () =>
      applyFileSets(repo.root, [{ adapter: "agentsmd", fileSet }], { sourceHash: HASH });

    const first = await apply();
    assert.equal(first.items[0]!.action, "created");
    let content = await read("AGENTS.md");
    assert.ok(content.startsWith("# Project"), "user heading untouched");
    assert.ok(content.includes(PROTOCOL_START) && content.includes(PROTOCOL_END), "leina block intact");
    assert.ok(content.includes("Run leina audit before starting."));
    assert.ok(content.includes("harness:begin id=harness-core adapter=agentsmd"));

    // leina rewrites ITS block (as `leina init` would) — harness must not care.
    content = content.replace("Run leina audit before starting.", "Run leina audit v2.");
    await repo.write("AGENTS.md", content);
    const second = await apply();
    assert.equal(second.items[0]!.action, "unchanged", "harness block untouched by leina's own update");

    // harness updates ITS block — leina's edited block must survive byte-for-byte.
    const bundleV2 = { ...bundle, rules: [{ ...bundle.rules[0]!, summary: "Tests must REALLY pass." }] };
    const fileSetV2 = await agentsmdAdapter.generate(bundleV2, { repoRoot: repo.root });
    const third = await applyFileSets(repo.root, [{ adapter: "agentsmd", fileSet: fileSetV2 }], {
      sourceHash: HASH,
    });
    assert.equal(third.items[0]!.action, "updated");
    const final = await read("AGENTS.md");
    assert.ok(final.includes("Run leina audit v2."), "leina block preserved");
    assert.ok(final.includes("Tests must REALLY pass."), "harness block updated");
    assert.equal(final.match(/harness:begin/g)?.length, 1, "exactly one harness block");
  });
});
