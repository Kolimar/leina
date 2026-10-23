// application/harness/shell-words.ts — the minimal reading of a shell command
// line behind the pre-bash guards (hooks.ts): does it run `git commit`/`git
// push`, which paths does it WRITE (redirection targets and the operands of
// writer programs), and is it DESTRUCTIVE (destructiveCommand, at the end)?
//
// NOT a shell parser: no variable or glob expansion, no alias resolution, and
// subshell scoping is ignored (a `cd` inside `( … )` is assumed to persist,
// which only ever makes the guard stricter). Variable indirection (`git $x`,
// `rm $f`), quoted command substitution (`"$(git commit)"`), git aliases
// (`git ci`, `git config alias.x commit`), interpreters (`python -c`, `node
// -e`) and scripts the agent writes and runs all evade it. The harness is a
// guardrail against accidents, not a sandbox against an adversarial agent —
// see docs/concepts/07-harness.md.
//
// Heredocs: after `<<WORD` / `<<-WORD` (quoted or not) the body up to the
// closing line is DATA, not commands; it rides on the redirection token
// (`heredoc`). Only when the program is a shell (`bash <<EOF`) is the body read
// as a script. A here-string (`<<<`) is not a heredoc. Comments: an unquoted
// `#` at the start of a word ignores the rest of the line (`a#b`, `$#`,
// `${#x}` and a quoted `#` are not comments).

import path from "node:path";

export interface ShellToken {
  text: string;
  /** Any character of this token came from inside quotes. */
  quoted: boolean;
  /** Set on an unquoted redirection operator (`>`, `2>>`, `&>`, `<<` …); the next token is its target. */
  redirect?: string;
  /** On a `<<` / `<<-` redirection token: the raw body up to (not including) the closing delimiter line. */
  heredoc?: string;
}

interface PendingHeredoc {
  token: ShellToken;
  delimiter: string;
  stripTabs: boolean;
  /** The delimiter had quotes or a backslash: the body is fully literal. */
  literal: boolean;
}

/** End index (the closing `)`) of the `( … )` opening at `open`, honouring quotes and nesting; -1 when unclosed. */
function parenEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "\\") i += 1;
    else if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      if (close === -1) return -1;
      i = close;
    } else if (c === "(") depth += 1;
    else if (c === ")" && (depth -= 1) === 0) return i;
  }
  return -1;
}

/** The command substitutions (`$( … )`, backtick spans) inside `text`, as their inner command strings. */
function commandSubstitutions(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "\\") {
      i += 1;
    } else if (c === "$" && text[i + 1] === "(") {
      const end = parenEnd(text, i + 1);
      found.push(text.slice(i + 2, end === -1 ? text.length : end));
      if (end === -1) break;
      i = end;
    } else if (c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
      found.push(text.slice(i + 1, Math.min(j, text.length)));
      i = j;
    }
  }
  return found;
}

