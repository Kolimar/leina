// domain/memory/symbol-span.ts — where a graph symbol's source text lives, for drift checks.
//
// A memory anchored to `computeTotal()` should go stale when computeTotal's code changes,
// not when an unrelated function in the same file does. The graph only records where a
// symbol STARTS (`sourceLocation: "L42"`), so the span is derived from the source text:
// find the symbol's name at (or nearest to) that line, then scan to the end of its
// declaration — matching brackets for C-family languages, the indented block for Python.
// The span is a heuristic, but a deterministic one: the same text, label and hint always
// give the same span, so a fingerprint taken at save time and one taken at verify time
// differ only when the symbol's own lines changed (whitespace and blank lines aside).
//
// Pure: strings in, line numbers / strings out. Hashing lives in the application layer.

/** 1-based, inclusive line range. */
export interface LineSpan {
  start: number;
  end: number;
}

/** Prefix of a symbol-level anchor fingerprint; a bare 64-hex anchor hash is file-level. */
export const SYMBOL_FINGERPRINT_PREFIX = "sym1:";

const FILE_HASH_RE = /^[0-9a-f]{64}$/;

export function isSymbolFingerprint(hash: string): boolean {
  return hash.startsWith(SYMBOL_FINGERPRINT_PREFIX);
}

/** A whole-file sha256 anchor hash (the pre-3.0 format, still used for module-level anchors). */
export function isFileLevelHash(hash: string): boolean {
  return FILE_HASH_RE.test(hash);
}

// Longest span considered: past this a scan that never closed (a confused tokenizer, a
// generated file) is cut off rather than swallowing the rest of a huge file.
const MAX_SPAN_LINES = 2000;

const BRACE_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "java", "cs", "go", "rs", "c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx",
  "kt", "kts", "swift", "scala", "php", "dart", "groovy",
]);
const INDENT_EXTENSIONS = new Set(["py", "pyi"]);

type SpanLanguage = "brace" | "indent";

function spanLanguage(file: string): SpanLanguage | null {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  if (BRACE_EXTENSIONS.has(ext)) return "brace";
  if (INDENT_EXTENSIONS.has(ext)) return "indent";
  return null;
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * The bare identifier a graph label names: `computeTotal()` → `computeTotal`,
 * `Foo.bar()` → `bar`, `Ns::Type` → `Type`. Null for labels that are not identifiers
 * (file paths, config keys).
 */
export function symbolName(label: string): string | null {
  let s = label.trim();
  if (/[/\\]/.test(s)) return null; // a file path
  if (s.endsWith("()")) s = s.slice(0, -2);
  const parts = s.split(/\.|::|#/);
  const last = parts[parts.length - 1] ?? "";
  return IDENT_RE.test(last) ? last : null;
}

/** `"L42"` → 42; anything else → undefined. */
export function parseLineHint(sourceLocation: string | undefined): number | undefined {
  if (sourceLocation === undefined) return undefined;
  const m = /^L(\d+)/.exec(sourceLocation);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 ? n : undefined;
}

function isCommentOnly(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("#");
}

const IDENT_CHAR_RE = /[\w$]/;

// `name` occurs in `line` as a whole identifier (not inside a longer one).
function hasWord(line: string, name: string): boolean {
  for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
    const before = at === 0 ? "" : line[at - 1]!;
    const after = line[at + name.length] ?? "";
    if (!IDENT_CHAR_RE.test(before) && !IDENT_CHAR_RE.test(after)) return true;
  }
  return false;
}

// The line (0-based) holding `name`: the hinted line when it names it, else the nearest
// line that does (earlier line first on a tie), skipping comment-only lines. A stale graph
// whose hint drifted by a few lines still lands on the declaration.
function findStartLine(lines: string[], name: string, hint: number): number {
  const names = (i: number): boolean =>
    i >= 0 && i < lines.length && !isCommentOnly(lines[i]!) && hasWord(lines[i]!, name);
  const h = Math.min(Math.max(hint - 1, 0), lines.length - 1);
  if (names(h)) return h;
  for (let d = 1; h - d >= 0 || h + d < lines.length; d++) {
    if (names(h - d)) return h - d;
    if (names(h + d)) return h + d;
  }
  return -1;
}

// Last code character of a line ends an expression that continues on the next line.
const CONTINUES_AFTER = new Set([",", "=", "(", "[", "{", "+", "-", "*", "/", "%", "&", "|", "^", "!", "?", ":", "<", ".", "\\"]);
// A next line opening like this continues the current declaration (Allman braces, method
// chains, ternaries, union types, Java/C# clauses).
const CONTINUES_BEFORE_RE = /^(?:[{.?:|&+*=]|-(?!-)|=>|extends\b|implements\b|throws\b|where\b)/;

interface LineScan {
  /** A `}` brought the depth back to 0 on this line. */
  closedTop: boolean;
  /** A `;` at depth 0 on this line. */
  semicolonTop: boolean;
  /** Last character outside comments (strings count), or "" for a comment-only/blank line. */
  lastCode: string;
}

interface ScanState {
  /** Bracket depth ( [ { across lines. */
  depth: number;
  quote: string | null;
  inBlockComment: boolean;
  /** Rust: `'a` is a lifetime, not a char literal. */
  lifetimes: boolean;
}

// A `/` after one of these (or at line start, or after a keyword) opens a regex literal;
// after an identifier, a number or a closing bracket it is division.
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const KEYWORD_BEFORE_REGEX_RE = /\b(?:return|typeof|case|in|of|delete|void|throw|new|yield|await|else|do)\s*$/;
const LIFETIME_RE = /^'[A-Za-z_]\w*(?!['\w])/;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

