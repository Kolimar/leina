// application/harness/io.ts — tiny shared filesystem helpers for the harness
// use-cases (loader, config-io, contract-io, gates). Ported from the origin's
// util/fs.ts. Plain node:fs — no globbing library; directory walks live in
// the callers that need them.

import fs from "node:fs/promises";
import path from "node:path";

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export interface JsonReadResult {
  value?: unknown;
  error?: string;
}

/** Read+parse a JSON file; absent file → {}, parse error → { error }. */
export async function readJsonIfExists(file: string): Promise<JsonReadResult> {
  const text = await readTextIfExists(file);
  if (text === undefined) return {};
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { error: `invalid JSON (${(err as Error).message})` };
  }
}

/**
 * Recursively list files under `dir` matching `extension`, as absolute paths,
 * sorted. Missing directory → empty list.
 */
export async function listFilesRecursive(dir: string, extension: string): Promise<string[]> {
  let entries: { name: string; parentPath: string; isFile(): boolean }[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(extension))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}