/** End of the arithmetic `(( … ))` opening at `open` (`((`), or -1 when it is nested subshells instead. */
function arithmeticEnd(text: string, open: number): number {
  const end = parenEnd(text, open);
  return end > open + 1 && text[end - 1] === ")" && parenEnd(text, open + 1) === end - 1 ? end : -1;
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
  private pending: PendingHeredoc[] = [];
  /** Segments of the command substitutions found inside unquoted heredoc bodies and arithmetic. */
  readonly extra: ShellToken[][] = [];

  atWordStart(): boolean {
    return this.current.length === 0 && !this.quoted;
  }

  append(text: string): void {
    this.current += text;
  }

  endsWithDollar(): boolean {
    return this.current.endsWith("$") && !this.quoted;
  }

  /**
   * An arithmetic span `$(( … ))` / `(( … ))` opening at `i` (`<<` inside is a shift): returns its
   * end index, or -1 when none opens here. With `consume`, swallows it (its substitutions still run).
   */
  arithmetic(command: string, i: number, consume = false): number {
    const word = this.endsWithDollar();
    if (command[i + 1] !== "(" || !(word || this.atWordStart())) return -1;
    const end = arithmeticEnd(command, i);
    if (end === -1 || !consume) return end;
    const span = command.slice(i, end + 1);
    if (word) this.current += span;
    else this.segment();
    this.addSubstitutions(span);
    return end;
  }

  addSubstitutions(text: string): void {
    for (const inner of commandSubstitutions(text)) this.extra.push(...shellSegments(inner));
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

  /** `&&`, `||`, `&`, `|`, `|&` at `i`: ends the command; returns the index of its last character. */
  separator(command: string, i: number): number {
    this.segment();
    const next = command[i + 1];
    return next === command[i] || (command[i] === "|" && next === "&") ? i + 1 : i;
  }

  /** Emit the redirection operator starting at `i`; returns the index of its last character. */
  redirect(command: string, i: number): number {
    // Digits typed right before the operator are its fd (`2>`), not a word.
    const fd = !this.quoted && /^\d+$/.test(this.current) ? this.current : "";
    if (fd.length > 0) this.current = "";
    else this.token();
    const end = redirectEnd(command, i);
    const op = fd + command.slice(i, end);
    const token: ShellToken = { text: op, quoted: false, redirect: op };
    this.tokens.push(token);
    const heredoc = /^\d*<<(-?)$/.exec(op);
    return heredoc !== null ? this.heredocWord(command, end, token, heredoc[1] === "-") : end - 1;
  }

  /** Read the delimiter word after a `<<`; returns the index of its last character (or `from - 1`). */
  private heredocWord(command: string, from: number, op: ShellToken, stripTabs: boolean): number {
    let j = from;
    while (j < command.length && (command[j] === " " || command[j] === "\t")) j += 1;
    let delimiter = "";
    let quoted = false;
    for (; j < command.length && !/[\s;&|()<>]/.test(command[j]!); j += 1) {
      const c = command[j]!;
      if (c === "'" || c === '"') {
        quoted = true;
        const close = command.indexOf(c, j + 1);
        const stop = close === -1 ? command.length : close;
        delimiter += command.slice(j + 1, stop);
        j = stop;
      } else if (c === "\\" && j + 1 < command.length) {
        quoted = true;
        delimiter += command[(j += 1)];
      } else {
        delimiter += c;
      }
    }
    if (delimiter.length === 0) return from - 1;
    this.tokens.push({ text: delimiter, quoted });
    this.pending.push({ token: op, delimiter, stripTabs, literal: quoted });
    return j - 1;
  }

  /** An unquoted newline (ends the command, then reads pending heredoc bodies) or a comment (skipped to the newline). */
  lineEvent(command: string, i: number): number {
    if (command[i] === "#") {
      const nl = command.indexOf("\n", i);
      return nl === -1 ? command.length : nl - 1;
    }
    this.segment();
    return this.pending.length > 0 ? this.readHeredocBodies(command, i) : i;
  }

  /** Consume the bodies of the pending heredocs starting after the newline at `nl`; returns the last index consumed. */
  readHeredocBodies(command: string, nl: number): number {
    let pos = nl + 1;
    for (const { token, delimiter, stripTabs, literal } of this.pending) {
      const lines: string[] = [];
      while (pos < command.length) {
        const lineEnd = command.indexOf("\n", pos);
        const line = command.slice(pos, lineEnd === -1 ? command.length : lineEnd);
        pos = lineEnd === -1 ? command.length + 1 : lineEnd + 1;
        if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
        lines.push(line);
      }
      token.heredoc = lines.join("\n");
      if (!literal) this.addSubstitutions(token.heredoc);
    }
    this.pending = [];
    return Math.min(pos, command.length + 1) - 1;
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
    } else if (ch === "(" && b.arithmetic(command, i) !== -1) {
      i = b.arithmetic(command, i, true);
    } else if (ch === ">" || ch === "<" || (ch === "&" && command[i + 1] === ">")) {
      i = b.redirect(command, i);
    } else if (ch === "&" || ch === "|") {
      i = b.separator(command, i);
    } else if (ch === "\n" || (ch === "#" && b.atWordStart())) {
      i = b.lineEvent(command, i);
    } else if (SEGMENT_BREAKS.has(ch)) {
      b.segment();
    } else if (/\s/.test(ch)) {
      b.token();
    } else {
      b.append(ch);
    }
  }
  b.segment();
  return [...b.segments, ...b.extra];
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
  "sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "xargs", "stdbuf", "timeout",
  "{", "}", "!", "if", "then", "else", "elif", "do", "while", "until",
]);

