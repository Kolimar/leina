// application/harness/shell-words.ts — the minimal reading of a shell command
// line behind the pre-bash guards (hooks.ts): does it run `git commit`/`git
// push`, and which paths does it WRITE (redirection targets and the operands of
// writer programs)?
//
// NOT a shell parser: no variable or glob expansion, no alias resolution, and
// subshell scoping is ignored (a `cd` inside `( … )` is assumed to persist,
// which only ever makes the guard stricter). Variable indirection (`git $x`,
// `rm $f`), quoted command substitution (`"$(git commit)"`), git aliases
// (`git ci`, `git config alias.x commit`), interpreters (`python -c`, `node
// -e`) and scripts the agent writes and runs all evade it. The harness is a
// guardrail against accidents, not a sandbox against an adversarial agent —
// see docs/concepts/07-harness.md.

import path from "node:path";

export interface ShellToken {
  text: string;
  /** Any character of this token came from inside quotes. */
  quoted: boolean;
  /** Set on an unquoted redirection operator (`>`, `2>>`, `&>`, `<<` …); the next token is its target. */
  redirect?: string;
}

/** Unquoted characters that end a simple command besides `&`/`|` (subshells, substitutions). */
const SEGMENT_BREAKS = new Set([";", "\n", "(", ")", "`"]);
/** What a backslash escapes inside double quotes (POSIX); before any other character it is literal. */
const DQ_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

/** Accumulates tokens and simple-command segments for shellSegments. */
class SegmentBuilder {
  readonly segments: ShellToken[][] = [];
  private tokens: ShellToken[] = [];
  private current = "";
  private quoted = false;

  append(text: string): void {
    this.current += text;
  }

  token(): void {
    if (this.current.length > 0 || this.quoted) this.tokens.push({ text: this.current, quoted: this.quoted });
    this.current = "";
    this.quoted = false;
  }

  segment(): void {
    this.token();
    if (this.tokens.length > 0) this.segments.push(this.tokens);
    this.tokens = [];
  }

  /** Consume the quoted run opening at `i`; returns the index of its closing quote (or the end). */
  quotedRun(command: string, i: number): number {
    const quote = command[i];
    this.quoted = true;
    let j = i + 1;
    for (; j < command.length && command[j] !== quote; j += 1) {
      // "C:\Users\me" keeps its separators: only DQ_ESCAPABLE characters are escaped.
      if (quote === '"' && command[j] === "\\" && j + 1 < command.length && DQ_ESCAPABLE.has(command[j + 1]!)) j += 1;
      this.current += command[j];
    }
    return j;
  }

  /** Emit the redirection operator starting at `i`; returns the index of its last character. */
  redirect(command: string, i: number): number {
    // Digits typed right before the operator are its fd (`2>`), not a word.
    const fd = !this.quoted && /^\d+$/.test(this.current) ? this.current : "";
    if (fd.length > 0) this.current = "";
    else this.token();
    const end = redirectEnd(command, i);
    const op = fd + command.slice(i, end);
    this.tokens.push({ text: op, quoted: false, redirect: op });
    return end - 1;
  }
}

/**
 * Quote-aware split into simple commands — on UNQUOTED `&&`, `||`, `&`, `|`,
 * `|&`, `;`, newline, `(`, `)` and backticks — and tokens on unquoted
 * whitespace, with redirection operators as their own tokens (an fd prefix
 * such as `2>` belongs to the operator; `2>&1`, `&>`, `>>`, `>|`, `<<-` too).
 */
export function shellSegments(command: string): ShellToken[][] {
  const b = new SegmentBuilder();
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === "'" || ch === '"') {
      i = b.quotedRun(command, i);
    } else if (ch === "\\" && i + 1 < command.length) {
      b.append(command[(i += 1)]!);
    } else if (ch === ">" || ch === "<" || (ch === "&" && command[i + 1] === ">")) {
      i = b.redirect(command, i);
    } else if (ch === "&" || ch === "|") {
      b.segment();
      const next = command[i + 1];
      if (next === ch || (ch === "|" && next === "&")) i += 1; // && || |&
    } else if (SEGMENT_BREAKS.has(ch)) {
      b.segment();
    } else if (/\s/.test(ch)) {
      b.token();
    } else {
      b.append(ch);
    }
  }
  b.segment();
  return b.segments;
}

