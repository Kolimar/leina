// devin-skills.ts — Generate Devin AGENT.md custom-subagent profiles + thin SKILL.md delegators.
//
// Each entry in `assets/agents/<name>.md` (the existing "executor" prompts) becomes TWO artifacts
// in the global share:
//
//   share/agents/<name>/AGENT.md   — the subagent profile (the executor body, with a normalised
//                                    frontmatter that Devin understands).
//   share/skills/<name>/SKILL.md   — a thin delegator skill with `agent: <name>` in frontmatter.
//                                    Invoking `/<name>` spawns a foreground subagent using the
//                                    matching AGENT profile; the parent waits and reports back.
//
// The orchestrator skill (assets/skills/leina-sdd/SKILL.md, hand-authored) reuses this pattern
// by invoking `/sdd-explore`, `/sdd-propose`, etc. in sequence — each phase runs as an isolated
// subagent, the orchestrator stays in the main context.
//
// References (Devin docs, validated 2026-06-01):
//   - extensibility/skills/creating-skills.mdx §"agent: <profile>"  (lines 138-156)
//   - subagents.mdx §"Custom Subagents"                              (lines 134-200)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileArtifact } from "../../domain/install/artifact.ts";
import { parseFrontmatter, shortDescription } from "./frontmatter.ts";

// Compact, imperative restatement of the shared Section 0 (language + context bootstrap),
// hoisted to the very top of every phase AGENT.md. The full Section 0 is inlined deeper in the
// methodology, but a stateless subagent anchors on what it reads FIRST — and the phase's own
// quick-steps often mark memory retrieval "(optional)". This preamble overrides that. The two
// rules below are exactly the failure modes seen in testing: replying in the wrong language, and
// guessing a change's meaning from the repo layout instead of reading project memory.
export const EXECUTOR_PREAMBLE = [
  "> **EXECUTOR PREAMBLE — do this FIRST; it overrides any \"(optional)\" step below.**",
  ">",
  "> 1. **Language.** Detect the user's language (from the brief / conversation / existing",
  ">    artifacts) and write ALL prose AND the artifact CONTENT in it. Keep `topic_key`s, slugs",
  ">    (`sdd/{change}/…`), identifiers, file paths and CLI commands in English — never translate them.",
  ">",
  "> 2. **Context is in MEMORY, not the filesystem.** Before forming ANY hypothesis about what the",
  ">    change is, run `leina memory search <dir> \"<change-name>\"` (then `memory context`",
  ">    if thin). If it returns an `sdd/<change>/*` (explore/proposal/…) or `backlog/<change>`",
  ">    entry, `leina memory get <dir> <id>` it and treat that as the AUTHORITATIVE brief —",
  ">    do NOT override it with a guess from repo folders (e.g. \"there's a `docs/` dir, so this",
  ">    must be about a docs README\" is a FAILURE). If memory returns NOTHING, say so explicitly,",
  ">    state your one-line interpretation, and confirm it with the user (in their language) BEFORE",
  ">    writing the artifact.",
].join("\n");

/**
 * Match the dangling self-reference an executor body carries: `Read the skill file at
 * `skills/<name>/SKILL.md` and follow it exactly.`. In the share that path holds the THIN
 * DELEGATOR (see buildDevinSkillArtifact), NOT the executor methodology — so following that
 * instruction sends the subagent into a "delegate again" loop. We inline the real methodology
 * and strip this line. See sdd/skill-delegation-fix.
 */
function skillSelfRef(name: string): RegExp {
  const esc = name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  // eslint-disable-next-line security/detect-non-literal-regexp -- `esc` is the only interpolated value and is regex-escaped above, so no injection/ReDoS.
  return new RegExp(`^Read the skill file at \`skills/${esc}/SKILL\\.md\` and follow it exactly\\.[ \\t]*$`, "m");
}

/**
 * Convert an assets/agents/<name>.md file into a Devin AGENT.md artifact.
 *
 * Rewrites the frontmatter to Devin's `name`/`description`/`model` shape (drops legacy
 * `tools` / `color`). When the agent has a matching methodology skill (`skillMd`, from
 * assets/skills/<name>/SKILL.md), the AGENT.md is made SELF-CONTAINED: the methodology body
 * is inlined in place of the dangling `Read the skill file at skills/<name>/SKILL.md` line.
 * This is required because that share path is overwritten by the thin delegator at install
 * time, so the subagent could no longer read its real instructions from there.
 */
/**
 * Make an executor body self-contained: replace the dangling `Read the skill file at
 * skills/<name>/SKILL.md` self-reference with the real methodology, append the shared
 * phase protocol when the methodology references it, and hoist the executor preamble.
 * Shared by every host's agent transform — the frontmatter differs per host, the body
 * treatment must not.
 */
function inlineMethodologyBody(
  name: string,
  body: string,
  skillMd?: string,
  sharedCommon?: string,
): string {
  let finalBody = body.trimStart();
  if (!skillMd) return finalBody;

  let methodology = parseFrontmatter(skillMd).body.trim();
  // Inline the shared phase protocol too. The methodology references it by relative path
  // (`skills/_shared/sdd-phase-common.md`), but at runtime the subagent cannot resolve that
  // path — so the referenced Section 0 (language + context bootstrap) / A–E never reach it.
  // Appending the content makes the agent file fully self-contained. See sdd/skill-shared-inline.
  let inlinesShared = false;
  if (sharedCommon && methodology.includes("sdd-phase-common")) {
    const shared = parseFrontmatter(sharedCommon).body.trim() || sharedCommon.trim();
    methodology = `${methodology}\n\n---\n\n## Shared phase protocol (inlined from \`skills/_shared/sdd-phase-common.md\`)\n\nThe Section 0 / A–E references above resolve to the content below — follow it directly; do not try to open the file path.\n\n${shared}`;
    inlinesShared = true;
  }
  const inlined = `Follow this phase's methodology exactly (inlined from its skill source):\n\n${methodology}`;
  const ref = skillSelfRef(name);
  finalBody = ref.test(finalBody)
    ? finalBody.replace(ref, inlined)
    : `${finalBody.replace(/\s+$/, "")}\n\n## Phase Methodology\n\n${methodology}`;
  // The full Section 0 lives deep in the inlined methodology — too buried to reliably override
  // the phase's own "(optional)" retrieval step. Hoist a compact, imperative copy to the very
  // TOP of the body so it is the first thing the subagent reads. See sdd/skill-shared-inline.
  if (inlinesShared) finalBody = `${EXECUTOR_PREAMBLE}\n\n${finalBody}`;
  return finalBody;
}

