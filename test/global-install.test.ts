// Tests for the global install pipeline: share-paths + symlinks + global.installGlobal.
//
// All tests redirect LEINA_HOME and HOME to a per-test tmp dir, so they never touch the
// developer's real ~/.leina / ~/.config/devin / ~/.codeium. Sandbox-safe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blanketFile,
  leinaHome,
  devinAgentsRoot,
  devinSkillsRoot,
  shareAgentsDir,
  shareRoot,
  shareSelectionFile,
  shareSkillsDir,
  shareVersionFile,
  shareWorkflowsDir,
} from "../src/infrastructure/install/share-paths.ts";
import { serializeSelection } from "../src/application/install/catalog.ts";
import {
  __setSymlinkImplForTests,
  copyTree,
  linkOrCopy,
  normalizeLinkTarget,
  symlinkTypeFor,
  unlinkIfManaged,
} from "../src/infrastructure/install/symlinks.ts";
import {
  buildClaudeAgentArtifact,
  buildDevinAgentArtifact,
  buildDevinSkillArtifact,
  buildDevinArtifactsFromAgents,
} from "../src/application/install/devin-skills.ts";
import { installGlobal, inspectHostLinks, isBlanketActive, isGlobalActivated, maybeHealShare, populateShare, unlinkHosts } from "../src/infrastructure/install/global.ts";

// ---- env helpers --------------------------------------------------------

function withTmpHome<T>(fn: (homeDir: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "leina-global-"));
  const saved = {
    LEINA_HOME: process.env.LEINA_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
  };
  process.env.LEINA_HOME = join(home, ".leina");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Point APPDATA into the sandbox so devinConfigRoot() resolves to <home>/.config/devin
  // on Windows too — the exact path these tests assert on every platform.
  process.env.APPDATA = join(home, ".config");
  try {
    return fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

// ---- share-paths.ts -----------------------------------------------------

test("(sp-a) leinaHome honours LEINA_HOME override", () => {
  withTmpHome((home) => {
    assert.equal(leinaHome(), join(home, ".leina"));
    assert.equal(shareRoot(), join(home, ".leina", "share"));
    assert.equal(shareSkillsDir(), join(home, ".leina", "share", "skills"));
    assert.equal(shareAgentsDir(), join(home, ".leina", "share", "agents"));
    assert.equal(shareWorkflowsDir(), join(home, ".leina", "share", "workflows"));
    assert.equal(shareVersionFile(), join(home, ".leina", "share", ".version"));
  });
});

test("(sp-b) host roots derive from $HOME on non-Windows", () => {
  withTmpHome((home) => {
    assert.equal(devinSkillsRoot(), join(home, ".config", "devin", "skills"));
    assert.equal(devinAgentsRoot(), join(home, ".config", "devin", "agents"));
  });
});

// ---- symlinks.ts --------------------------------------------------------

test("(sym-a) linkOrCopy creates a symlink first time; unchanged on rerun", () => {
  withTmpHome((home) => {
    const src = join(home, "src");
    const dest = join(home, "dest");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "marker.md"), "hi");
    const first = linkOrCopy(src, dest);
    // Directories link as junctions on win32 (no privilege needed), so the same
    // assertions hold on every platform — lstat reports junctions as symlinks.
    assert.equal(first.action, "symlinked");
    assert.ok(lstatSync(dest).isSymbolicLink(), "destination is a symlink");
    const second = linkOrCopy(src, dest);
    assert.equal(second.action, "unchanged", "second run is a no-op");
  });
});

test("(sym-b) linkOrCopy refuses to clobber wrong target; backs up and replaces", () => {
  withTmpHome((home) => {
    const src = join(home, "src");
    const wrongSrc = join(home, "other");
    const dest = join(home, "dest");
    mkdirSync(src, { recursive: true });
    mkdirSync(wrongSrc, { recursive: true });
    writeFileSync(join(src, "marker.md"), "right");
    writeFileSync(join(wrongSrc, "marker.md"), "wrong");
    // Pre-seed a symlink to the wrong target.
    symlinkSync(wrongSrc, dest, "dir");
    const result = linkOrCopy(src, dest);
    assert.equal(result.action, "backed-up-and-replaced");
    assert.ok(result.backup && existsSync(result.backup), "previous symlink backed up");
    assert.equal(
      resolve(normalizeLinkTarget(readlinkSync(dest))),
      resolve(src),
      "destination now points to the requested source",
    );
  });
});

