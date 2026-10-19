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
import { basename, dirname, join, resolve } from "node:path";

const CONSENT_REL = join(".leina", "consent");
const GRAPH_DB_REL = join(".leina", "graph.db");

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

/**
 * The directory whose `.leina/graph.db` serves graph reads for `start`: the
 * nearest ancestor (inclusive) with a graph, never crossing the enclosing git
 * toplevel (a nested worktree has its own code, so the outer repo's graph would
 * be wrong for it). Without a graph, the git toplevel; outside git, `start`
 * itself unless an ancestor holds one (a multi-repo workspace root).
 */
export function resolveGraphRoot(start: string): string {
  const abs = resolve(start);
  const top = findGitToplevel(abs);
  for (const dir of ancestors(abs)) {
    if (!isLeinaHomeParent(dir) && existsSync(join(dir, GRAPH_DB_REL))) return dir;
    if (dir === top) break;
  }
  return top ?? abs;
}