// Index of the `/` closing the regex literal opened at `j`, or -1 (not a regex on this line).
function regexEnd(line: string, j: number): number {
  let inClass = false;
  for (let k = j + 1; k < line.length; k++) {
    const d = line[k]!;
    if (d === "\\") k++;
    else if (inClass) inClass = d !== "]";
    else if (d === "[") inClass = true;
    else if (d === "/") return k;
  }
  return -1;
}

// A `/` outside strings: line comment (-1: stop), block comment, regex literal or operator.
// Returns the index of the last character consumed.
function scanSlash(line: string, j: number, st: ScanState, out: LineScan): number {
  const next = line[j + 1];
  if (next === "/") return -1;
  if (next === "*") {
    st.inBlockComment = true;
    return j + 1;
  }
  const regexContext = REGEX_AFTER.has(out.lastCode) || KEYWORD_BEFORE_REGEX_RE.test(line.slice(0, j));
  const end = regexContext ? regexEnd(line, j) : -1;
  out.lastCode = "/";
  return end > 0 ? end : j;
}

function scanCode(c: string, line: string, j: number, st: ScanState, out: LineScan): void {
  out.lastCode = c;
  if (c === '"' || c === "`" || (c === "'" && !(st.lifetimes && LIFETIME_RE.test(line.slice(j))))) {
    st.quote = c;
  } else if (OPENERS.has(c)) {
    st.depth++;
  } else if (CLOSERS.has(c)) {
    st.depth = Math.max(0, st.depth - 1);
    if (st.depth === 0 && c === "}") out.closedTop = true;
  } else if (c === ";" && st.depth === 0) {
    out.semicolonTop = true;
  }
}

// Consumes the token at `j`; returns the index of its last character, or -1 at a line comment.
function scanStep(line: string, j: number, st: ScanState, out: LineScan): number {
  const c = line[j]!;
  if (st.inBlockComment) {
    if (c === "*" && line[j + 1] === "/") {
      st.inBlockComment = false;
      return j + 1;
    }
    return j;
  }
  if (st.quote !== null) {
    out.lastCode = c;
    if (c === "\\") return j + 1;
    if (c === st.quote) st.quote = null;
    return j;
  }
  if (c === "/") return scanSlash(line, j, st, out);
  if (c.trim() !== "") scanCode(c, line, j, st, out);
  return j;
}

function scanLine(line: string, st: ScanState): LineScan {
  const out: LineScan = { closedTop: false, semicolonTop: false, lastCode: "" };
  for (let j = 0; j >= 0 && j < line.length; j++) {
    j = scanStep(line, j, st, out);
    if (j < 0) break;
  }
  // Only template literals span lines; an unterminated '…' / "…" is a tokenizer miss.
  if (st.quote !== null && st.quote !== "`") st.quote = null;
  return out;
}

function nextCodeLine(lines: string[], from: number): string | undefined {
  for (let k = from; k < lines.length; k++) {
    const t = lines[k]!.trim();
    if (t !== "" && !isCommentOnly(t)) return t;
  }
  return undefined;
}

function braceSpanEnd(lines: string[], start: number, lifetimes: boolean): number {
  const st: ScanState = { depth: 0, quote: null, inBlockComment: false, lifetimes };
  const last = Math.min(lines.length, start + MAX_SPAN_LINES) - 1;
  for (let i = start; i <= last; i++) {
    const s = scanLine(lines[i]!, st);
    if (st.depth > 0 || st.quote !== null || st.inBlockComment) continue;
    if (s.closedTop || s.semicolonTop) return i;
    if (s.lastCode === "" || CONTINUES_AFTER.has(s.lastCode) || lines[i]!.trimEnd().endsWith("=>")) continue;
    const next = nextCodeLine(lines, i + 1);
    if (next !== undefined && CONTINUES_BEFORE_RE.test(next)) continue;
    return i;
  }
  return last;
}

function indentOf(line: string): number {
  const ws = /^[ \t]*/.exec(line)![0];
  return ws.replace(/\t/g, "    ").length;
}

function indentSpanEnd(lines: string[], start: number): number {
  // A signature may wrap inside brackets: the header ends where the brackets balance.
  const st: ScanState = { depth: 0, quote: null, inBlockComment: false, lifetimes: false };
  const last = Math.min(lines.length, start + MAX_SPAN_LINES) - 1;
  let header = start;
  for (; header <= last; header++) {
    scanLine(lines[header]!.replace(/#.*$/, ""), st);
    if (st.depth === 0) break;
  }
  if (header > last) return last;
  const base = indentOf(lines[start]!);
  let end = header;
  for (let k = header + 1; k <= last; k++) {
    if (lines[k]!.trim() === "") continue;
    if (indentOf(lines[k]!) <= base) break;
    end = k;
  }
  return end;
}

/**
 * The lines of the symbol `label` declared at (or near) `hintLine` in `content`, or null
 * when the file's language has no span rule or the name is not in the file. `file` only
 * selects the language (by extension).
 */
export function locateSymbolSpan(content: string, file: string, label: string, hintLine: number): LineSpan | null {
  const lang = spanLanguage(file);
  const name = symbolName(label);
  if (lang === null || name === null || content.length === 0) return null;
  const lines = content.split(/\r?\n/);
  const start = findStartLine(lines, name, hintLine);
  if (start < 0) return null;
  const end = lang === "indent" ? indentSpanEnd(lines, start) : braceSpanEnd(lines, start, /\.rs$/i.test(file));
  return { start: start + 1, end: end + 1 };
}

/**
 * The text a symbol fingerprint hashes: the span's lines, trimmed, blank lines dropped —
 * so re-indenting or adding blank lines is not drift, while any token change is.
 */
export function spanText(content: string, span: LineSpan): string {
  return content
    .split(/\r?\n/)
    .slice(span.start - 1, span.end)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join("\n");
}