test("(sym-w1) symlinkTypeFor: directories become junctions on win32 (no privilege/Developer Mode needed), dir symlinks elsewhere", () => {
  assert.equal(symlinkTypeFor(true, "win32"), "junction");
  assert.equal(symlinkTypeFor(false, "win32"), "file");
  assert.equal(symlinkTypeFor(true, "linux"), "dir");
  assert.equal(symlinkTypeFor(true, "darwin"), "dir");
  assert.equal(symlinkTypeFor(false, "linux"), "file");
});

test("(sym-w2) normalizeLinkTarget strips Windows extended-length prefixes so junction targets compare equal", () => {
  assert.equal(normalizeLinkTarget("\\\\?\\C:\\Users\\x\\.leina\\share\\skills\\a"), "C:\\Users\\x\\.leina\\share\\skills\\a");
  assert.equal(normalizeLinkTarget("\\\\?\\UNC\\srv\\share\\dir"), "\\\\srv\\share\\dir");
  assert.equal(normalizeLinkTarget("/home/u/.leina/share/skills/a"), "/home/u/.leina/share/skills/a");
});

test("(sym-w3) EPERM from symlink creation falls back to a real copy (Windows file links without Developer Mode)", () => {
  withTmpHome((home) => {
    const src = join(home, "src");
    const dest = join(home, "dest");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "marker.md"), "hi");
    __setSymlinkImplForTests(() => {
      const e = new Error("EPERM: operation not permitted, symlink") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });
    try {
      const result = linkOrCopy(src, dest);
      assert.equal(result.action, "copied", "EPERM degrades to a copy, not a failure");
      assert.ok(!lstatSync(dest).isSymbolicLink(), "fallback produced a real directory");
      assert.equal(readFileSync(join(dest, "marker.md"), "utf8"), "hi", "contents copied");
      // Deactivate/uninstall must never delete the copy: it is not a managed symlink.
      assert.equal(unlinkIfManaged(dest, src), false, "copy fallback is left alone by unlinkIfManaged");
      assert.ok(existsSync(join(dest, "marker.md")), "copy untouched after unlinkIfManaged");
    } finally {
      __setSymlinkImplForTests(null);
    }
  });
});

test("(sym-w4) unexpected symlink errors still throw (only EPERM/EACCES/ENOTSUP degrade to copy)", () => {
  withTmpHome((home) => {
    const src = join(home, "src");
    mkdirSync(src, { recursive: true });
    __setSymlinkImplForTests(() => {
      const e = new Error("EINVAL: invalid argument, symlink") as NodeJS.ErrnoException;
      e.code = "EINVAL";
      throw e;
    });
    try {
      assert.throws(() => linkOrCopy(src, join(home, "dest")), /EINVAL/);
    } finally {
      __setSymlinkImplForTests(null);
    }
  });
});

test("(sym-c) copyTree preserves nested structure", () => {
  withTmpHome((home) => {
    const src = join(home, "tree-src");
    const dest = join(home, "tree-dest");
    mkdirSync(join(src, "a", "b"), { recursive: true });
    writeFileSync(join(src, "a", "b", "leaf.md"), "leaf");
    writeFileSync(join(src, "top.md"), "top");
    copyTree(src, dest);
    assert.equal(readFileSync(join(dest, "top.md"), "utf8"), "top");
    assert.equal(readFileSync(join(dest, "a", "b", "leaf.md"), "utf8"), "leaf");
  });
});

// ---- devin-skills.ts ----------------------------------------------------

const SAMPLE_AGENT = `---
name: sample-agent
description: >
  Sample agent description that spans
  multiple lines to test the folded yaml parser.
model: opus
tools: Read, Edit, mem_save
---

Body content here.
`;

