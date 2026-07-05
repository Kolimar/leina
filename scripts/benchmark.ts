// scripts/benchmark.ts — reproducible measurement harness.
//
// Measures, against ANY checkout (default: this repo), the numbers a skeptical adopter
// asks for: cold build, warm rebuild (extraction cache), read-path latency (affected /
// query / stats) and graph size. Prints a markdown table ready for docs/benchmarks.
//
// Method notes:
//   - Each timed run is a FRESH CLI process (spawnSync) — startup cost is part of the
//     honest number, exactly what an agent pays per command.
//   - Cold build wipes .leina/{graph.db,extract-cache.db} first; warm rebuild runs the
//     same build again untouched.
//   - Read commands run N times (default 5); we report the median.
//
// Usage: node --experimental-strip-types scripts/benchmark.ts [<repoDir>] [--symbol <name>] [--runs N]

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const args = process.argv.slice(2);
const target = resolve(args[0] && !args[0].startsWith("--") ? args[0] : ".");
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1]! : dflt;
};
const symbol = flag("--symbol", "main");
const runs = Number(flag("--runs", "5"));

function cli(cmdArgs: string[]): { ms: number; out: string; code: number } {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...cmdArgs], {
    encoding: "utf8",
  });
  return { ms: performance.now() - t0, out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status ?? 1 };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function timed(label: string, cmdArgs: string[], n: number): { label: string; ms: number } {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = cli(cmdArgs);
    if (r.code !== 0) {
      console.error(`  ! ${label} failed: ${r.out.slice(0, 300)}`);
      return { label, ms: NaN };
    }
    samples.push(r.ms);
  }
  return { label, ms: Math.round(median(samples)) };
}

console.log(`leina benchmark — ${target} (runs=${runs}, symbol="${symbol}")\n`);

// Cold build: no graph, no extraction cache.
rmSync(join(target, ".leina", "graph.db"), { force: true });
rmSync(join(target, ".leina", "graph.db-wal"), { force: true });
rmSync(join(target, ".leina", "extract-cache.db"), { force: true });
const cold = cli(["build", target]);
if (cold.code !== 0) {
  console.error(cold.out);
  process.exit(1);
}
const sizeLine = /Done\. (\d+) nodes, (\d+) edges from (\d+)/.exec(cold.out);

// Warm rebuild: extraction cache populated, forced full pipeline.
const warm = cli(["refresh", target]);

const rows = [
  { label: "build (cold, no cache)", ms: Math.round(cold.ms) },
  { label: "rebuild (warm extract cache)", ms: Math.round(warm.ms) },
  timed("stats", ["stats", target], runs),
  timed(`affected "${symbol}"`, ["affected", target, symbol], runs),
  timed('query (natural language)', ["query", target, "where is the main entry point"], runs),
];

console.log(`| measurement | median ms |`);
console.log(`|---|---:|`);
for (const r of rows) console.log(`| ${r.label} | ${Number.isNaN(r.ms) ? "—" : r.ms} |`);
if (sizeLine) {
  console.log(`\ngraph: ${sizeLine[1]} nodes, ${sizeLine[2]} edges, ${sizeLine[3]} files`);
}
console.log(`node ${process.versions.node} · ${process.platform}-${process.arch}`);
