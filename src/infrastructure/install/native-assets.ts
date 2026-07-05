// native-assets.ts — maintainer-configurable reference guard for committed text.
//
// The scanner mechanism lives in the repo; the LIST of forbidden strings deliberately does
// NOT. A hardcoded list would itself document exactly the terms it exists to keep out of
// the tree, so the needles load from maintainer-local configuration instead:
//   - $LEINA_FORBIDDEN_REFS      comma-separated needles (useful for CI secrets), and/or
//   - ~/.leina/forbidden-refs.json   a JSON array of strings.
// When neither is configured the scan is skipped — contributors without the list simply
// don't run this policy; publishing happens from a machine that has it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { leinaHome } from "./share-paths.ts";

export interface ForbiddenReference {
  needle: string;
  line: number;
  column: number;
}

/** Maintainer-local forbidden strings (lowercased, deduped, longest first). */
export function loadForbiddenNeedles(env: NodeJS.ProcessEnv = process.env): string[] {
  const needles = new Set<string>();
  for (const n of (env.LEINA_FORBIDDEN_REFS ?? "").split(",")) {
    const t = n.trim().toLowerCase();
    if (t.length > 0) needles.add(t);
  }
  for (const n of readLocalNeedleFile(join(leinaHome(), "forbidden-refs.json"))) {
    needles.add(n);
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

function readLocalNeedleFile(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
      .map((n) => n.trim().toLowerCase());
  } catch {
    return []; // malformed local list — treat as absent
  }
}

export function findForbiddenReferences(content: string, needles: string[]): ForbiddenReference[] {
  const lower = content.toLowerCase();
  const found: ForbiddenReference[] = [];
  const seenRanges: { start: number; end: number }[] = [];
  const ordered = [...needles].sort((a, b) => b.length - a.length);

  for (const needle of ordered) {
    let offset = lower.indexOf(needle);
    while (offset >= 0) {
      const end = offset + needle.length;
      const overlaps = seenRanges.some((range) => offset < range.end && end > range.start);
      if (!overlaps) {
        const prefix = content.slice(0, offset);
        const lines = prefix.split("\n");
        found.push({
          needle,
          line: lines.length,
          column: lines.at(-1)!.length + 1,
        });
        seenRanges.push({ start: offset, end });
      }
      offset = lower.indexOf(needle, offset + 1);
    }
  }

  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}