test("(ds-a) buildDevinAgentArtifact emits valid Devin AGENT.md frontmatter + body", () => {
  const art = buildDevinAgentArtifact("sample-agent", SAMPLE_AGENT);
  assert.equal(art.path, "agents/sample-agent/AGENT.md");
  assert.match(art.content, /^---\nname: sample-agent\n/);
  assert.match(art.content, /description: Sample agent description/);
  assert.match(art.content, /model: opus\n/);
  assert.match(art.content, /\nBody content here\./);
  assert.doesNotMatch(art.content, /tools: Read/, "drops legacy `tools:` field");
});

test("(ds-b) buildDevinSkillArtifact emits a thin delegator with `agent:` frontmatter", () => {
  const art = buildDevinSkillArtifact("sample-agent", SAMPLE_AGENT);
  assert.equal(art.path, "skills/sample-agent/SKILL.md");
  assert.match(art.content, /^---\nname: sample-agent\n/);
  assert.match(art.content, /agent: sample-agent\n/);
  assert.match(art.content, /triggers:\s*\n\s+- user\s*\n\s+- model/);
  assert.match(art.content, /\$ARGUMENTS/);
});

test("(ds-c) buildDevinArtifactsFromAgents emits AGENT + SKILL + claude agent per *.md", () => {
  withTmpHome((home) => {
    const src = join(home, "agents-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "alpha.md"), "---\nname: alpha\n---\nA body\n");
    writeFileSync(join(src, "beta.md"), "---\nname: beta\n---\nB body\n");
    writeFileSync(join(src, "README.txt"), "ignore me");
    const arts = buildDevinArtifactsFromAgents(src);
    const paths = arts.map((a) => a.path).sort();
    assert.deepEqual(paths, [
      "agents/alpha/AGENT.md",
      "agents/beta/AGENT.md",
      "claude-agents/alpha.md",
      "claude-agents/beta.md",
      "skills/alpha/SKILL.md",
      "skills/beta/SKILL.md",
    ]);
  });
});

test("(ds-e) buildClaudeAgentArtifact keeps native frontmatter and inlines the methodology", () => {
  const agentMd = `---\nname: sample-agent\ndescription: d\nmodel: sonnet\ntools: Read, Bash\n---\n## Instructions\n\n` +
    "Read the skill file at `skills/sample-agent/SKILL.md` and follow it exactly.\n";
  const art = buildClaudeAgentArtifact("sample-agent", agentMd, SAMPLE_SKILL);
  assert.equal(art.path, "claude-agents/sample-agent.md");
  // Claude reads the bundled frontmatter natively — it must survive verbatim (tools included).
  assert.match(art.content, /tools: Read, Bash/);
  // The dangling self-reference is replaced by the real methodology.
  assert.doesNotMatch(art.content, /Read the skill file at `skills\/sample-agent\/SKILL\.md`/);
  assert.match(art.content, /Do the real work here\. This is the executor methodology\./);
});

const SAMPLE_SKILL = `---
name: sample-agent
description: methodology for the sample agent
---

## Step 1
Do the real work here. This is the executor methodology.
`;

test("(ds-d) buildDevinAgentArtifact inlines a matching skill methodology + drops the dangling self-ref", () => {
  const agentMd = `---\nname: sample-agent\ndescription: d\nmodel: sonnet\n---\n## Instructions\n\n` +
    "Read the skill file at `skills/sample-agent/SKILL.md` and follow it exactly.\n" +
    "Also read shared conventions at `skills/_shared/sdd-phase-common.md`.\n";
  const art = buildDevinAgentArtifact("sample-agent", agentMd, SAMPLE_SKILL);
  // The dangling self-reference is gone (that path holds the thin delegator in the share).
  assert.doesNotMatch(art.content, /Read the skill file at `skills\/sample-agent\/SKILL\.md`/);
  // The real methodology is inlined.
  assert.match(art.content, /Do the real work here\. This is the executor methodology\./);
  // The skill's frontmatter is NOT inlined.
  assert.doesNotMatch(art.content, /description: methodology for the sample agent/);
  // _shared reference (not clobbered at install) is preserved.
  assert.match(art.content, /skills\/_shared\/sdd-phase-common\.md/);
});

test("(ds-d2) buildDevinAgentArtifact inlines _shared protocol + hoists EXECUTOR_PREAMBLE when methodology references it", () => {
  const agentMd = `---\nname: sample-agent\ndescription: d\nmodel: sonnet\n---\n## Instructions\n\n` +
    "Read the skill file at `skills/sample-agent/SKILL.md` and follow it exactly.\n";
  const skillMd = `---\nname: sample-agent\ndescription: m\n---\n\n` +
    "## Step 1\nFollow **Section A** from `skills/_shared/sdd-phase-common.md`.\n";
  const sharedCommon = `# SDD Phase — Common Protocol\n\n## 0. MANDATORY preamble\nUNIQUE_SHARED_MARKER body.\n`;
  const art = buildDevinAgentArtifact("sample-agent", agentMd, skillMd, sharedCommon);
  // The shared protocol BODY is inlined (not just referenced by path).
  assert.match(art.content, /UNIQUE_SHARED_MARKER body\./, "shared protocol inlined into AGENT.md");
  assert.match(art.content, /Shared phase protocol \(inlined from/);
  // The compact preamble is hoisted to the very TOP of the body (before the methodology).
  assert.match(art.content, /EXECUTOR PREAMBLE — do this FIRST/);
  const preIdx = art.content.indexOf("EXECUTOR PREAMBLE");
  const methIdx = art.content.indexOf("UNIQUE_SHARED_MARKER");
  assert.ok(preIdx >= 0 && preIdx < methIdx, "preamble precedes the inlined methodology");
});

test("(ds-d3) buildDevinAgentArtifact does NOT hoist the preamble when methodology has no _shared ref", () => {
  const agentMd = `---\nname: sample-agent\ndescription: d\nmodel: sonnet\n---\n## Instructions\n\n` +
    "Read the skill file at `skills/sample-agent/SKILL.md` and follow it exactly.\n";
  const sharedCommon = `# SDD Phase — Common Protocol\n\nbody.\n`;
  // SAMPLE_SKILL does not mention sdd-phase-common → no inline, no preamble.
  const art = buildDevinAgentArtifact("sample-agent", agentMd, SAMPLE_SKILL, sharedCommon);
  assert.doesNotMatch(art.content, /EXECUTOR PREAMBLE/);
  assert.doesNotMatch(art.content, /Shared phase protocol \(inlined from/);
});

test("(ds-e) buildDevinAgentArtifact without a skill keeps the body verbatim (standalone agent)", () => {
  const art = buildDevinAgentArtifact("sample-agent", SAMPLE_AGENT);
  assert.match(art.content, /\nBody content here\./);
  assert.doesNotMatch(art.content, /executor methodology/);
});

// ---- global.ts ----------------------------------------------------------

/** Build a minimal assets/ tree for installGlobal to consume. */
function makeFakeAssetsRoot(homeDir: string): string {
  const assets = join(homeDir, "assets");
  mkdirSync(join(assets, "skills", "leina-sdd"), { recursive: true });
  mkdirSync(join(assets, "agents"), { recursive: true });
  writeFileSync(
    join(assets, "skills", "leina-sdd", "SKILL.md"),
    "---\nname: leina-sdd\ndescription: orchestrator\n---\n\nOrchestrator body\n",
  );
  writeFileSync(
    join(assets, "agents", "sdd-explore.md"),
    "---\nname: sdd-explore\ndescription: explore phase\nmodel: sonnet\n---\n## Instructions\n\n" +
      "Read the skill file at `skills/sdd-explore/SKILL.md` and follow it exactly.\n" +
      "Also read shared conventions at `skills/_shared/sdd-phase-common.md`.\n",
  );
  // Matching methodology skill — its body must be inlined into the generated AGENT.md.
  mkdirSync(join(assets, "skills", "sdd-explore"), { recursive: true });
  writeFileSync(
    join(assets, "skills", "sdd-explore", "SKILL.md"),
    "---\nname: sdd-explore\ndescription: explore methodology\n---\n\nSTEP ONE: investigate the codebase.\n",
  );
  // leina-setup: bootstrap skill that ships with every activate run.
  mkdirSync(join(assets, "skills", "leina-setup"), { recursive: true });
  writeFileSync(
    join(assets, "skills", "leina-setup", "SKILL.md"),
    "---\nname: leina-setup\ndescription: Bootstrap leina in a fresh project.\ntriggers:\n  - user\n  - model\n---\n\nBootstrap body\n",
  );
  return assets;
}

test("(gi-a) populateShare writes skills/agents/workflows + .version sentinel", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    const wrote = populateShare(assets, "1.0.0-test");
    assert.equal(wrote, true);
    assert.ok(existsSync(join(shareSkillsDir(), "leina-sdd", "SKILL.md")), "orchestrator skill copied");
    assert.ok(existsSync(join(shareSkillsDir(), "sdd-explore", "SKILL.md")), "generated delegator skill present");
    assert.ok(existsSync(join(shareAgentsDir(), "sdd-explore", "AGENT.md")), "generated AGENT profile present");
    assert.equal(readFileSync(shareVersionFile(), "utf8").trim(), "1.0.0-test");
  });
});