/** End (exclusive) of the redirection operator starting at `i`. */
function redirectEnd(command: string, i: number): number {
  let j = i;
  while (j < command.length && j - i < 3 && "<>&".includes(command[j]!)) j += 1;
  if (command[j - 1] === ">" && command[j] === "|") j += 1; // >| (noclobber override)
  else if (command[j - 1] === "<" && command[j - 2] === "<" && command[j] === "-") j += 1; // <<- heredoc
  return j;
}

export function basenameOf(program: string): string {
  const slash = program.lastIndexOf("/");
  return slash === -1 ? program : program.slice(slash + 1);
}

const ASSIGNMENT_RE = /^[A-Za-z_]\w*=/;
/** Words that precede the real program of a simple command (their flags are skipped too). */
const COMMAND_PREFIXES = new Set([
  "sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "xargs", "stdbuf",
  "{", "}", "!", "if", "then", "else", "elif", "do", "while", "until",
]);

interface SimpleCommand {
  /** Basename of the program (absent for a bare assignment / redirection). */
  program?: string;
  /** Words after the program, redirections removed. */
  args: ShellToken[];
  /** Every word, redirections removed (git detection scans all of them). */
  words: ShellToken[];
  redirects: { op: string; target?: string }[];
}

function simpleCommand(tokens: ShellToken[]): SimpleCommand {
  const words: ShellToken[] = [];
  const redirects: SimpleCommand["redirects"] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.redirect === undefined) {
      words.push(t);
      continue;
    }
    const target = tokens[i + 1];
    redirects.push({ op: t.redirect, ...(target !== undefined && target.redirect === undefined ? { target: target.text } : {}) });
    if (target !== undefined && target.redirect === undefined) i += 1;
  }
  let k = 0;
  while (k < words.length) {
    const w = words[k]!;
    if (!w.quoted && ASSIGNMENT_RE.test(w.text)) {
      k += 1;
      continue;
    }
    if (w.quoted || !COMMAND_PREFIXES.has(basenameOf(w.text))) break;
    k += 1;
    while (k < words.length && !words[k]!.quoted && words[k]!.text.startsWith("-")) k += 1;
  }
  const program = words[k];
  return {
    ...(program !== undefined ? { program: basenameOf(program.text) } : {}),
    args: words.slice(k + 1),
    words,
    redirects,
  };
}

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const OUTPUT_ONLY = new Set(["echo", "printf"]);

/** git's global flags that consume the next word as their value. */
const GIT_VALUE_FLAGS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** The git subcommand of `words` (the first non-flag word after an unquoted `git`), with its index. */
function gitSubcommand(words: ShellToken[]): { name: string; index: number } | undefined {
  const gitIdx = words.findIndex((t) => !t.quoted && (t.text === "git" || t.text.endsWith("/git")));
  if (gitIdx === -1) return undefined;
  for (let i = gitIdx + 1; i < words.length; i += 1) {
    const t = words[i]!;
    if (!t.quoted && GIT_VALUE_FLAGS.has(t.text)) {
      i += 1;
      continue;
    }
    if (!t.quoted && t.text.startsWith("-")) continue; // other global flags
    return { name: t.text, index: i };
  }
  return undefined;
}

/**
 * Best-effort git commit/push detection: per simple command, an UNQUOTED
 * `git` word whose subcommand is `commit`/`push` (quoted or not — the shell
 * would still run it). Recurses into `sh -c '…'` payloads; skips
 * `echo`/`printf` commands (their arguments are data). Git aliases (`git ci`)
 * are a known gap: resolving them would mean running git config.
 */
export function gitCommitOrPush(command: string, depth = 0): "commit" | "push" | undefined {
  if (depth > 3) return undefined;
  for (const tokens of shellSegments(command)) {
    const { program, args, words } = simpleCommand(tokens);
    if (program !== undefined && OUTPUT_ONLY.has(program)) continue;
    if (program !== undefined && SHELL_WRAPPERS.has(program)) {
      const payload = args.find((t) => t.quoted);
      const inner = payload !== undefined ? gitCommitOrPush(payload.text, depth + 1) : undefined;
      if (inner !== undefined) return inner;
    }
    const sub = gitSubcommand(words)?.name;
    if (sub === "commit" || sub === "push") return sub;
  }
  return undefined;
}

