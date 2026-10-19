// application/harness/gates/diff-content.ts — native, shell-free check over
// ADDED diff lines. Replaces POSIX `git diff | grep` pipelines so gates work
// on Windows without bash.
//
// SECURITY: this gate's output flows into verify-report.json and from there
// into the model's context (Stop-hook feedback). When the forbidden pattern
// is a SECRET detector (harness/no-secrets), echoing the offending line would
// re-emit the very secret it caught — so failures report only the location
// (file:line) plus a 3-char masked prefix of the match, never the line body.

import { type DiffContentGate } from "../../../domain/harness/model.ts";
import { matchLinesBounded } from "./engine.ts";
import { type GateContext, type GateOutcome } from "./types.ts";

interface AddedLine {
  file: string;
  /** 1-based line number in the post-image of the diff. */
  line: number;
  text: string;
}

// `@@ -a[,b] +c[,d] @@` → capture c (post-image start line). Uses a flat
// `[\d,]+` for the old-range rather than nested `\d+(?:,\d+)?` so the pattern
// stays linear (no nested quantifier — safe-regex clean).
const HUNK_RE = /^@@ -[\d,]+ \+(\d+)/;

/**
 * Walk a unified diff and collect every added line with its target file and
 * post-image line number. Tolerates the synthetic new-file entries appended
 * by HarnessGit.diffUnified for untracked files (same +++/@@ shape) and the
 * `\`-prefixed marker lines diff parsers ignore.
 */
function collectAddedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      file = target.startsWith("b/") ? target.slice(2) : target;
      continue;
    }
    const hunk = HUNK_RE.exec(raw);
    if (hunk !== null) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ file, line, text: raw.slice(1) });
      line += 1;
      continue;
    }
    if (raw.startsWith(" ")) line += 1; // context line (unified>0)
  }
  return out;
}

export async function runDiffContentGate(gate: DiffContentGate, ctx: GateContext): Promise<GateOutcome> {
  const flags = gate.ignoreCase ? "i" : "";
  // Validate the pattern up front (cheap vm compile against zero lines) so an
  // invalid regex reports as an error even outside a git repository.
  const probe = matchLinesBounded(gate.forbidAdded, flags, []);
  if ("error" in probe) {
    return { status: "error", detail: `invalid forbidAdded regex: ${probe.error}` };
  }

  const paths = gate.paths && gate.paths.length > 0 ? gate.paths : undefined;
  const base = gate.base ?? ctx.baseRef;
  const baseOpts = {
    ...(base !== undefined ? { base } : {}),
    ...(paths !== undefined ? { paths } : {}),
  };

  let stdout = await ctx.ports.git.diffUnified(ctx.repoRoot, baseOpts);
  // No resolvable HEAD/base (fresh repo): diff the index against the empty tree.
  stdout ??= await ctx.ports.git.diffUnified(ctx.repoRoot, {
    cached: true,
    ...(paths !== undefined ? { paths } : {}),
  });
  if (stdout === null) {
    return { status: "skip", detail: "not a git repository — diff-content gates need git" };
  }

  const added = collectAddedLines(stdout);
  // Rule-supplied regex runs inside a vm hard timeout — a catastrophic
  // pattern (ReDoS) blocks the event loop synchronously, so the engine's
  // cooperative withTimeout wrapper could never interrupt it. Bounded by the
  // gate's own timeout, capped at the helper's 5s default.
  const evaluated = matchLinesBounded(
    gate.forbidAdded,
    flags,
    added.map((a) => a.text),
    Math.min(gate.timeoutMs ?? ctx.defaultTimeoutMs, 5000),
  );
  if ("error" in evaluated) {
    return { status: "error", detail: `forbidAdded regex evaluation failed: ${evaluated.error}` };
  }

  if (evaluated.matches.length > 0) {
    // Location + masked prefix ONLY — never the matched line (see header).
    const listed = evaluated.matches.slice(0, 20).map((m) => {
      const at = added[m.index]!;
      return `${at.file}:${at.line}: ${m.masked}`;
    });
    return {
      status: "fail",
      detail: `${evaluated.matches.length} added line(s) match forbidden /${gate.forbidAdded}/`,
      output: listed.join("\n"),
    };
  }
  return { status: "pass", detail: `no added line matches /${gate.forbidAdded}/` };
}