test("(gi-a2) populateShare inlines methodology into AGENT.md; skills/<name>/SKILL.md stays the thin delegator", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    populateShare(assets, "1.0.0-test");
    const agentMd = readFileSync(join(shareAgentsDir(), "sdd-explore", "AGENT.md"), "utf8");
    // Self-contained: methodology inlined, dangling self-ref removed.
    assert.match(agentMd, /STEP ONE: investigate the codebase\./, "methodology inlined into AGENT.md");
    assert.doesNotMatch(agentMd, /Read the skill file at `skills\/sdd-explore\/SKILL\.md`/, "dangling self-ref dropped");
    // The share skill path is the thin delegator, not the methodology.
    const skillMd = readFileSync(join(shareSkillsDir(), "sdd-explore", "SKILL.md"), "utf8");
    assert.match(skillMd, /\$ARGUMENTS/, "skills/<name>/SKILL.md is the thin delegator");
    assert.doesNotMatch(skillMd, /STEP ONE: investigate the codebase\./, "delegator does NOT carry the methodology");
  });
});

test("(gi-a3) populateShare resolves skills/... refs in share skills to absolute share paths", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    // The orchestrator references the shared protocol with the host-neutral form.
    writeFileSync(
      join(assets, "skills", "leina-sdd", "SKILL.md"),
      "---\nname: leina-sdd\ndescription: orchestrator\n---\n\nSee `skills/_shared/sdd-phase-common.md` for the protocol.\n",
    );
    populateShare(assets, "1.0.0-test");
    const skillMd = readFileSync(join(shareSkillsDir(), "leina-sdd", "SKILL.md"), "utf8");
    // A linked copy is read from an arbitrary project cwd — only an absolute path resolves.
    assert.match(skillMd, new RegExp(`\`${shareSkillsDir().replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}/_shared/sdd-phase-common\\.md\``));
    assert.doesNotMatch(skillMd, /`skills\/_shared\/sdd-phase-common\.md`/);
  });
});

