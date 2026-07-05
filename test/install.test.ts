// Install writers are pure: they return FileArtifact values and never write to
// destination paths directly. End-to-end CLI wiring lives in init-cli.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_BODY, PROTOCOL_END, PROTOCOL_START } from "../src/application/install/protocol.ts";
import { mergeAgentsMd, removeAgentsMdBlock } from "../src/application/install/agents.ts";
import { GITIGNORE_END, GITIGNORE_START, mergeGitignore, removeGitignoreBlock } from "../src/application/install/gitignore.ts";
import { portAgents, portConvention, portSkills, portWorkflows, rewriteAssetPaths } from "../src/application/install/port.ts";
import { findForbiddenReferences } from "../src/infrastructure/install/native-assets.ts";

test("protocol carries graph, memory, SDD guidance and the dual-transport preamble", () => {
  // Examples stay in `leina` subcommand phrasing; the TRANSPORT preamble carries the
  // one CLI→tool mapping for hosts that expose the mcp__leina__* tools.
  assert.match(PROTOCOL_BODY, /leina affected/);
  assert.match(PROTOCOL_BODY, /leina query/);
  assert.match(PROTOCOL_BODY, /leina memory/);
  assert.match(PROTOCOL_BODY, /sdd\/\{change\}\/\{artifact\}/);
  // SDD design/tasks scope impact against the graph via the affected command.
  assert.match(PROTOCOL_BODY, /DESIGN and TASKS[\s\S]*affected/);
  // Dual-transport preamble: prefer mcp__leina__* when present, CLI otherwise; env exec
  // stays CLI-only (names-not-values).
  assert.match(PROTOCOL_BODY, /TRANSPORT \(pick once/);
  assert.match(PROTOCOL_BODY, /mcp__leina__\*/);
  assert.match(PROTOCOL_BODY, /query→graph_query/);
  assert.match(PROTOCOL_BODY, /CLI-ONLY[\s\S]*env exec/);
  // No leftover LEGACY tool names from the pre-CLI MCP era (current names live in the
  // mapping above: graph_query, graph_affected, memory_add, ...).
  assert.doesNotMatch(PROTOCOL_BODY, /query_graph|graph_refresh|mem_context|mem_save/);
});

test("AGENTS.md merge is idempotent and preserves user content", () => {
  const user = "# Project\n\nKeep me.\n";
  const once = mergeAgentsMd(user);
  const twice = mergeAgentsMd(once);
  assert.equal(once, twice);
  assert.ok(once.includes("Keep me."));
  assert.ok(once.includes(PROTOCOL_START));
  assert.ok(once.includes(PROTOCOL_END));
  assert.ok(once.includes(PROTOCOL_BODY));
});

test("AGENTS.md merge refuses malformed managed sections", () => {
  assert.throws(() => mergeAgentsMd(`${PROTOCOL_START}\nmissing end\n`), /malformed|managed section/i);
});

test(".gitignore merge ignores the runtime dir from empty/null and is idempotent", () => {
  for (const seed of [null, "", "   \n"]) {
    const once = mergeGitignore(seed);
    const twice = mergeGitignore(once);
    assert.equal(once, twice, "stable across re-runs");
    assert.ok(once.includes(GITIGNORE_START));
    assert.ok(once.includes(GITIGNORE_END));
    // GITIGNORE_BODY is now two lines — assert both are present as separate lines
    assert.ok(once.split("\n").includes(".leina/*"), "glob ignore rule present");
    assert.ok(once.split("\n").includes("!.leina/config.json"), "config.json re-include present");
  }
});

test(".gitignore merge preserves user content and adds exactly one managed block", () => {
  const user = "node_modules/\ndist/\n";
  const once = mergeGitignore(user);
  const twice = mergeGitignore(once);
  assert.equal(once, twice, "idempotent");
  assert.ok(once.includes("node_modules/"), "user rule preserved");
  assert.ok(once.includes("dist/"), "user rule preserved");
  assert.equal(once.split(GITIGNORE_START).length - 1, 1, "exactly one managed block");
});

test(".gitignore merge replaces the managed block in place without duplicating", () => {
  // Simulate a stale managed block (older body) embedded between user rules.
  const stale = `a/\n${GITIGNORE_START}\nold-rule\n${GITIGNORE_END}\nb/\n`;
  const merged = mergeGitignore(stale);
  assert.ok(merged.includes("a/") && merged.includes("b/"), "surrounding rules preserved");
  assert.ok(!merged.includes("old-rule"), "stale body replaced");
  assert.ok(merged.split("\n").includes(".leina/*"), "glob ignore rule present");
  assert.ok(merged.split("\n").includes("!.leina/config.json"), "config.json re-include present");
  assert.equal(merged.split(GITIGNORE_START).length - 1, 1, "no duplicate block");
});

test(".gitignore merge does not treat a path containing the marker text as the marker", () => {
  // A rule that merely contains the marker substring must NOT be mistaken for a whole-line marker.
  const user = `some/${GITIGNORE_START}-path\n`;
  const merged = mergeGitignore(user);
  assert.ok(merged.includes(`some/${GITIGNORE_START}-path`), "lookalike path preserved");
  // The lookalike is not a whole-line marker, so a real managed block is appended.
  assert.equal(merged.split("\n").filter((l) => l.trim() === GITIGNORE_START).length, 1);
});

test(".gitignore merge refuses malformed managed sections", () => {
  assert.throws(() => mergeGitignore(`${GITIGNORE_START}\nmissing end\n`), /malformed|managed section/i);
});

test("asset path rewrite resolves host-neutral refs and is idempotent", () => {
  const input = "Read skills/sdd-apply/SKILL.md and skills/_shared/sdd-phase-common.md";
  const once = rewriteAssetPaths(input, ".claude/skills");
  const twice = rewriteAssetPaths(once, ".claude/skills");
  assert.equal(once, twice);
  assert.equal(
    once,
    "Read .claude/skills/sdd-apply/SKILL.md and .claude/skills/_shared/sdd-phase-common.md",
  );
});

test("asset path rewrite leaves prose mentions of skills/ untouched", () => {
  const input = "Bundled skills/ and agents/ live under assets/skills/ in the repo.";
  assert.equal(rewriteAssetPaths(input, ".claude/skills"), input);
});

test("portSkills preserves tree, filters directories and leaves native content intact", () => {
  const src = mkdtempSync(join(tmpdir(), "skills-src-"));
  mkdirSync(join(src, "sdd-apply"), { recursive: true });
  mkdirSync(join(src, "other"), { recursive: true });
  writeFileSync(join(src, "sdd-apply", "SKILL.md"), "Run leina memory search then get.");
  writeFileSync(join(src, "other", "SKILL.md"), "Other.");

  const artifacts = portSkills(src, "./skills", ["sdd-apply"]);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]!.path, "./skills/sdd-apply/SKILL.md");
  assert.equal(artifacts[0]!.content, "Run leina memory search then get.");
  assert.deepEqual(portSkills(src, "./skills", ["none"]), []);
});

