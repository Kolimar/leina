// frontmatter.ts — the ONE YAML-ish frontmatter parser for bundled asset markdown.
//
// Both install transformers (devin-skills.ts, port.ts) consume SKILL.md / agent .md
// frontmatter; they used to carry diverging private copies of this logic. Minimal by
// design: `key: value` pairs plus folded scalars (`key: >` + indented continuation) —
// exactly what the bundled assets use. Not a general YAML parser.

/**
 * Remove HTML-ish `<...>` tags, repeating until the string stops changing. A
 * single regex pass is unsafe (e.g. `<scr<b>ipt>` collapses to `<script>` after
 * one removal); looping until stable guarantees no tag survives.
 */
export function stripTags(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replaceAll(/<[^>]+>/g, "");
  } while (s !== prev);
  return s;
}

/** Does a line look like a `key: value` frontmatter entry (vs a folded continuation)? */
function isFrontmatterKeyLine(line: string): boolean {
  const sep = line.indexOf(":");
  return sep > 0 && /^[\w-]+$/.test(line.slice(0, sep).trim());
}

/** Split a `key: value` line. `folded` means the value continues on following lines (`>`). */
function parseFrontmatterKeyLine(line: string): { key: string; value: string; folded: boolean } {
  const sep = line.indexOf(":");
  const key = line.slice(0, sep).trim();
  let val = line.slice(sep + 1).trim();
  if (val.startsWith(">")) return { key, value: "", folded: true }; // collect from next line
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  return { key, value: val, folded: false };
}

interface FrontmatterState {
  meta: Record<string, string>;
  currentKey: string | null;
  foldedValue: string;
}

/** Fold one non-empty frontmatter line into the running parse state. */
function consumeFrontmatterLine(state: FrontmatterState, line: string, trimmed: string): void {
  if (isFrontmatterKeyLine(line)) {
    if (state.currentKey) state.meta[state.currentKey] = state.foldedValue.trim();
    const { key, value, folded } = parseFrontmatterKeyLine(line);
    state.foldedValue = "";
    if (folded) {
      state.currentKey = key;
    } else {
      state.meta[key] = value;
      state.currentKey = null;
    }
  } else if (state.currentKey) {
    state.foldedValue += (state.foldedValue ? " " : "") + trimmed;
  }
}

/**
 * Parse YAML-ish frontmatter. Returns the flat string map and the body after the
 * closing `---`. A file without a frontmatter block parses as meta {} + full body.
 * Folded scalars (`description: >`) are joined with single spaces.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const state: FrontmatterState = { meta: {}, currentKey: null, foldedValue: "" };
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) consumeFrontmatterLine(state, line, trimmed);
  }
  if (state.currentKey && state.foldedValue) state.meta[state.currentKey] = state.foldedValue.trim();
  return { meta: state.meta, body: m[2] ?? "" };
}

/** Trim a description to a clean one-line `description:` value (≤200 chars). */
export function shortDescription(raw: string, fallback: string): string {
  const cleaned = stripTags(raw.replaceAll(String.raw`\n`, " "))
    .replaceAll(/\s+/g, " ")
    .trim();
  const text = cleaned || fallback;
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