export function buildDevinAgentArtifact(
  name: string,
  sourceMd: string,
  skillMd?: string,
  sharedCommon?: string,
): FileArtifact {
  const { meta, body } = parseFrontmatter(sourceMd);
  const description = shortDescription(meta.description ?? "", `Leina SDD ${name} subagent`);
  const model = meta.model && /^[a-z][\w-]*$/.test(meta.model) ? meta.model : "sonnet";
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `model: ${model}`,
    "---",
    "",
  ].join("\n");

  return {
    path: `agents/${name}/AGENT.md`,
    content: `${frontmatter}${inlineMethodologyBody(name, body, skillMd, sharedCommon)}\n`,
  };
}

/**
 * Convert an assets/agents/<name>.md into the flat Claude Code agent artifact.
 * The bundled frontmatter IS Claude's native format, so it is kept verbatim; only the
 * body is made self-contained (same inlining as Devin). Without this, the global install
 * ships agents whose `Read the skill file at skills/<name>/SKILL.md` line points at a
 * path that resolves nowhere from a project cwd — and the share copy of that path holds
 * the thin delegator anyway (see populateShare's clobber note).
 */
export function buildClaudeAgentArtifact(
  name: string,
  sourceMd: string,
  skillMd?: string,
  sharedCommon?: string,
): FileArtifact {
  const m = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/.exec(sourceMd);
  const frontmatterBlock = m?.[1] ?? "";
  const body = m?.[2] ?? sourceMd;
  return {
    path: `claude-agents/${name}.md`,
    content: `${frontmatterBlock}${inlineMethodologyBody(name, body, skillMd, sharedCommon)}\n`,
  };
}

/**
 * Build the thin SKILL.md delegator that invokes the matching AGENT subagent profile.
 * Invoking `/<name>` runs this skill inline; the `agent:` frontmatter then spawns a subagent.
 */
export function buildDevinSkillArtifact(name: string, sourceMd: string): FileArtifact {
  const { meta } = parseFrontmatter(sourceMd);
  const description = shortDescription(meta.description ?? "", `Run the ${name} SDD phase as a subagent`);
  const content = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `agent: ${name}`,
    "triggers:",
    "  - user",
    "  - model",
    "---",
    "",
    `Delegate the **${name}** SDD phase to the matching custom subagent profile.`,
    "",
    "The parent agent waits for the subagent to complete, then summarises its result. Pass any",
    "additional context (change-name, exploration notes, scope hints, etc.) as `$ARGUMENTS`.",
    "",
    "$ARGUMENTS",
    "",
  ].join("\n");
  return { path: `skills/${name}/SKILL.md`, content };
}

/**
 * Walk `agentsSrcDir` (= assets/agents/) and emit every per-agent share artifact for each
 * `<name>.md` file: the Devin AGENT.md, the delegating SKILL.md, and the flat Claude
 * agent .md. Pure function: no I/O performed on dest.
 *
 * When `skillsSrcDir` (= assets/skills/) is provided and an agent has a matching
 * `<name>/SKILL.md`, that skill's methodology is inlined into the agent bodies so the
 * subagent is self-contained (see inlineMethodologyBody). Agents without a matching skill
 * (the standalone reviewers) are emitted verbatim.
 *
 * Returned paths are share-relative (skills/<name>/SKILL.md, agents/<name>/AGENT.md,
 * claude-agents/<name>.md). The caller anchors them under shareRoot() before writing.
 */
export function buildDevinArtifactsFromAgents(agentsSrcDir: string, skillsSrcDir?: string): FileArtifact[] {
  const out: FileArtifact[] = [];
  // Read the shared phase protocol once so each phase AGENT.md can inline it (the methodology
  // only references it by an unresolvable relative path otherwise). See buildDevinAgentArtifact.
  let sharedCommon: string | undefined;
  if (skillsSrcDir) {
    try {
      sharedCommon = readFileSync(join(skillsSrcDir, "_shared", "sdd-phase-common.md"), "utf8");
    } catch {
      // No shared protocol bundled — agents fall back to the (path-only) reference.
    }
  }
  for (const dirent of readdirSync(agentsSrcDir, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
    const entry = dirent.name;
    const full = join(agentsSrcDir, entry);
    const name = entry.slice(0, -3);
    const source = readFileSync(full, "utf8");
    let skillMd: string | undefined;
    if (skillsSrcDir) {
      const skillPath = join(skillsSrcDir, name, "SKILL.md");
      try {
        skillMd = readFileSync(skillPath, "utf8");
      } catch {
        // No matching methodology skill — standalone agent; emit body verbatim.
      }
    }
    out.push(
      buildDevinAgentArtifact(name, source, skillMd, sharedCommon),
      buildDevinSkillArtifact(name, source),
      buildClaudeAgentArtifact(name, source, skillMd, sharedCommon),
    );
  }
  return out;
}