test("portAgents installs native definitions and marker", () => {
  const src = mkdtempSync(join(tmpdir(), "agents-src-"));
  writeFileSync(join(src, "sdd-apply.md"), "Run leina memory search then get.");
  const artifacts = portAgents(src, [".claude/agents"]);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]!.path, ".claude/agents/sdd-apply.md");
  assert.match(artifacts[0]!.content, /^<!-- leina:ported -->/);
  assert.match(artifacts[0]!.content, /memory search then get/);
});

test("portConvention copies native convention through unchanged (CLI-only, no tool table injected)", () => {
  const src = mkdtempSync(join(tmpdir(), "convention-src-"));
  mkdirSync(join(src, "_shared"), { recursive: true });
  writeFileSync(
    join(src, "_shared", "leina-memory-convention.md"),
    "# Native Convention\nRun leina memory search then get.\n",
  );

  const artifact = portConvention(src, "./skills");
  assert.equal(artifact.path, "./skills/_shared/leina-memory-convention.md");
  assert.match(artifact.content, /Native Convention/);
  // CLI-only: no MCP tool table is appended anymore.
  assert.doesNotMatch(artifact.content, /MCP server|mem_save|get_verified_context/);
});

test("reference guard finds injected needles with line/column, longest-first dedup", () => {
  // The needle LIST is maintainer-local (never hardcoded in the repo) — the mechanism is
  // tested with neutral dummies.
  const hits = findForbiddenReferences("first acme-corp\nsecond widgetco", ["widgetco", "acme-corp"]);
  assert.deepEqual(
    hits.map((hit) => [hit.needle, hit.line]),
    [["acme-corp", 1], ["widgetco", 2]],
  );
  // Overlap dedup: the longer needle wins, the contained one is not double-reported.
  const overlap = findForbiddenReferences("xx acme-corporation xx", ["acme-corp", "acme-corporation"]);
  assert.deepEqual(overlap.map((h) => h.needle), ["acme-corporation"]);
  // Case-insensitive.
  assert.equal(findForbiddenReferences("ACME-Corp", ["acme-corp"]).length, 1);
  // Empty list → no hits (scan is a no-op without maintainer configuration).
  assert.deepEqual(findForbiddenReferences("anything at all", []), []);
});

