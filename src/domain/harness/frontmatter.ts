// domain/harness/frontmatter.ts — JSON frontmatter parser/serializer for
// harness rule and recipe markdown files. Deliberately NOT YAML: the metadata
// block between the `---` fences is a (possibly multiline) JSON object, which
// keeps the domain free of YAML parsing while staying diff-friendly:
//
//   ---
//   { "id": "harness/tests-pass", "phase": "verify", ... }
//   ---
//
//   # Markdown body…
//
// Tolerant to a UTF-8 BOM and CRLF line endings.
//
// Dependency rule: this file MUST import only from other domain/ modules.

export interface FrontmatterDocument {
  /** Parsed JSON value of the frontmatter block (untyped — validate.ts types it). */
  data: unknown;
  /** Markdown body after the closing fence, trimmed. */
  body: string;
}

export type FrontmatterParseResult =
  | { ok: true; value: FrontmatterDocument }
  | { ok: false; error: string };

const FENCE = "---";

/**
 * Parse a `---` / JSON / `---` frontmatter document. The opening fence must be
 * the first line; the closing fence is the next line that is exactly `---`.
 * A file without an opening fence parses as body-only with `data: undefined`.
 */
export function parseFrontmatter(text: string): FrontmatterParseResult {
  // Strip BOM, normalize CRLF → LF so fences match on any platform.
  const normalized = (text.startsWith("\uFEFF") ? text.slice(1) : text).replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");

  if ((lines[0] ?? "").trim() !== FENCE) {
    return { ok: true, value: { data: undefined, body: normalized.trim() } };
  }

  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === FENCE) {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    return { ok: false, error: "unterminated frontmatter: no closing --- fence" };
  }

  const raw = lines.slice(1, closing).join("\n").trim();
  const body = lines
    .slice(closing + 1)
    .join("\n")
    .trim();

  if (raw === "") return { ok: true, value: { data: undefined, body } };

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON frontmatter (${(err as Error).message})` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "frontmatter must be a JSON object" };
  }
  return { ok: true, value: { data, body } };
}

/** Serialize data + body back into the canonical fenced-JSON document. */
export function serializeFrontmatter(data: unknown, body: string): string {
  const json = JSON.stringify(data, null, 2);
  const trimmedBody = body.trim();
  return trimmedBody === ""
    ? `${FENCE}\n${json}\n${FENCE}\n`
    : `${FENCE}\n${json}\n${FENCE}\n\n${trimmedBody}\n`;
}
