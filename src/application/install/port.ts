// port.ts — Pure-writer module for installing bundled Leina assets.
//
// All exports are PURE FUNCTIONS (no destination file I/O). The CLI layer does
// all writes. Writers are deterministic and idempotent: re-running on an
// already-processed source returns identical output.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { FileArtifact } from "../../domain/install/artifact.ts";
import { parseFrontmatter, shortDescription } from "./frontmatter.ts";

/**
 * Rewrite host-neutral skill references to the install destination while
 * preserving native Leina content. Bundled assets reference sibling skills
 * with the host-neutral `skills/<name>/SKILL.md` and `skills/_shared/<file>.md`
 * forms; installation resolves them to the concrete skills directory (e.g.
 * `.claude/skills/...`) so an agent in `.claude/agents/` can read them by path.
 * Prose mentions of "skills/" are left untouched — only `*.md` reference forms
 * are rewritten, and an already-rewritten path is never rewritten again.
 * Normal installation never performs format migration.
 */
export function rewriteAssetPaths(content: string, destSkillsDir: string): string {
  const destBase = destSkillsDir.endsWith("/") ? destSkillsDir.slice(0, -1) : destSkillsDir;
  return content.replaceAll(
    /(?<![\w./-])skills\/((?:_shared\/[\w.-]+\.md)|(?:[\w-]+\/SKILL\.md))/g,
    `${destBase}/$1`,
  );
}

/**
 * Walk srcDir recursively and return one FileArtifact per file, rooted under
 * destDir. The shared convention is installed by portConvention so there is a
 * single canonical writer for that file.
 */
export function portSkills(
  srcDir: string,
  destDir: string,
  filter?: string[],
): FileArtifact[] {
  if (filter?.length === 1 && filter?.[0] === "none") {
    return [];
  }

  const artifacts: FileArtifact[] = [];
  walkDir(srcDir, srcDir, destDir, filter, artifacts);
  return artifacts;
}

function walkDir(
  rootSrc: string,
  currentDir: string,
  destDir: string,
  topLevelFilter: string[] | undefined,
  out: FileArtifact[],
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);

    if (topLevelFilter && currentDir === rootSrc && !topLevelFilter.includes(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      walkDir(rootSrc, fullPath, destDir, topLevelFilter, out);
      continue;
    }
    if (!entry.isFile()) continue;

    const relPath = relative(rootSrc, fullPath).split(sep).join("/");
    if (relPath === "_shared/leina-memory-convention.md") {
      continue;
    }

    const content = readFileSync(fullPath, "utf-8");
    const destBase = destDir.endsWith("/") ? destDir.slice(0, -1) : destDir;
    out.push({
      path: `${destBase}/${relPath}`,
      content: rewriteAssetPaths(content, destDir),
    });
  }
}

/**
 * Read all *.md files from srcDir and produce one FileArtifact per file per
 * destination in dests[]. Agent definitions are already native Leina assets.
 */