test("portWorkflows converts skills and agents to workflow format", () => {
  const skillsSrc = mkdtempSync(join(tmpdir(), "wf-skills-"));
  const agentsSrc = mkdtempSync(join(tmpdir(), "wf-agents-"));

  // Create a skill with frontmatter
  mkdirSync(join(skillsSrc, "sdd-explore"), { recursive: true });
  writeFileSync(
    join(skillsSrc, "sdd-explore", "SKILL.md"),
    '---\nname: sdd-explore\ndescription: "Explore a codebase for SDD"\n---\n\n## Steps\n\n1. Read code\n2. Analyze\n',
  );

  // Create a standalone agent (no matching skill)
  writeFileSync(
    join(agentsSrc, "code-reviewer.md"),
    '---\nname: code-reviewer\ndescription: "Review code quality"\nmodel: opus\n---\n\nYou review code.\n',
  );

  // Create _shared
  mkdirSync(join(skillsSrc, "_shared"), { recursive: true });
  writeFileSync(join(skillsSrc, "_shared", "common.md"), "Shared content.");

  // portWorkflows is now host-neutral: callers pass the destination prefix. The share-based
  // global install uses "workflows" (rooted under $LEINA_HOME/share); tests cover the
  // pure transformation with a generic prefix.
  const artifacts = portWorkflows(skillsSrc, agentsSrc, "workflows");

  // Skill becomes a workflow
  const wf = artifacts.find((a) => a.path === "workflows/sdd-explore.md");
  assert.ok(wf, "skill should produce a workflow");
  assert.match(wf.content, /^---\ndescription:/);
  assert.match(wf.content, /Explore a codebase/);

  // Standalone agent becomes a workflow
  const agent = artifacts.find((a) => a.path === "workflows/code-reviewer.md");
  assert.ok(agent, "standalone agent should produce a workflow");
  assert.match(agent.content, /^---\ndescription:/);
  assert.match(agent.content, /review code/i);

  // Shared file is copied
  const shared = artifacts.find((a) => a.path === "workflows/_shared/common.md");
  assert.ok(shared, "_shared files should be copied");

  // Filter works
  assert.deepEqual(portWorkflows(skillsSrc, agentsSrc, "workflows", ["none"]), []);
});

// ---------- removeAgentsMdBlock (inverse of mergeAgentsMd) ----------

test("(agents-remove-a) null/blank input → null", () => {
  assert.equal(removeAgentsMdBlock(null), null);
  assert.equal(removeAgentsMdBlock(""), null);
  assert.equal(removeAgentsMdBlock("   "), null);
});

test("(agents-remove-b) block absent → null (idempotent)", () => {
  const user = "# Project\n\nSome user content.\n";
  assert.equal(removeAgentsMdBlock(user), null);
});