/** Per prefix: the flags that take a SEPARATE value word (`--flag=value` stays one word). */
const PREFIX_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "-S"]),
  nice: new Set(["-n"]),
  time: new Set(["-f", "-o"]),
  xargs: new Set(["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a"]),
  timeout: new Set(["-s", "-k"]),
};
/** Per prefix: the LONG flags that take a separate value word (`--flag=value` stays one word). */
const PREFIX_LONG_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set([
    "--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout",
    "--close-from",
  ]),
  env: new Set(["--unset", "--chdir", "--split-string"]),
  nice: new Set(["--adjustment"]),
  time: new Set(["--format", "--output"]),
  timeout: new Set(["--signal", "--kill-after"]),
  xargs: new Set(["--max-args", "--max-procs", "--delimiter", "--max-chars", "--arg-file"]),
};

/** Does `flag` of prefix `name` consume the NEXT word? A cluster's first value letter ends it (`-uroot` is attached). */
function flagTakesNextWord(name: string, flag: string): boolean {
  if (flag.startsWith("--")) return PREFIX_LONG_VALUE_FLAGS[name]?.has(flag) === true;
  if (!/^-[A-Za-z]+$/.test(flag)) return false;
  const valueFlags = PREFIX_VALUE_FLAGS[name];
  const letters = [...flag.slice(1)];
  const at = letters.findIndex((c) => valueFlags?.has(`-${c}`) === true);
  return at !== -1 && at === letters.length - 1;
}

/** Prefixes followed by positional words before the program (`timeout 5 cmd`). */
const PREFIX_POSITIONALS: Record<string, number> = { timeout: 1 };

interface SimpleCommand {
  /** Basename of the program (absent for a bare assignment / redirection). */
  program?: string;
  /** Words after the program, redirections removed. */
  args: ShellToken[];
  /** Every word, redirections removed (git detection scans all of them). */
  words: ShellToken[];
  redirects: { op: string; target?: string }[];
  /** Raw bodies of the heredocs attached to this command. */
  heredocs: string[];
  /** Command strings carried by prefix flags (`env -S '…'`): scripts to recurse into. */
  scripts: string[];
}

/** Skip the flags (and their values) of prefix `name` starting at `k`; returns the next index. */
function skipPrefixFlags(words: ShellToken[], k: number, name: string, scripts: string[]): number {
  while (k < words.length && !words[k]!.quoted && words[k]!.text.startsWith("-")) {
    const flag = words[k]!.text;
    k += 1;
    if (name === "env" && flag.startsWith("--split-string=")) scripts.push(flag.slice("--split-string=".length));
    if (!flagTakesNextWord(name, flag)) continue;
    if (name === "env" && (flag === "-S" || flag === "--split-string") && words[k] !== undefined) scripts.push(words[k]!.text);
    k += 1;
  }
  return Math.min(k + (PREFIX_POSITIONALS[name] ?? 0), words.length);
}

function simpleCommand(tokens: ShellToken[]): SimpleCommand {
  const words: ShellToken[] = [];
  const redirects: SimpleCommand["redirects"] = [];
  const heredocs: string[] = [];
  const scripts: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.redirect === undefined) {
      words.push(t);
      continue;
    }
    if (t.heredoc !== undefined) heredocs.push(t.heredoc);
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
    k = skipPrefixFlags(words, k + 1, basenameOf(w.text), scripts);
  }
  const program = words[k];
  return {
    ...(program !== undefined ? { program: basenameOf(program.text) } : {}),
    args: words.slice(k + 1),
    words,
    redirects,
    heredocs,
    scripts,
  };
}

/**
 * Scripts a simple command carries: `env -S '…'`, a shell's `-c` payload (the
 * first quoted word) and, for a shell without one, its heredoc bodies.
 */
