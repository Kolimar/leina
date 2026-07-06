// bench/precision/run.ts — recall of `impact analyze` against a verifiable oracle.
//
// The honest precision question for a dependency graph is NOT "does it match a compiler?"
// (for TypeScript, leina's edges ARE the compiler's — measuring that is circular) but:
//
//   1. RECALL — does impact analyze recover the dependents we can verify independently?
//      Oracle = the import-level dependents: every file whose source contains an `import`
//      of the symbol. This is automatable, auditable, and a strict LOWER BOUND on the true
//      dependent set (it misses type-only and transitive edges). leina must not miss these.
//
//   2. TRANSITIVE BONUS — how many dependents does leina surface BEYOND the import floor?
//      These are the indirect/transitive dependents a grep-for-imports flow never finds —
//      leina's actual value-add, and exactly the files Fase 2 showed a grep agent misses.
//
// No hand-labeling, no history checkout, no circular oracle. Every number is reproducible.
//
// Usage: node --experimental-strip-types bench/precision/run.ts [<repoDir>] <sym1,sym2,...> [--json]

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const target = resolve(positional.length > 1 ? positional[0]! : ".");
const symbols = (positional.length > 1 ? positional[1]! : positional[0] ?? "").split(",").filter(Boolean);
const emitJson = argv.includes("--json");
if (!symbols.length) {
  console.error("usage: node --experimental-strip-types bench/precision/run.ts [<repoDir>] <sym1,sym2,...> [--json]");
  process.exit(1);
}

function rel(abs: string): string {
  return abs.startsWith(target) ? abs.slice(target.length + 1) : abs;
}

// Oracle: files with an INTERNAL (relative) import of the symbol — a verifiable lower
// bound on real dependents. Restricting to `from './…'`/`from '../…'` is what makes the
// oracle honest: it drops name collisions with external modules (e.g. `resolve` from
// `node:path` is not a dependent of leina's own `resolve`). Multiline (`-U`) so named
// imports spread across lines still match.
function importDependents(symbol: string): Set<string> {
  const named = `import\\s+(?:type\\s+)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*['"]\\.`; // import [type] { … X … } from './…'
  const dflt = `import\\s+${symbol}\\s+from\\s*['"]\\.`; // import X from './…'
  const r = spawnSync("rg", ["-lU", "--type", "ts", "-e", named, "-e", dflt, target], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set((r.stdout ?? "").split("\n").filter(Boolean).map(rel));
}

// leina's answer: the dependent file set from `affected` (blast radius = who depends on
// the symbol). This is the dependents-only direction — the correct thing to compare an
// import-dependent oracle against (impact analyze is bidirectional and would over-credit).
function leinaDependents(symbol: string): Set<string> {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, "affected", target, symbol], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Each dependent line is "  <label>  [relation]  <file>:<loc>" — the label is a node
  // (a symbol for implements/calls, a file for file-level refs), so the actual FILE lives
  // in the trailing location column. Extract that, stripping the :Lnn / :? suffix.
  const files = new Set<string>();
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /\]\s+(\S+?):(?:L?\d+|\?)\s*$/.exec(line);
    if (m) files.add(rel(m[1]!));
  }
  return files;
}

interface Row { symbol: string; oracle: number; recovered: number; recall: number; transitiveBonus: number }
const rows: Row[] = [];

for (const symbol of symbols) {
  const oracle = importDependents(symbol);
  const pred = leinaDependents(symbol);
  const recovered = [...oracle].filter((f) => pred.has(f)).length;
  const recall = oracle.size > 0 ? recovered / oracle.size : NaN;
  const transitiveBonus = [...pred].filter((f) => !oracle.has(f)).length;
  rows.push({ symbol, oracle: oracle.size, recovered, recall, transitiveBonus });
}

const agg = {
  symbols: rows.length,
  oracleTotal: rows.reduce((s, r) => s + r.oracle, 0),
  recoveredTotal: rows.reduce((s, r) => s + r.recovered, 0),
};
const microRecall = agg.oracleTotal > 0 ? agg.recoveredTotal / agg.oracleTotal : NaN;

console.log(`leina impact-recall — ${target}\n`);
console.log(`| symbol | import-dependents (oracle) | recovered | recall | transitive bonus |`);
console.log(`|---|---:|---:|---:|---:|`);
for (const r of rows) {
  const rc = Number.isNaN(r.recall) ? "—" : `${(100 * r.recall).toFixed(0)}%`;
  console.log(`| ${r.symbol} | ${r.oracle} | ${r.recovered} | ${rc} | +${r.transitiveBonus} |`);
}
console.log(`\nmicro-averaged recall: ${(100 * microRecall).toFixed(1)}% (${agg.recoveredTotal}/${agg.oracleTotal} verifiable import-dependents recovered)`);
console.log(`transitive dependents surfaced beyond the import floor: ${rows.reduce((s, r) => s + r.transitiveBonus, 0)} (files a grep-for-imports flow never reaches)`);

if (emitJson) {
  const payload = {
    meta: { target, symbols, measuredAt: new Date().toISOString() },
    oracle: "files with a direct `import` of the symbol (verifiable lower bound on real dependents)",
    microRecall,
    rows,
  };
  console.log(`\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``);
}