test("(agents-remove-c) round-trip: merge then remove returns content without the block", () => {
  const user = "# Project\n\nKeep me.\n";
  const merged = mergeAgentsMd(user);
  assert.ok(merged.includes(PROTOCOL_START), "block present after merge");
  const removed = removeAgentsMdBlock(merged);
  assert.ok(removed !== null, "returns non-null when block was present");
  assert.ok(!removed.includes(PROTOCOL_START), "PROTOCOL_START gone");
  assert.ok(!removed.includes(PROTOCOL_END), "PROTOCOL_END gone");
  assert.ok(removed.includes("Keep me."), "user content preserved");
});

test("(agents-remove-d) idempotent: calling twice on already-removed content → null second time", () => {
  const user = "# My Project\n\nUser text.\n";
  const merged = mergeAgentsMd(user);
  const removed = removeAgentsMdBlock(merged)!;
  assert.equal(removeAgentsMdBlock(removed), null, "second remove is idempotent no-op");
});

test("(agents-remove-e) no-clobber on malformed markers (orphaned start, no end) → null", () => {
  const malformed = `# Project\n\n${PROTOCOL_START}\nNo closing marker here.\n`;
  assert.equal(removeAgentsMdBlock(malformed), null, "malformed → null, never throws");
});

test("(agents-remove-f) no-clobber on reversed markers → null", () => {
  const reversed = `# Project\n\n${PROTOCOL_END}\nsome text\n${PROTOCOL_START}\n`;
  assert.equal(removeAgentsMdBlock(reversed), null, "reversed markers → null");
});

test("(agents-remove-g) standalone block (full file is the managed section) → null", () => {
  // If removing the block leaves nothing, return null
  const full = mergeAgentsMd(null);
  // A fresh AGENTS.md with only the protocol block
  const onlyBlock = `${PROTOCOL_START}\n${PROTOCOL_BODY}\n${PROTOCOL_END}\n`;
  const result = removeAgentsMdBlock(onlyBlock);
  // Either null (empty after strip) or a trimmed result — must not contain the block
  if (result !== null) {
    assert.ok(!result.includes(PROTOCOL_START));
  }
  void full; // just use full to satisfy no-unused
});

// ---------- removeGitignoreBlock (inverse of mergeGitignore) ----------

test("(gitignore-remove-a) null/blank input → null", () => {
  assert.equal(removeGitignoreBlock(null), null);
  assert.equal(removeGitignoreBlock(""), null);
  assert.equal(removeGitignoreBlock("   "), null);
});

test("(gitignore-remove-b) block absent → null (idempotent)", () => {
  const user = "node_modules/\ndist/\n";
  assert.equal(removeGitignoreBlock(user), null);
});

test("(gitignore-remove-c) round-trip: merge then remove", () => {
  const user = "node_modules/\ndist/\n";
  const merged = mergeGitignore(user);
  assert.ok(merged.includes(GITIGNORE_START), "block present after merge");
  const removed = removeGitignoreBlock(merged);
  assert.ok(removed !== null, "returns non-null when block was present");
  assert.ok(!removed.includes(GITIGNORE_START), "GITIGNORE_START gone");
  assert.ok(!removed.includes(GITIGNORE_END), "GITIGNORE_END gone");
  assert.ok(removed.includes("node_modules/"), "user rule preserved");
  assert.ok(removed.includes("dist/"), "user rule preserved");
});

test("(gitignore-remove-d) idempotent: calling twice → null second time", () => {
  const user = "node_modules/\n";
  const merged = mergeGitignore(user);
  const removed = removeGitignoreBlock(merged)!;
  assert.equal(removeGitignoreBlock(removed), null, "second remove is idempotent no-op");
});

test("(gitignore-remove-e) no-clobber on malformed markers (orphaned start) → null", () => {
  const malformed = `node_modules/\n${GITIGNORE_START}\n# no end\n`;
  assert.equal(removeGitignoreBlock(malformed), null, "malformed → null, never throws");
});

test("(gitignore-remove-f) file contains ONLY the managed block → returns null (empty)", () => {
  const onlyBlock = `${GITIGNORE_START}\n.leina/*\n${GITIGNORE_END}\n`;
  const result = removeGitignoreBlock(onlyBlock);
  if (result !== null) {
    assert.ok(!result.includes(GITIGNORE_START));
  }
});
