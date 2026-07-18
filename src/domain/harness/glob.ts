// domain/harness/glob.ts — dependency-free glob matcher for repo-relative
// paths (posix separators). Supports `**` (globstar), `*`, `?` and `{a,b}`
// brace alternation — the subset the harness rules and contracts use.
//
// Semantics follow picomatch (which the original harness-framework used):
//   - patterns and files are anchored to the repo root (full-path match);
//   - `*` / `?` never cross a `/`;
//   - a segment that is exactly `**` matches zero or more path segments
//     (so `docs/**` matches `docs` itself and everything below it);
//   - `**` inside a segment (e.g. `a**b`) degrades to `*`;
//   - braces may span separators (`{README.md,docs/**}`) and nest;
//   - with `dot: false` (default) `*`, `?` and `**` do not match names that
//     start with `.` unless the pattern segment itself starts with a literal
//     dot. `matchesAny`/`anyFileMatches` pass `dot: true`, mirroring the
//     origin's picomatch usage: scope enforcement must not be escapable via
//     dotfiles.
//   - a leading `./` on the pattern is ignored.
//
// Character classes (`[abc]`) are NOT supported: `[` is a literal.
//
// Dependency rule: this file MUST import only from other domain/ modules.

export interface GlobOptions {
  /** Allow `*`/`?`/`**` to match names starting with a dot. Default false. */
  dot?: boolean;
}

// ---------------------------------------------------------------------------
// Brace expansion — `{a,b}` alternation, nesting allowed, may span `/`.
// ---------------------------------------------------------------------------

/** Expand the FIRST top-level brace group; recurse until none remain. */
export function expandBraces(pattern: string): string[] {
  const open = findOpenBrace(pattern);
  if (open === -1) return [pattern];

  let depth = 0;
  const alternatives: string[] = [];
  let start = open + 1;
  for (let i = open + 1; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) {
        alternatives.push(pattern.slice(start, i));
        const prefix = pattern.slice(0, open);
        const suffix = pattern.slice(i + 1);
        return alternatives.flatMap((alt) => expandBraces(prefix + alt + suffix));
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      alternatives.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  // Unbalanced `{` — treat it as a literal.
  return [pattern];
}

/** Index of the first `{` that has a matching `}` and a top-level comma; -1 if none. */
function findOpenBrace(pattern: string): number {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "{") continue;
    let depth = 0;
    for (let j = i + 1; j < pattern.length; j++) {
      const ch = pattern[j]!;
      if (ch === "{") depth++;
      else if (ch === "}") {
        if (depth === 0) return i;
        depth--;
      }
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Segment matching — one path segment against one non-globstar pattern segment.
// ---------------------------------------------------------------------------

const REGEX_SPECIALS = new Set(["\\", "^", "$", ".", "|", "+", "(", ")", "[", "]", "{", "}"]);

function segmentToRegExp(segment: string, dot: boolean): RegExp {
  let source = "^";
  // Dot rule: unless the pattern segment itself starts with a literal dot,
  // a leading wildcard must not match a name starting with ".".
  if (!dot && !segment.startsWith(".")) source += "(?!\\.)";
  for (const ch of segment) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (REGEX_SPECIALS.has(ch)) source += `\\${ch}`;
    else source += ch;
  }
  // eslint-disable-next-line security/detect-non-literal-regexp -- `source` is built above char-by-char with all regex specials escaped; only `[^/]*`/`[^/]` metacharacters are ever emitted
  return new RegExp(`${source}$`);
}

// ---------------------------------------------------------------------------
// Full-path matching — segment-wise with globstar backtracking.
// ---------------------------------------------------------------------------

function matchSegments(
  patSegs: readonly string[],
  pathSegs: readonly string[],
  pi: number,
  fi: number,
  dot: boolean,
  memo: Map<number, boolean>,
): boolean {
  const key = pi * (pathSegs.length + 1) + fi;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let result: boolean;
  if (pi === patSegs.length) {
    result = fi === pathSegs.length;
  } else if (patSegs[pi] === "**") {
    // Zero segments…
    result = matchSegments(patSegs, pathSegs, pi + 1, fi, dot, memo);
    // …or consume one segment (subject to the dot rule) and stay on `**`.
    if (!result && fi < pathSegs.length && (dot || !pathSegs[fi]!.startsWith("."))) {
      result = matchSegments(patSegs, pathSegs, pi, fi + 1, dot, memo);
    }
  } else if (fi === pathSegs.length) {
    result = false;
  } else {
    // `**` inside a segment degrades to `*` (picomatch behavior).
    const seg = patSegs[pi]!.replaceAll("**", "*");
    result =
      segmentToRegExp(seg, dot).test(pathSegs[fi]!) &&
      matchSegments(patSegs, pathSegs, pi + 1, fi + 1, dot, memo);
  }

  memo.set(key, result);
  return result;
}

function normalizePath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** True when `file` (repo-relative) matches `pattern` under the given options. */
export function isGlobMatch(file: string, pattern: string, options: GlobOptions = {}): boolean {
  const dot = options.dot ?? false;
  const path = normalizePath(file);
  const pathSegs = path.split("/").filter((s) => s !== "");
  for (const expanded of expandBraces(normalizePath(pattern))) {
    const patSegs = expanded.split("/").filter((s) => s !== "");
    if (matchSegments(patSegs, pathSegs, 0, 0, dot, new Map())) return true;
  }
  return false;
}

/** Does the pattern contain any glob syntax at all? */
export function hasGlobMagic(pattern: string): boolean {
  return /[*?{]/.test(pattern);
}

// ---------------------------------------------------------------------------
// The two entry points the engine uses — dot-matching enabled, like the
// origin's picomatch calls: dotfiles cannot escape scope enforcement.
// ---------------------------------------------------------------------------

/** True when `file` (repo-relative, posix separators) matches at least one glob. */
export function matchesAny(file: string, globs: string[]): boolean {
  if (globs.length === 0) return false;
  return globs.some((g) => isGlobMatch(file, g, { dot: true }));
}

/** True when at least one of `files` matches at least one glob. */
export function anyFileMatches(files: string[], globs: string[]): boolean {
  return files.some((f) => matchesAny(f, globs));
}