/** Programs any of whose operands may be written, created, removed or re-pointed. */
const ANY_OPERAND_WRITERS = new Set([
  "tee", "mv", "rm", "rmdir", "unlink", "shred", "truncate", "ln", "link", "chmod", "chown", "chgrp",
  "touch", "sponge",
]);
/** Copy-like programs: only the destination is written (the last operand, or `-t DIR`). */
const DESTINATION_WRITERS = new Set(["cp", "install", "rsync", "scp"]);
/** In-place editors: write their file operands only with -i / --in-place. */
const IN_PLACE_EDITORS = new Set(["sed", "gsed", "perl"]);
/** git subcommands that rewrite working-tree paths given as operands. */
const GIT_WRITE_SUBCOMMANDS = new Set(["checkout", "restore", "rm", "mv", "reset", "clean", "stash", "apply", "switch"]);

function destinationOperand(texts: string[]): string[] {
  const t = texts.findIndex((x) => x === "-t" || x === "--target-directory");
  const flagged = t !== -1 ? texts[t + 1] : texts.find((x) => x.startsWith("--target-directory="))?.split("=")[1];
  if (flagged !== undefined) return [flagged];
  const last = texts.filter((x) => !x.startsWith("-")).at(-1);
  return last !== undefined ? [last] : [];
}

/** Operands `program` writes, given its arguments. */
function writtenOperands(program: string, args: ShellToken[]): string[] {
  const texts = args.map((a) => a.text);
  if (ANY_OPERAND_WRITERS.has(program)) return texts;
  if (DESTINATION_WRITERS.has(program)) return destinationOperand(texts);
  if (IN_PLACE_EDITORS.has(program)) {
    return texts.some((x) => /^-[A-Za-z]*i/.test(x) || x.startsWith("--in-place")) ? texts : [];
  }
  if (program === "dd") return texts.filter((x) => x.startsWith("of=")).map((x) => x.slice(3));
  if (program === "git") {
    const sub = gitSubcommand([{ text: "git", quoted: false }, ...args]);
    return sub !== undefined && GIT_WRITE_SUBCOMMANDS.has(sub.name) ? texts.slice(sub.index) : [];
  }
  return [];
}

/** `target` as seen from the directory a previous `cd` moved to ("" = where the command started). */
function fromDir(dir: string, target: string): string {
  if (dir === "" || target.startsWith("/") || target.startsWith("~") || target.startsWith("$")) return target;
  return path.posix.join(dir, target);
}

/**
 * Every path `command` may WRITE: output-redirection targets (`>`, `>>`,
 * `2>`, `&>` …) and the written operands of writer programs (rm, mv, tee,
 * cp's destination, sed -i, dd of=, git checkout/restore/rm …), resolved
 * against a preceding `cd`. Recurses into `sh -c '…'` and `eval '…'`. A read
 * that merely mentions a path (cat, grep, diff, cp's source) yields nothing.
 */
export function shellWriteTargets(command: string, depth = 0): string[] {
  if (depth > 3) return [];
  const targets: string[] = [];
  let dir = "";
  for (const tokens of shellSegments(command)) {
    const { program, args, redirects } = simpleCommand(tokens);
    for (const r of redirects) {
      if (r.op.includes(">") && r.target !== undefined) targets.push(fromDir(dir, r.target));
    }
    if (program === undefined) continue;
    if (program === "cd") {
      dir = args[0] !== undefined ? fromDir(dir, args[0].text) : "";
      continue;
    }
    let inner: string[] = [];
    if (SHELL_WRAPPERS.has(program)) {
      const payload = args.find((t) => t.quoted);
      if (payload !== undefined) inner = shellWriteTargets(payload.text, depth + 1);
    } else if (program === "eval") {
      inner = shellWriteTargets(args.map((a) => a.text).join(" "), depth + 1);
    } else {
      inner = writtenOperands(program, args);
    }
    targets.push(...inner.map((t) => fromDir(dir, t)));
  }
  return targets;
}