test("(gi-a4) populateShare ships a self-contained Claude agent (methodology inlined)", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    populateShare(assets, "1.0.0-test");
    const claudeMd = readFileSync(join(shareRoot(), "claude-agents", "sdd-explore.md"), "utf8");
    assert.match(claudeMd, /STEP ONE: investigate the codebase\./, "methodology inlined");
    assert.doesNotMatch(
      claudeMd,
      /Read the skill file at `skills\/sdd-explore\/SKILL\.md`/,
      "dangling self-ref dropped (that share path holds the thin delegator)",
    );
    // Native frontmatter survives (model line untouched).
    assert.match(claudeMd, /model: sonnet/);
  });
});

test("(gi-b) populateShare is idempotent when version matches", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    populateShare(assets, "1.0.0-test");
    const repopulated = populateShare(assets, "1.0.0-test");
    assert.equal(repopulated, false, "second call with same version is a no-op");
  });
});

test("(gi-c) populateShare re-runs when version changes", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    populateShare(assets, "1.0.0-test");
    const repopulated = populateShare(assets, "1.1.0-test");
    assert.equal(repopulated, true, "version bump triggers repopulate");
    assert.equal(readFileSync(shareVersionFile(), "utf8").trim(), "1.1.0-test");
  });
});

test("(gi-d) installGlobal symlinks every skill+agent into Devin global roots", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    const report = installGlobal(assets, "1.0.0-test", { skills: null, agents: null, hosts: ["devin"] });
    assert.ok(report.populated);
    assert.ok(report.skillCount >= 2, `expected ≥2 skills, got ${report.skillCount}`);
    assert.ok(report.agentCount >= 1, `expected ≥1 agent, got ${report.agentCount}`);

    // Devin skill
    const devinSkill = join(devinSkillsRoot(), "sdd-explore");
    if (process.platform !== "win32")
    assert.ok(lstatSync(devinSkill).isSymbolicLink(), "devin skill is a symlink");
    // Devin agent
    const devinAgent = join(devinAgentsRoot(), "sdd-explore");
    if (process.platform !== "win32")
    assert.ok(lstatSync(devinAgent).isSymbolicLink(), "devin agent is a symlink");
  });
});

