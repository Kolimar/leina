// cli/project-args.ts — the optional <dir> positional of the per-project commands.
//
// Rules (documented per command in ./commands.ts and in docs/CLI_REFERENCE.md):
//   - <dir> is optional everywhere and defaults to the current directory;
//   - it is resolved to the project root (resolveGraphRoot): the nearest enclosing leina
//     project, else the git toplevel — so a command run from `src/` reads the repo's graph
//     and memory instead of creating a second project there;
//   - an explicit <dir> that is not an existing directory is a usage error (exit 2), never
//     created: a typo must not get its own empty graph;
//   - flag values are never positionals (`visualize --out x.html` once took x.html as the
//     project), so every helper reads the positionals through the command table.
// `init`/`deinit` and the workspace commands take their <dir> as given (existingDir).

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveGraphRoot } from "../application/project/root.ts";
import { positionals } from "./args.ts";
import { valueFlags } from "./commands.ts";
import { usageError } from "./io.ts";

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Words that can only be a path (`.`, `..`, `/x`, `./x`, `../x`, `~/x`, `C:\x`): never read as
 * query text, so a mistyped directory is reported instead of silently searched for.
 */
export function looksLikePath(word: string): boolean {
  return word === "." || word === ".." || /^(\/|\.\.?[/\\]|~)/.test(word) || /^[A-Za-z]:[\\/]/.test(word);
}

/** `dir` as an absolute path; a usage error unless it is an existing directory. */
export function existingDir(dir: string): string {
  const abs = resolve(dir);
  if (isDirectory(abs)) return abs;
  let exists = true;
  try {
    statSync(abs);
  } catch {
    exists = false;
  }
  return usageError(exists ? `not a directory: ${abs}` : `no such directory: ${abs}`);
}

/** The project root for an optional <dir> (absent → the current directory). */
export function projectRootOf(dir: string | undefined): string {
  return resolveGraphRoot(dir === undefined ? process.cwd() : existingDir(dir));
}

/** The positional words of `args` for the command at `path` (flag values skipped). */
export function commandWords(path: string, args: string[]): string[] {
  return positionals(args, valueFlags(path));
}

/** `<cmd> [<dir>]`: at most one positional, resolved to the project root. */
export function dirOnly(path: string, args: string[]): string {
  return projectRootOf(optionalDir(path, args));
}

/** `<cmd> [<dir>]` without resolution: the single optional positional, as typed. */
export function optionalDir(path: string, args: string[]): string | undefined {
  const words = commandWords(path, args);
  if (words.length > 1) usageError(`unexpected argument '${words[1]}' (${path} takes at most one <dir>)`, path);
  return words[0];
}

/**
 * `<cmd> [<dir>] <a> <b>...`: exactly `names.length` values, optionally preceded by <dir>.
 * With one positional more than the values, the first one is <dir> and must be a directory.
 */
export function dirThen(path: string, args: string[], names: string[]): { root: string; values: string[] } {
  const words = commandWords(path, args);
  if (words.length < names.length) usageError(`missing ${names.slice(words.length).join(" ")}`, path);
  if (words.length > names.length + 1) usageError(`unexpected argument '${words[names.length + 1]}'`, path);
  if (words.length === names.length) return { root: projectRootOf(undefined), values: words };
  const first = words[0]!;
  if (!isDirectory(first)) {
    if (looksLikePath(first)) existingDir(first); // "no such directory: <abs>"
    usageError(`'${first}' is not a directory (with ${names.length + 1} positionals the first one is <dir>)`, path);
  }
  return { root: projectRootOf(first), values: words.slice(1) };
}

/**
 * `<cmd> [<dir>] <text...>`: free text, optionally preceded by <dir>. The first word is <dir>
 * only when more words follow and it is an existing directory — or path-shaped (`./x`,
 * `/x`), which is then a usage error when it does not exist. Otherwise every word is text.
 */
export function dirThenText(path: string, args: string[], name: string): { root: string; text: string } {
  const words = commandWords(path, args);
  if (words.length === 0 || (words.length === 1 && looksLikePath(words[0]!))) usageError(`missing ${name}`, path);
  const first = words[0]!;
  if (words.length >= 2 && (isDirectory(first) || looksLikePath(first))) {
    return { root: projectRootOf(first), text: words.slice(1).join(" ") };
  }
  return { root: projectRootOf(undefined), text: words.join(" ") };
}
