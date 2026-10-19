// application/project/root.ts — which project does a path belong to?
//
// Agents and hosts hand leina whatever directory they happen to be in: a repo
// root, a subdirectory of it, a linked git worktree, or a Claude Code worktree
// nested under `.claude/worktrees/`. Everything keyed per project (consent,
// trust, session markers, graph.db) lives at the PROJECT root, so lookups that
// only check the exact directory go silent everywhere else. These resolvers
// walk up instead. Pure filesystem reads (no git spawn): they run on the hook
// hot path, once per tool call.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const CONSENT_REL = join(".leina", "consent");
const GRAPH_DB_REL = join(".leina", "graph.db");
const PROJECT_MARKERS_REL = [GRAPH_DB_REL, CONSENT_REL, join(".leina", "config.json")];

/** `start` and each of its ancestors, nearest first. */
function ancestors(start: string): string[] {
  const out: string[] = [];
  let dir = resolve(start);
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The global leina home (`$LEINA_HOME`, default `~/.leina`) is also named
 * `.leina`; with the default layout `~` would look like a project. Never treat
 * the directory holding it as one.
 */
function isLeinaHomeParent(dir: string): boolean {
  const home = process.env.LEINA_HOME ?? resolve(homedir(), ".leina");
  return realOrSelf(join(dir, ".leina")) === realOrSelf(home);
}

/** Nearest ancestor (inclusive) carrying a `.git` entry — a dir, or a worktree/submodule file. */
export function findGitToplevel(start: string): string | undefined {
  for (const dir of ancestors(start)) {
    if (existsSync(join(dir, ".git"))) return dir;
  }
  return undefined;
}

/**
 * For a LINKED worktree toplevel (`.git` is a file pointing into
 * `<main>/.git/worktrees/<name>`), the main worktree's root. Undefined for a
 * main worktree, a submodule (its gitdir has no `commondir`), a bare common
 * dir, or anything unreadable.
 */
export function linkedWorktreeMainRoot(toplevel: string): string | undefined {
  try {
    const dotGit = join(toplevel, ".git");
    if (!statSync(dotGit).isFile()) return undefined;
    const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
    if (target === undefined) return undefined;
    const gitdir = resolve(toplevel, target.trim());
    const commondirFile = join(gitdir, "commondir");
    if (!existsSync(commondirFile)) return undefined;
    const common = resolve(gitdir, readFileSync(commondirFile, "utf8").trim());
    return basename(common) === ".git" ? dirname(common) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The leina project `start` belongs to: the nearest ancestor (inclusive) with a
 * `.leina/consent` flag in ANY state — a nearer `disabled` flag is an opt-out
 * and must not be skipped in favour of an enabled parent. Covers subdirectories
 * and worktrees nested inside the repo (`.claude/worktrees/<name>`). A linked
 * worktree outside the repo falls back to its main worktree's flag (`.leina/`
 * is gitignored, so a worktree checkout never carries its own).
 */
export function findConsentRoot(start: string): string | undefined {
  for (const dir of ancestors(start)) {
    if (isLeinaHomeParent(dir)) continue;
    if (existsSync(join(dir, CONSENT_REL))) return dir;
  }
  const top = findGitToplevel(start);
  const main = top === undefined ? undefined : linkedWorktreeMainRoot(top);
  if (main !== undefined && existsSync(join(main, CONSENT_REL))) return main;
  return undefined;
}

/** A directory leina already treats as a project: it holds a graph, a consent flag or a name lock. */
function isLeinaProjectDir(dir: string): boolean {
  if (isLeinaHomeParent(dir)) return false;
  return PROJECT_MARKERS_REL.some((rel) => existsSync(join(dir, rel)));
}

/**
 * The project root every per-project CLI command (graph reads and builds, memory) acts on
 * for `start`: the nearest ancestor (inclusive) that is already a leina project — it
 * holds `.leina/graph.db`, `.leina/consent` or a `.leina/config.json` name lock — never
 * crossing the enclosing git toplevel (a nested worktree or repo has its own code, so the
 * outer project's graph would be wrong for it). Without one, the git toplevel; outside
 * git, `start` itself unless an ancestor is a project (a multi-repo workspace root). So a
 * command run from `src/` reads the repo's graph instead of building a second one, and a
 * monorepo package that was `init`ed on its own stays its own project.
 */
export function resolveGraphRoot(start: string): string {
  const abs = resolve(start);
  const top = findGitToplevel(abs);
  for (const dir of ancestors(abs)) {
    if (isLeinaProjectDir(dir)) return dir;
    if (dir === top) break;
  }
  return top ?? abs;
}

/**
 * The directory a hook was fired for. Claude Code documents `CLAUDE_PROJECT_DIR`, Devin
 * documents `DEVIN_PROJECT_DIR` — same contract, different name; no hook stdin payload
 * carries a cwd. First non-blank wins, else the process cwd (`fallbackCwd`). The result
 * may be a subdirectory or a worktree: callers walk up from it (findConsentRoot,
 * findHarnessRoot). Pure function of its inputs — no `process.*` access.
 */
export function resolveHookProjectRoot(env: NodeJS.ProcessEnv, fallbackCwd: string): string {
  const claudeEnv = typeof env.CLAUDE_PROJECT_DIR === "string" ? env.CLAUDE_PROJECT_DIR.trim() : "";
  if (claudeEnv.length > 0) return claudeEnv;
  const fromEnv = typeof env.DEVIN_PROJECT_DIR === "string" ? env.DEVIN_PROJECT_DIR.trim() : "";
  return fromEnv.length > 0 ? fromEnv : fallbackCwd;
}

/**
 * The harness repo root for `start`: the nearest ancestor (inclusive) holding a
 * `.harness/` dir or a `.git` entry, falling back to `start` itself (a bare
 * directory can still hold rules/config). A worktree checkout carries its own
 * `.harness/` rules, so it is its own harness root.
 */
export function findHarnessRoot(start: string): string {
  for (const dir of ancestors(start)) {
    if (existsSync(join(dir, ".harness")) || existsSync(join(dir, ".git"))) return dir;
  }
  return resolve(start);
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * The directory whose workspace trust governs `dir` (typically a harness root):
 * its consent root when that root belongs to the SAME repository — `dir` itself,
 * an ancestor up to `dir`'s git toplevel, or the main worktree of the linked
 * worktree `dir` lives in (nested under `.claude/worktrees/` or anywhere else).
 * A nested independent clone or a submodule never inherits its parent's trust:
 * for those, and without any consent root, the answer is `dir` itself.
 */
export function resolveTrustRoot(dir: string): string {
  const abs = resolve(dir);
  const consent = findConsentRoot(abs);
  if (consent === undefined) return abs;
  const top = findGitToplevel(abs);
  if (top === undefined) return consent;
  const real = realOrSelf(consent);
  if (isWithin(real, realOrSelf(top))) return consent;
  const main = linkedWorktreeMainRoot(top);
  return main !== undefined && realOrSelf(main) === real ? consent : abs;
}