function nestedScripts(simple: SimpleCommand): string[] {
  const found = [...simple.scripts];
  if (simple.program !== undefined && SHELL_WRAPPERS.has(simple.program)) {
    const payload = simple.args.find((t) => t.quoted);
    if (payload !== undefined) found.push(payload.text);
    else found.push(...simple.heredocs);
  }
  return found;
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
    const simple = simpleCommand(tokens);
    const { program, words } = simple;
    if (program !== undefined && OUTPUT_ONLY.has(program)) continue;
    for (const script of nestedScripts(simple)) {
      const inner = gitCommitOrPush(script, depth + 1);
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

/** Programs after which the shell's current directory is their first operand. */
const CHANGES_DIR = new Set(["cd", "pushd"]);

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
    const simple = simpleCommand(tokens);
    const { program, args, redirects } = simple;
    for (const r of redirects) {
      if (r.op.includes(">") && r.target !== undefined) targets.push(fromDir(dir, r.target));
    }
    if (program === undefined) continue;
    if (CHANGES_DIR.has(program)) {
      dir = args[0] !== undefined ? fromDir(dir, args[0].text) : "";
      continue;
    }
    const inner = nestedScripts(simple).flatMap((script) => shellWriteTargets(script, depth + 1));
    if (program === "eval") inner.push(...shellWriteTargets(args.map((a) => a.text).join(" "), depth + 1));
    else if (!SHELL_WRAPPERS.has(program)) inner.push(...writtenOperands(program, args));
    targets.push(...inner.map((t) => fromDir(dir, t)));
  }
  return targets;
}

// ---------------------------------------------------------------------------
// destructiveCommand — the shell commands an agent must never run itself.
// Same reading of the command line as above, with the same limits. Known gaps
// (a guardrail against accidents, not a sandbox): quoted substitution
// (`"$(rm -rf ~)"`), variables (`rm -rf $DIR`), SQL fed from heredocs or `-f
// file.sql`, `find -delete` / `-exec`, targets fed through `xargs`,
// interpreters (`python -c`) and scripts the agent writes and runs.
// ---------------------------------------------------------------------------

export interface DestructiveContext {
  /** The repo root: the directory the command starts in. */
  cwd: string;
  /** The user's home directory. */
  home: string;
}

const SQL_CLIENTS = new Set(["psql", "sqlite3", "mysql", "mariadb", "sqlcmd", "duckdb"]);

/** `-rf`, `-fR`, `-uf`: a short-flag cluster (single dash) containing `letter`. */
function clusterHas(text: string, letters: string): boolean {
  return /^-[A-Za-z]+$/.test(text) && [...text.slice(1)].some((c) => letters.includes(c));
}

/** The operand with one trailing `/`, `/*` or `/.*` dropped; a bare `*` / `.*` is the current dir. */
function trimOperand(operand: string): string {
  if (operand === "*" || operand === ".*") return ".";
  for (const tail of ["/.*", "/*", "/"]) {
    if (operand.endsWith(tail)) return operand.slice(0, -tail.length) || "/";
  }
  return operand;
}

/** `~`, `$HOME`, `${HOME}` (as a whole or a leading component) expanded; undefined for any other variable. */
function expandHome(operand: string, home: string): string | undefined {
  const m = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(operand);
  const expanded = m !== null ? home + operand.slice(m[0].length) : operand;
  return expanded.includes("$") ? undefined : expanded;
}

/** `p` in the form the rm checks compare: backslashes as `/`, a drive root (`C:\`) as `/C:/`. */
function posixPath(p: string): string {
  const slashed = p.replaceAll("\\", "/");
  return /^[A-Za-z]:(?:\/|$)/.test(slashed) ? `/${slashed}` : slashed;
}

/** Why `rm -r <operand>` would destroy more than a build directory, or undefined. */
function destructiveRmOperand(operand: string, dir: string, ctx: DestructiveContext): boolean {
  const moved = expandHome(fromDir(dir, trimOperand(posixPath(operand))), ctx.home);
  if (moved === undefined) return false;
  const cwd = path.posix.resolve(posixPath(ctx.cwd));
  const abs = path.posix.resolve(cwd, posixPath(moved));
  const home = path.posix.resolve(posixPath(ctx.home));
  if (abs === home || /^\/[^/]+$/.test(abs) || abs === path.posix.join(cwd, ".git")) return true;
  return abs === "/" || cwd === abs || cwd.startsWith(`${abs}/`);
}