test("(gi-e) installGlobal is idempotent: second run leaves every symlink unchanged", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    installGlobal(assets, "1.0.0-test", { skills: null, agents: null, hosts: ["devin"] });
    const second = installGlobal(assets, "1.0.0-test", { skills: null, agents: null, hosts: ["devin"] });
    assert.equal(second.populated, false);
    const changed = second.hostLinks.filter((l) => l.result.action !== "unchanged");
    assert.equal(changed.length, 0, `expected all symlinks unchanged, got: ${JSON.stringify(changed)}`);
  });
});

// ---- maybeHealShare (serve auto-heal surface) ---------------------------

test("(heal-a) maybeHealShare populates an empty share and writes the version sentinel", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    // maybeHealShare has no selection parameter — it reads hosts from the persisted
    // share selection. Persist an explicit devin selection so healing links into devin.
    mkdirSync(shareRoot(), { recursive: true });
    writeFileSync(shareSelectionFile(), serializeSelection({ skills: null, agents: null, hosts: ["devin"] }));
    const report = maybeHealShare(assets, "9.9.9-heal");
    assert.equal(report.populated, true, "empty share is populated");
    assert.equal(readFileSync(shareVersionFile(), "utf8").trim(), "9.9.9-heal");
    assert.ok(report.hostLinks.length > 0, "host links created");
  });
});

test("(heal-b) maybeHealShare is a no-op when the share already matches the version", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    maybeHealShare(assets, "9.9.9-heal");
    const second = maybeHealShare(assets, "9.9.9-heal");
    assert.equal(second.populated, false, "matching version → no repopulate");
  });
});

test("(heal-c) maybeHealShare repopulates when the version drifts (upgrade simulation)", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    maybeHealShare(assets, "1.0.0-old");
    const upgraded = maybeHealShare(assets, "2.0.0-new");
    assert.equal(upgraded.populated, true, "version drift → repopulate");
    assert.equal(readFileSync(shareVersionFile(), "utf8").trim(), "2.0.0-new");
  });
});

// ---- inspectHostLinks (doctor's read-only symlink reader) ---------------

test("(inspect-a) inspectHostLinks reports ok for every link after installGlobal", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    installGlobal(assets, "1.0.0-test", { skills: null, agents: null, hosts: ["devin"] });
    const links = inspectHostLinks();
    assert.ok(links.length > 0, "some links inspected");
    assert.ok(links.every((l) => l.state === "ok"), `all ok, got ${JSON.stringify(links.map((l) => l.state))}`);
  });
});

