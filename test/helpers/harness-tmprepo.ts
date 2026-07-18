// test/helpers/harness-tmprepo.ts — throwaway git repos for the harness test
// suites (gates, contract, verify). mkdtemp under the OS tmpdir; git identity
// is pinned so commits work on any machine/CI. Mirrors the origin
// harness-framework's test/helpers/tmprepo.ts, minus execa.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface TmpRepo {
  root: string;
  git(...args: string[]): void;
  write(rel: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function makeTmpRepo(withGit = true): Promise<TmpRepo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "leina-harness-test-"));
  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  };
  const repo: TmpRepo = {
    root,
    git,
    write: async (rel, content) => {
      const file = path.join(root, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, "utf8");
    },
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
  if (withGit) {
    git("init", "-b", "main");
    git("config", "user.email", "test@harness.dev");
    git("config", "user.name", "Harness Test");
    git("config", "commit.gpgsign", "false");
  }
  return repo;
}

/**
 * Point $LEINA_HOME at an isolated (usually empty) directory so the developer's
 * real user-layer rules/config cannot leak into a test. Returns a restore fn.
 */
export function isolateLeinaHome(dir: string): () => void {
  const saved = process.env.LEINA_HOME;
  process.env.LEINA_HOME = dir;
  return () => {
    if (saved === undefined) delete process.env.LEINA_HOME;
    else process.env.LEINA_HOME = saved;
  };
}

/** Serialize an object as the JSON-frontmatter rule/recipe document format. */
export function jsonFrontmatterDoc(data: unknown, body: string): string {
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n${body}\n`;
}
