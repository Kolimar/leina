// application/harness/gates/file.ts — the `file` gate: assert that files
// matching a path (glob allowed) exist / don't exist and satisfy content
// constraints. Globs resolve against a repo walk that skips `.git/` and
// `node_modules/` (the origin used a globbing library; the harness's own
// matcher keeps the port dependency-free).

import path from "node:path";
import fs from "node:fs/promises";
import { type FileGate } from "../../../domain/harness/model.ts";
import { hasGlobMagic, isGlobMatch } from "../../../domain/harness/glob.ts";
import { fileExists } from "../io.ts";
import { type GateContext, type GateOutcome } from "./types.ts";

const WALK_EXCLUDED = new Set([".git", "node_modules"]);

async function resolveMatches(repoRoot: string, pattern: string): Promise<string[]> {
  if (!hasGlobMagic(pattern)) {
    const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
    return (await fileExists(path.join(repoRoot, normalized))) ? [normalized] : [];
  }
  const matches: string[] = [];
  for (const rel of await walkRepoFiles(repoRoot)) {
    if (isGlobMatch(rel, pattern, { dot: true })) matches.push(rel);
  }
  return matches.sort();
}

/** Repo-relative posix paths of all files, skipping .git/ and node_modules/. */
async function walkRepoFiles(repoRoot: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (WALK_EXCLUDED.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) files.push(path.relative(repoRoot, abs).split(path.sep).join("/"));
    }
  }
  return files;
}

export async function runFileGate(gate: FileGate, ctx: GateContext): Promise<GateOutcome> {
  const matches = await resolveMatches(ctx.repoRoot, gate.path);

  if (!gate.exists) {
    if (matches.length > 0) {
      return {
        status: "fail",
        detail: `expected no file matching "${gate.path}", found: ${matches.join(", ")}`,
      };
    }
    return { status: "pass", detail: `no file matches "${gate.path}"` };
  }

  if (matches.length === 0) {
    return { status: "fail", detail: `no file matches "${gate.path}"` };
  }

  for (const rel of matches) {
    const outcome = await checkFileConstraints(gate, ctx.repoRoot, rel);
    if (outcome !== undefined) return outcome;
  }
  return { status: "pass", detail: `${matches.length} file(s) match "${gate.path}" and satisfy constraints` };
}

/** Returns a failing outcome for `rel`, or undefined when all constraints hold. */
async function checkFileConstraints(
  gate: FileGate,
  repoRoot: string,
  rel: string,
): Promise<GateOutcome | undefined> {
  const content = await fs.readFile(path.join(repoRoot, rel), "utf8");

  if (gate.minBytes !== undefined && Buffer.byteLength(content, "utf8") < gate.minBytes) {
    return {
      status: "fail",
      detail: `${rel} is ${Buffer.byteLength(content, "utf8")} bytes (< ${gate.minBytes} required)`,
    };
  }
  if (gate.contentMatch !== undefined) {
    const re = compile(gate.contentMatch);
    if (re instanceof Error) return { status: "error", detail: `invalid contentMatch regex: ${re.message}` };
    if (!re.test(content)) {
      return { status: "fail", detail: `${rel} does not match /${gate.contentMatch}/` };
    }
  }
  if (gate.contentNotMatch !== undefined) {
    const re = compile(gate.contentNotMatch);
    if (re instanceof Error) {
      return { status: "error", detail: `invalid contentNotMatch regex: ${re.message}` };
    }
    if (re.test(content)) {
      return { status: "fail", detail: `${rel} matches forbidden /${gate.contentNotMatch}/` };
    }
  }
  return undefined;
}

function compile(pattern: string): RegExp | Error {
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern comes from trusted rule files (.harness/rules/, bundled assets), invalid patterns map to an error outcome
    return new RegExp(pattern, "m");
  } catch (err) {
    return err as Error;
  }
}