test("(inspect-b) inspectHostLinks reports 'missing' when a host link is absent", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    installGlobal(assets, "1.0.0-test", { skills: null, agents: null, hosts: ["devin"] });
    // Remove one devin skill link, leaving the share entry in place.
    rmSync(join(devinSkillsRoot(), "sdd-explore"), { recursive: true, force: true });
    const link = inspectHostLinks().find((l) => l.kind === "skill" && l.name === "sdd-explore");
    assert.ok(link, "the skill is still inspected");
    assert.equal(link.state, "missing");
  });
});

test("(inspect-c) inspectHostLinks degrades gracefully when a share entry is removed", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    installGlobal(assets, "1.0.0-test", { skills: null, agents: null, hosts: ["devin"] });
    // Delete the share entry: it is enumerated FROM the share, so it simply drops out — and the
    // reader must never throw on the now-dangling host symlink left behind.
    rmSync(join(shareSkillsDir(), "sdd-explore"), { recursive: true, force: true });
    const link = inspectHostLinks().find((l) => l.kind === "skill" && l.name === "sdd-explore");
    assert.equal(link, undefined, "removed share entry no longer enumerated");
    assert.doesNotThrow(() => inspectHostLinks());
  });
});

// ---- isGlobalActivated() ------------------------------------------------

test("(activation-a) isGlobalActivated returns false when the share has not been populated", () => {
  withTmpHome(() => {
    assert.equal(isGlobalActivated(), false, "no .version sentinel → not activated");
  });
});

test("(activation-b) isGlobalActivated returns true after populateShare writes the sentinel", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    assert.equal(isGlobalActivated(), false, "before populate: false");
    populateShare(assets, "1.0.0-test");
    assert.equal(isGlobalActivated(), true, "after populate: true (sentinel written last)");
  });
});

test("(activation-c) leina-setup skill ships in share/skills after installGlobal", () => {
  withTmpHome((home) => {
    const assets = makeFakeAssetsRoot(home);
    installGlobal(assets, "1.0.0-test");
    const skillPath = join(shareSkillsDir(), "leina-setup", "SKILL.md");
    assert.ok(existsSync(skillPath), "leina-setup/SKILL.md present in share after installGlobal");
    const content = readFileSync(skillPath, "utf8");
    assert.match(content, /name: leina-setup/, "skill has correct name");
  });
});

// ---- install-global alias (E2E) -----------------------------------------

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function spawnCli(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", env },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("(alias-a) install-global deprecation notice goes to stderr; stdout has the activate report", () => {
  withTmpHome((home) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LEINA_HOME: join(home, ".leina"),
      HOME: home,
      USERPROFILE: home,
    };
    env.APPDATA = join(home, ".config");
    const { status, stdout, stderr } = spawnCli(["install-global", "--hosts", "devin"], env);
    assert.equal(status, 0, "exit code 0");
    assert.match(stderr, /install-global.*deprecated.*activate/, "deprecation on stderr");
    assert.doesNotMatch(stdout, /deprecated/, "deprecation NOT on stdout");
    assert.match(stdout, /leina activate — share at/, "stdout has activate report header");
  });
});

test("(alias-b) install-global and activate produce the same on-disk result (symlinks + share)", () => {
  // Run activate in one tmp home, install-global in another; both should end up with the same
  // share structure and Devin symlinks present.
  withTmpHome((home1) => {
    const env1: NodeJS.ProcessEnv = {
      ...process.env,
      LEINA_HOME: join(home1, ".leina"),
      HOME: home1,
      USERPROFILE: home1,
    };
    env1.APPDATA = join(home1, ".config");
    withTmpHome((home2) => {
      const env2: NodeJS.ProcessEnv = {
        ...process.env,
        LEINA_HOME: join(home2, ".leina"),
        HOME: home2,
        USERPROFILE: home2,
      };
      env2.APPDATA = join(home2, ".config");
      const r1 = spawnCli(["activate", "--no-user-hooks", "--hosts", "devin"], env1);
      const r2 = spawnCli(["install-global", "--no-user-hooks", "--hosts", "devin"], env2);
      assert.equal(r1.status, 0, "activate exits 0");
      assert.equal(r2.status, 0, "install-global exits 0");
      // Both share roots populated (version sentinel present)
      assert.ok(existsSync(join(home1, ".leina", "share", ".version")), "activate: .version present");
      assert.ok(existsSync(join(home2, ".leina", "share", ".version")), "install-global: .version present");
      // Both created Devin skill symlinks
      assert.ok(existsSync(join(home1, ".config", "devin", "skills")), "activate: devin skills dir exists");
      assert.ok(existsSync(join(home2, ".config", "devin", "skills")), "install-global: devin skills dir exists");
    });
  });
});