export function portAgents(
  srcDir: string,
  dests: string[],
  filter?: string[],
): FileArtifact[] {
  if (filter?.length === 1 && filter?.[0] === "none") {
    return [];
  }

  const marker = "<!-- leina:ported -->";
  const artifacts: FileArtifact[] = [];

  for (const dirent of readdirSync(srcDir, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
    const entry = dirent.name;

    const baseName = entry.slice(0, -3);
    if (filter && !filter.includes(baseName) && !filter.includes(entry)) continue;

    const fullPath = join(srcDir, entry);

    // Agents land in .claude/agents/; skills land in .claude/skills/. Rewrite the host-neutral
    // skills/<name>/SKILL.md references to the project-relative .claude/skills so they resolve in-repo.
    const body = rewriteAssetPaths(readFileSync(fullPath, "utf-8"), ".claude/skills");
    const content = `${marker}\n${body}`;

    for (const dest of dests) {
      const destBase = dest.endsWith("/") ? dest.slice(0, -1) : dest;
      artifacts.push({ path: `${destBase}/${entry}`, content });
    }
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// Workflows port — universal markdown workflow format consumed by the share's workflows/ dir.
// ---------------------------------------------------------------------------

/**
 * Rewrite skill-style internal references to workflow-style references.
 * `skills/<name>/SKILL.md` → `workflows/<name>.md`
 * `skills/_shared/<file>` → `workflows/_shared/<file>`
 */
function rewriteToWorkflowPaths(content: string, destBase: string): string {
  return content
    // skills/<name>/SKILL.md → workflows/<name>.md
    .replaceAll(/(?<![\w./-])skills\/([\w-]+)\/SKILL\.md/g, `${destBase}/$1.md`)
    // skills/_shared/<file>.md → workflows/_shared/<file>.md
    .replaceAll(/(?<![\w./-])skills\/_shared\/([\w.-]+\.md)/g, `${destBase}/_shared/$1`);
}

/**
 * Convert a SKILL.md to the generic workflow markdown format.
 * Strips host-specific frontmatter, replaces with `description:`, and rewrites paths.
 */
function skillToWorkflow(skillContent: string, destBase: string): string {
  const { meta, body } = parseFrontmatter(skillContent);
  const desc = meta.description || meta.name || "Leina workflow";
  // Strip Claude-specific directives from body (the ORCHESTRATOR GATE block)
  const cleanBody = body.replace(
    /> \*\*ORCHESTRATOR GATE\*\*:[\s\S]*?(?=\n## |\n---|\n$)/,
    "",
  );
  const rewritten = rewriteToWorkflowPaths(cleanBody.trim(), destBase);
  return `---\ndescription: ${desc}\n---\n\n${rewritten}\n`;
}

/**
 * Convert a Claude Code agent .md to workflow format (workflow files live in the global share).
 * Strips Claude-specific frontmatter, replaces with `description:`, and rewrites paths.
 */
function agentToWorkflow(agentContent: string, destBase: string): string {
  const { meta, body } = parseFrontmatter(agentContent);
  const shortDesc = shortDescription(meta.description ?? "", meta.name || "Leina workflow");
  const rewritten = rewriteToWorkflowPaths(body.trim(), destBase);
  return `---\ndescription: ${shortDesc}\n---\n\n${rewritten}\n`;
}

/**
 * Port skills and agents into workflow .md files under a destination prefix (e.g. the global
 * share's `workflows/` directory).
 *
 * - Each skill `<name>/SKILL.md` becomes `workflows/<name>.md` with workflow frontmatter.
 * - Extra files inside a skill dir (references, etc.) become `workflows/<name>/<file>`.
 * - Standalone agents (no matching skill) become `workflows/<name>.md`.
 * - `_shared/` files are copied to `workflows/_shared/`.
 *
 * Pure function — no I/O, returns FileArtifact[].
 */
export function portWorkflows(
  skillsSrcDir: string,
  agentsSrcDir: string,
  destDir: string,
  filter?: string[],
): FileArtifact[] {
  if (filter?.length === 1 && filter?.[0] === "none") return [];

  const destBase = destDir.endsWith("/") ? destDir.slice(0, -1) : destDir;
  const artifacts: FileArtifact[] = [];
  const ported = new Set<string>(); // track agent names ported via skill pairing

  // 1. Port skills
  for (const entry of safeReaddir(skillsSrcDir)) {
    portSkillToWorkflow(entry, skillsSrcDir, agentsSrcDir, destBase, filter, artifacts, ported);
  }

  // 2. Port standalone agents (no matching skill)
  for (const entry of safeReaddir(agentsSrcDir)) {
    portStandaloneAgentToWorkflow(entry, agentsSrcDir, destBase, filter, artifacts, ported);
  }

  // 3. Port _shared files
  portSharedToWorkflows(skillsSrcDir, destBase, artifacts);

  return artifacts;
}

/** True if a matching agent .md exists for a skill (records the pairing). */
function agentFileExists(agentFile: string): boolean {
  try {
    readFileSync(agentFile, "utf-8");
    return true;
  } catch {
    // No matching agent — skill-only workflow
    return false;
  }
}

/** Port a single skill dir entry into its workflow .md (+ extra files), tracking the pairing. */
function portSkillToWorkflow(
  entry: string,
  skillsSrcDir: string,
  agentsSrcDir: string,
  destBase: string,
  filter: string[] | undefined,
  artifacts: FileArtifact[],
  ported: Set<string>,
): void {
  if (entry === "_shared") return; // handled separately
  if (filter && !filter.includes(entry)) return;
  const skillDir = join(skillsSrcDir, entry);
  if (!statSync(skillDir).isDirectory()) return;

  const skillFile = join(skillDir, "SKILL.md");
  let skillContent: string;
  try {
    skillContent = readFileSync(skillFile, "utf-8");
  } catch {
    return;
  }

  // Check for matching agent
  if (agentFileExists(join(agentsSrcDir, `${entry}.md`))) ported.add(entry);

  // Main workflow file
  const workflowContent = skillToWorkflow(skillContent, destBase);
  artifacts.push({ path: `${destBase}/${entry}.md`, content: workflowContent });

  // Extra files in the skill directory (references, etc.)
  portSkillExtras(skillDir, entry, destBase, artifacts);
}

/** Port the non-SKILL.md files inside a skill dir, recursing one level for subdirs. */
function portSkillExtras(
  skillDir: string,
  entry: string,
  destBase: string,
  artifacts: FileArtifact[],
): void {
  for (const dirent of readdirSync(skillDir, { withFileTypes: true })) {
    if (dirent.name === "SKILL.md") continue;
    const extra = dirent.name;
    const extraPath = join(skillDir, extra);
    if (dirent.isFile()) {
      const content = rewriteToWorkflowPaths(readFileSync(extraPath, "utf-8"), destBase);
      artifacts.push({ path: `${destBase}/${entry}/${extra}`, content });
      continue;
    }
    // Recurse one level for references/ subdirs
    if (dirent.isDirectory()) {
      portSkillExtraSubdir(extraPath, entry, extra, destBase, artifacts);
    }
  }
}

/** Port files one level deep inside a skill's subdirectory (e.g. references/). */
function portSkillExtraSubdir(
  extraPath: string,
  entry: string,
  extra: string,
  destBase: string,
  artifacts: FileArtifact[],
): void {
  for (const dirent of readdirSync(extraPath, { withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    const sub = dirent.name;
    const subPath = join(extraPath, sub);
    const content = rewriteToWorkflowPaths(readFileSync(subPath, "utf-8"), destBase);
    artifacts.push({ path: `${destBase}/${entry}/${extra}/${sub}`, content });
  }
}

/** Port a standalone agent .md (no matching skill) into a workflow .md. */
function portStandaloneAgentToWorkflow(
  entry: string,
  agentsSrcDir: string,
  destBase: string,
  filter: string[] | undefined,
  artifacts: FileArtifact[],
  ported: Set<string>,
): void {
  if (!entry.endsWith(".md")) return;
  const baseName = entry.slice(0, -3);
  if (ported.has(baseName)) return; // already merged via skill
  if (filter && !filter.includes(baseName)) return;

  const fullPath = join(agentsSrcDir, entry);
  let content: string;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    return; // not a readable file (missing or a directory) — skip
  }
  artifacts.push({
    path: `${destBase}/${baseName}.md`,
    content: agentToWorkflow(content, destBase),
  });
}

/** Port `_shared/` files into `workflows/_shared/`. */
function portSharedToWorkflows(
  skillsSrcDir: string,
  destBase: string,
  artifacts: FileArtifact[],
): void {
  const sharedDir = join(skillsSrcDir, "_shared");
  for (const entry of safeReaddir(sharedDir)) {
    const fullPath = join(sharedDir, entry);
    // EAFP: read directly; a directory or vanished entry throws and is skipped.
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }
    content = rewriteToWorkflowPaths(content, destBase);
    artifacts.push({ path: `${destBase}/_shared/${entry}`, content });
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Install the native Leina memory convention. The convention file documents
 * the `leina memory` CLI itself (CLI-only — there is no MCP tool surface
 * to advertise), so it is copied through with only asset-path rewriting.
 */
export function portConvention(srcDir: string, destDir: string): FileArtifact {
  const srcFile = join(srcDir, "_shared", "leina-memory-convention.md");
  let body: string;
  try {
    body = rewriteAssetPaths(readFileSync(srcFile, "utf-8"), destDir);
  } catch {
    body = "# Leina Memory Artifact Convention\n";
  }

  const destBase = destDir.endsWith("/") ? destDir.slice(0, -1) : destDir;
  return {
    path: `${destBase}/_shared/leina-memory-convention.md`,
    content: body,
  };
}
