// bench/tokens.ts — token-cost harness: what an agent pays to answer a structural
// question ("what is the blast radius of symbol X?") WITH leina vs WITHOUT it.
//
// Three baselines, all deterministic, no LLM in the loop:
//   1. whole-repo dump   — every source file in context (theoretical upper bound: the
//                          only way to be *sure* you found all dependents without a graph).
//   2. hand-picked       — the file set a reasonable dev greps up: every file that
//                          textually mentions the symbol (one grep hop, whole files).
//   3. grep-flow (lower  — the MINIMUM a grep agent must READ to reproduce leina's
//      bound)              verified answer: the files leina marks impacted. A real agent
//                          reads more (dead ends, re-reads); this floor is unassailable.
// vs.
//   leina                — tokens of `impact analyze <symbol> --json`. One command.
//
// Tokenizer: prefers gpt-tokenizer (cl100k, exact) if installed as a devDependency;
// otherwise falls back to a calibrated chars/3.6 estimate for source code. The SAVINGS
// RATIO is near-identical either way — only the absolute counts move — because every
// baseline is counted with the same estimator.
//
// Usage: node --experimental-strip-types bench/tokens.ts [<repoDir>] <symbol> [--json]

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const target = resolve(positional.length > 1 ? positional[0]! : ".");
const symbol = positional.length > 1 ? positional[1]! : positional[0];
const emitJson = argv.includes("--json");
if (!symbol) {
  console.error("usage: node --experimental-strip-types bench/tokens.ts [<repoDir>] <symbol> [--json]");
  process.exit(1);
}

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py", ".java", ".cs", ".go", ".rs", ".rb", ".php", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp"]);

// --- tokenizer: exact if gpt-tokenizer is present, else calibrated estimate ------------
let encode: ((s: string) => number) | null = null;
let tokenizerName = "estimate (chars/3.6)";
try {
  const mod: any = await import("gpt-tokenizer");
  const enc = mod.encode ?? mod.default?.encode;
  if (enc) {
    encode = (s: string) => enc(s).length;
    tokenizerName = "gpt-tokenizer cl100k (exact)";
  }
} catch {
  /* not installed — fall back */
}
const tokens = (s: string): number => (encode ? encode(s) : Math.ceil(s.length / 3.6));

// --- source corpus (tracked code files) ------------------------------------------------
function sourceFiles(): string[] {
  const r = spawnSync("git", ["-C", target, "ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .filter((f) => CODE_EXT.has(f.slice(f.lastIndexOf("."))));
}

function readTokens(relPath: string): number {
  try {
    return tokens(readFileSync(join(target, relPath), "utf8"));
  } catch {
    return 0;
  }
}

// --- leina's answer --------------------------------------------------------------------
function leinaImpact(): { raw: string; files: string[] } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, "impact", "analyze", target, symbol!, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout ?? "").trim();
  const jsonStart = out.indexOf("{");
  const raw = jsonStart >= 0 ? out.slice(jsonStart) : "{}";
  let files: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    const imp = parsed.impacted ?? {};
    files = [...(imp.files ?? []), ...(imp.tests ?? []), ...(imp.services ?? []), ...(imp.configs ?? [])];
  } catch {
    /* leave empty */
  }
  return { raw, files: [...new Set(files)] };
}

// --- hand-picked: every file that textually mentions the symbol (one grep hop) ---------
function grepHits(): string[] {
  const r = spawnSync("rg", ["-l", "--fixed-strings", symbol!, target], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((abs) => abs.startsWith(target) ? abs.slice(target.length + 1) : abs)
    .filter((f) => CODE_EXT.has(f.slice(f.lastIndexOf("."))));
}

// --- measure ---------------------------------------------------------------------------
const src = sourceFiles();
const wholeRepoTokens = src.reduce((sum, f) => sum + readTokens(f), 0);

const impact = leinaImpact();
const leinaTokens = tokens(impact.raw);
const impactedTokens = impact.files.reduce((sum, f) => sum + readTokens(f), 0);

const hits = grepHits();
const handPickedTokens = hits.reduce((sum, f) => sum + readTokens(f), 0);

const pct = (base: number): string => (base > 0 ? `${(100 * (1 - leinaTokens / base)).toFixed(1)}%` : "—");
const x = (base: number): string => (leinaTokens > 0 ? `${Math.round(base / leinaTokens)}×` : "—");

const rows = [
  { baseline: "whole-repo dump (upper bound)", tokens: wholeRepoTokens, reads: src.length },
  { baseline: "hand-picked (grep the symbol, open every hit)", tokens: handPickedTokens, reads: hits.length },
  { baseline: "grep-flow floor (read every impacted file)", tokens: impactedTokens, reads: impact.files.length },
];

console.log(`leina token-cost — ${target}  ·  symbol "${symbol}"  ·  tokenizer: ${tokenizerName}\n`);
console.log(`leina answer (impact analyze --json): ${leinaTokens} tokens, 1 command, ${impact.files.length} files identified\n`);
console.log(`| baseline (same question, no graph) | tokens | files to read | leina saves | vs leina |`);
console.log(`|---|---:|---:|---:|---:|`);
for (const r of rows) console.log(`| ${r.baseline} | ${r.tokens.toLocaleString("en-US")} | ${r.reads} | ${pct(r.tokens)} | ${x(r.tokens)} |`);
console.log(`\ncorpus: ${src.length} source files, ${wholeRepoTokens.toLocaleString("en-US")} tokens total`);

if (emitJson) {
  const payload = {
    meta: { target, symbol, tokenizer: tokenizerName, measuredAt: new Date().toISOString() },
    leina: { tokens: leinaTokens, commands: 1, filesIdentified: impact.files.length },
    corpus: { sourceFiles: src.length, wholeRepoTokens },
    baselines: rows.map((r) => ({ ...r, savingsPct: pct(r.tokens), factor: x(r.tokens) })),
  };
  console.log(`\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``);
}