// ---- blanketFile + isBlanketActive (B1-1, B1-2) -------------------------

test("(blanket-B1-1) isBlanketActive returns false when sentinel absent", () => {
  withTmpHome(() => {
    assert.equal(isBlanketActive(), false);
  });
});

test("(blanket-B1-2) isBlanketActive returns true when sentinel exists", () => {
  withTmpHome((home) => {
    const sentinel = blanketFile();
    mkdirSync(join(home, ".leina"), { recursive: true });
    writeFileSync(sentinel, "");
    assert.equal(isBlanketActive(), true);
  });
});

test("(blanket-path) blanketFile resolves to $LEINA_HOME/.blanket", () => {
  withTmpHome((home) => {
    assert.equal(blanketFile(), join(home, ".leina", ".blanket"));
  });
});

// ---- unlinkHosts (T2-1 managed removed, T2-2 external preserved) ---------

test("(unlink-T2-1) unlinkHosts removes a managed symlink pointing into the share", () => {
  withTmpHome((home) => {
    const fakeAssets = makeFakeAssetsRoot(home);
    // Populate share + create host symlinks via installGlobal
    installGlobal(fakeAssets, "0.0.1-test", { skills: null, agents: null, hosts: ["devin"] });

    // Verify at least one skill symlink exists before unlink
    const skillsInShare = readdirSync(shareSkillsDir()).filter((e) => {
      try { return lstatSync(join(shareSkillsDir(), e)).isDirectory(); } catch { return false; }
    });
    assert.ok(skillsInShare.length > 0, "share has skill entries");
    const firstName = skillsInShare[0]!;
    const hostLink = join(devinSkillsRoot(), firstName);
    if (process.platform !== "win32")
    assert.ok(lstatSync(hostLink).isSymbolicLink(), "host symlink exists before unlinkHosts");

    const results = unlinkHosts();
    // At least one managed skill link was removed
    const removed = results.filter((r) => r.result.action === "unlinked");
    assert.ok(removed.length > 0, "at least one managed symlink was removed");
    // The first skill link should now be gone
    assert.ok(!existsSync(hostLink), "host symlink removed");
  });
});

test("(unlink-T2-2) unlinkHosts skips a symlink pointing outside the share", () => {
  withTmpHome((home) => {
    const fakeAssets = makeFakeAssetsRoot(home);
    // Populate share (does NOT create host links — we do it manually)
    populateShare(fakeAssets, "0.0.1-test");

    // Create a skill subdir in the share
    const skillNames = readdirSync(shareSkillsDir()).filter((e) => {
      try { return lstatSync(join(shareSkillsDir(), e)).isDirectory(); } catch { return false; }
    });
    assert.ok(skillNames.length > 0, "share has skill entries");
    const name = skillNames[0]!;

    // Create an EXTERNAL target (outside the share) and symlink the host entry to it
    const externalTarget = join(home, "external-skill");
    mkdirSync(externalTarget, { recursive: true });
    const hostLink = join(devinSkillsRoot(), name);
    mkdirSync(devinSkillsRoot(), { recursive: true });
    symlinkSync(externalTarget, hostLink, "dir");

    const results = unlinkHosts();
    // The external symlink must remain untouched
    assert.ok(existsSync(hostLink), "external symlink preserved");
    const entry = results.find((r) => r.name === name);
    assert.ok(entry, "entry present in result");
    assert.equal(entry.result.action, "skipped-unmanaged", "external symlink skipped");
  });
});
