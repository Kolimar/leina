// vendor-assets — MAINTAINER tool: copy a curated subset of skills + agents from a Claude
// Code config directory INTO this package's assets/ so `leina activate` ships them and
// works fully offline (no ~/.claude on the target machine).
//
// Assets committed here MUST already use Leina-native tools and contracts.
// Installation copies them without translating external formats.
//
// Usage:
//   node --no-warnings --experimental-strip-types scripts/vendor-assets.ts
//   node --no-warnings --experimental-strip-types scripts/vendor-assets.ts --skills-src <dir> --agents-src <dir>
//
// Defaults: ~/.claude/skills and ~/.claude/agents. Idempotent: clears assets/ first.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenReferences, loadForbiddenNeedles } from "../src/infrastructure/install/native-assets.ts";

const vendorNeedles = loadForbiddenNeedles();

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

const skillsSrc = arg("--skills-src", join(home, ".claude", "skills"));
const agentsSrc = arg("--agents-src", join(home, ".claude", "agents"));

// Curated for a backend TypeScript tool. Edit this list to add/drop assets,
// then re-run. Deliberately EXCLUDES frontend/web/jira/python skills as noise for this project.
const CURATED_SKILLS = [
  // SDD workflow (the "HOW" — drives spec-driven changes)
  "sdd-init", "sdd-explore", "sdd-propose", "sdd-spec", "sdd-design",
  "sdd-tasks", "sdd-apply", "sdd-verify", "sdd-archive", "sdd-onboard",
  // Shared SDD/skill infrastructure (persistence-contract, conventions)
  "_shared",
  // Language + delivery discipline
  "typescript", "work-unit-commits", "branch-pr", "github-pr", "chained-pr",
  "cognitive-doc-design", "comment-writer", "judgment-day", "skill-creator",
];

const skillsDest = join(repoRoot, "assets", "skills");
const agentsDest = join(repoRoot, "assets", "agents");

// Walk directories via Dirent entries (withFileTypes) so the file/dir decision comes from the
// parent listing — never a separate statSync(path) followed by readFileSync(path) on the same
// name (that check→use split is a TOCTOU race, CodeQL js/file-system-race).
function assertNativeAssets(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      assertNativeAssets(full);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const hits = findForbiddenReferences(readFileSync(full, "utf8"), vendorNeedles);
    if (hits.length > 0) {
      throw new Error(`Refusing to vendor non-native Leina asset: ${full}:${hits[0]!.line}`);
    }
  }
}

// Guard BEFORE deleting: if the source isn't there (e.g. run in CI with an empty $HOME),
// abort instead of wiping the committed assets/ down to nothing. The committed assets/ is the
// canonical source of truth — re-running this is a maintainer curation step, not part of CI.
const presentSkills = CURATED_SKILLS.filter((n) => existsSync(join(skillsSrc, n)));
if (presentSkills.length === 0) {
  console.error(`No curated skills found under ${skillsSrc} — refusing to wipe assets/. ` +
    `Pass --skills-src <dir> pointing at a Claude Code skills directory.`);
  process.exit(1);
}

for (const name of presentSkills) assertNativeAssets(join(skillsSrc, name));
if (existsSync(agentsSrc)) assertNativeAssets(agentsSrc);

rmSync(skillsDest, { recursive: true, force: true });
rmSync(agentsDest, { recursive: true, force: true });
mkdirSync(skillsDest, { recursive: true });
mkdirSync(agentsDest, { recursive: true });

let skillCount = 0;
for (const name of CURATED_SKILLS) {
  const from = join(skillsSrc, name);
  if (!existsSync(from)) {
    console.warn(`  skip (missing): ${from}`);
    continue;
  }
  cpSync(from, join(skillsDest, name), { recursive: true });
  skillCount++;
}

let agentCount = 0;
if (existsSync(agentsSrc)) {
  for (const entry of readdirSync(agentsSrc)) {
    if (!entry.endsWith(".md")) continue;
    cpSync(join(agentsSrc, entry), join(agentsDest, entry));
    agentCount++;
  }
} else {
  console.warn(`  skip agents (missing): ${agentsSrc}`);
}

console.log(`Vendored ${skillCount} skill dirs -> ${skillsDest}`);
console.log(`Vendored ${agentCount} agent files -> ${agentsDest}`);
