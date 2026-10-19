// cli/args.ts — argv parsing helpers shared by the CLI command handlers.

import { fail } from "./io.ts";

// Read a --flag's value. Absent → fallback. Present but with no value (end of args, or the next
// token is itself a --flag) → hard fail, so a typo never silently swallows the next flag as a path.
export function optFlag(args: string[], name: string, fallback: string | undefined): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${name} requires a value`);
  return v;
}

/**
 * The positional words of `args`: every token that is neither a `--flag` nor the value that
 * follows one of `valueFlags` (the flags that take a value). Without the second rule
 * `memory search <dir> confiable --limit 6` searched for "confiable 6".
 */
export function positionals(args: string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** A `--flag N` that must be a positive integer (absent → fallback). */
export function positiveIntFlag(args: string[], name: string, fallback: number): number {
  const raw = optFlag(args, name, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer`);
  return n;
}

/** Returns true if the exact flag token appears anywhere in args. */
export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

// ---------------------------------------------------------------------------
// Batch stdin parsing — shared by `memory save|update|get --batch`.
// ---------------------------------------------------------------------------

// Parse a JSON array from stdin and map each element. When `rawStrings` is true the array is
// expected to hold bare strings (used by `get --batch`); otherwise each element must be an object
// and `map` shapes it. Throws (→ caller fails) on anything that isn't a non-empty array.
export function parseBatchInput<T>(
  stdin: string,
  map: (raw: Record<string, unknown>) => T,
  rawStrings = false,
): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    fail("--batch expects a JSON array on stdin");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) fail("--batch expects a non-empty JSON array on stdin");
  if (rawStrings) {
    return (parsed as unknown[]).map((el) => {
      if (typeof el !== "string") fail("--batch expects an array of id strings on stdin");
      return el as unknown as T;
    });
  }
  return (parsed as unknown[]).map((el) => {
    if (typeof el !== "object" || el === null || Array.isArray(el)) fail("--batch array elements must be objects");
    return map(el as Record<string, unknown>);
  });
}