function destructiveRm(args: ShellToken[], dir: string, ctx: DestructiveContext): string | undefined {
  const dashdash = args.findIndex((a) => a.text === "--");
  const flags = (dashdash === -1 ? args : args.slice(0, dashdash)).filter((a) => !a.quoted || a.text.startsWith("-"));
  const recursive = flags.some((a) => a.text === "--recursive" || clusterHas(a.text, "rR"));
  if (!recursive) return undefined;
  const operands = dashdash === -1 ? args.filter((a) => !a.text.startsWith("-")) : args.slice(dashdash + 1);
  const hit = operands.find((o) => destructiveRmOperand(o.text, dir, ctx));
  return hit !== undefined ? `rm -r ${hit.text}` : undefined;
}

function destructiveGit(sub: string, rest: string[]): string | undefined {
  const has = (long: string, letters: string): boolean => rest.some((t) => t === long || clusterHas(t, letters));
  switch (sub) {
    case "reset":
      return rest.includes("--hard") ? "git reset --hard" : undefined;
    case "clean":
      return has("--force", "f") && !has("--dry-run", "n") ? "git clean -f" : undefined;
    case "push":
      return has("--force", "f") || rest.some((t) => t.startsWith("+")) ? "git push --force" : undefined;
    case "branch": {
      if (rest.some((t) => clusterHas(t, "D"))) return "git branch -D";
      return has("--delete", "d") && has("--force", "f") ? "git branch -D" : undefined;
    }
    default:
      return undefined;
  }
}

function destructiveSql(words: ShellToken[]): string | undefined {
  const idx = words.findIndex((w) => !w.quoted && SQL_CLIENTS.has(basenameOf(w.text)));
  if (idx === -1) return undefined;
  const sql = words.slice(idx + 1).map((w) => w.text).join(" ");
  if (/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(sql)) return "SQL DROP";
  if (/\bTRUNCATE\b/i.test(sql)) return "SQL TRUNCATE";
  const bare = sql.split(";").some((st) => {
    const del = /\bDELETE\s+FROM\b/i.exec(st);
    return del !== null && !/\bWHERE\b/i.test(st.slice(del.index));
  });
  return bare ? "SQL DELETE without WHERE" : undefined;
}

function destructiveSimple(simple: SimpleCommand, dir: string, ctx: DestructiveContext): string | undefined {
  if (simple.program === "rm") return destructiveRm(simple.args, dir, ctx);
  const sub = gitSubcommand(simple.words);
  if (sub !== undefined) {
    const found = destructiveGit(sub.name, simple.words.slice(sub.index + 1).map((w) => w.text));
    if (found !== undefined) return found;
  }
  return destructiveSql(simple.words);
}

/**
 * A short label for the first destructive simple command in `command` (`rm -r
 * /`, `git reset --hard`, `git clean -f`, `git push --force`, `git branch -D`,
 * SQL DROP / TRUNCATE / DELETE without WHERE), else undefined. Recurses into
 * `sh -c '…'` and `eval …`; skips `echo`/`printf` (data); tracks a preceding
 * `cd` for relative `rm` operands.
 */
export function destructiveCommand(
  command: string,
  ctx: DestructiveContext,
  depth = 0,
  startDir = "",
): string | undefined {
  if (depth > 3) return undefined;
  let dir = startDir;
  for (const tokens of shellSegments(command)) {
    const simple = simpleCommand(tokens);
    const { program, args } = simple;
    if (program === undefined && simple.scripts.length === 0) continue;
    if (program !== undefined && OUTPUT_ONLY.has(program)) continue;
    if (program !== undefined && CHANGES_DIR.has(program)) {
      dir = args[0] !== undefined ? fromDir(dir, args[0].text) : "";
      continue;
    }
    const scripts = nestedScripts(simple);
    if (program === "eval") scripts.push(args.map((a) => a.text).join(" "));
    let inner: string | undefined;
    for (const script of scripts) {
      inner ??= destructiveCommand(script, ctx, depth + 1, dir);
    }
    const found = inner ?? (program !== undefined ? destructiveSimple(simple, dir, ctx) : undefined);
    if (found !== undefined) return found;
  }
  return undefined;
}
