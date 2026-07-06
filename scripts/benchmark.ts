// scripts/benchmark.ts — reproducible measurement harness.
//
// Measures, against ANY checkout (default: this repo), the numbers a skeptical adopter
// asks for: cold build, warm rebuild (extraction cache), per-stage build breakdown,
// read-path latency (stats / affected / query / impact / audit / memory / context) and
// graph size. Prints a markdown table ready for docs/benchmarks, and — with --json —
// a machine-readable block (metadata + every sample) so results can be re-plotted.
//
// Method notes:
//   - Each timed run is a FRESH CLI process (spawnSync) — startup cost is part of the
//     honest number, exactly what an agent pays per command.
//   - Cold build wipes .leina/{graph.db,extract-cache.db} first; warm rebuild runs the
//     same build again untouched.
//   - Read commands run one discarded WARM-UP (pays the one-per-session cold page-cache
//     cost of first reading graph.db) then N timed runs; we report median (p50) and p95
//     of steady-state latency — what an agent actually pays per command mid-session.
//
// Usage: node --experimental-strip-types scripts/benchmark.ts [<repoDir>] [--symbol <name>] [--runs N] [--json]

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, cpus, platform } from "node:os";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const args = process.argv.slice(2);
const target = resolve(args[0] && !args[0].startsWith("--") ? args[0] : ".");
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1]! : dflt;
};
const hasFlag = (name: string): boolean => args.includes(name);
const symbol = flag("--symbol", "main");
const runs = Number(flag("--runs", "11"));
const emitJson = hasFlag("--json");

function cli(cmdArgs: string[], input?: string): { ms: number; out: string; code: number } {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...cmdArgs], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ms: performance.now() - t0, out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status ?? 1 };
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

interface Sample { label: string; p50: number; p95: number; samples: number[] }

function timed(label: string, cmdArgs: string[], n: number, input?: string): Sample {
  const samples: number[] = [];
  cli(cmdArgs, input); // discarded warm-up: absorbs the one-per-session cold page-cache cost
  for (let i = 0; i < n; i++) {
    const r = cli(cmdArgs, input);
    if (r.code !== 0) {
      console.error(`  ! ${label} failed: ${r.out.slice(0, 300)}`);
      return { label, p50: NaN, p95: NaN, samples: [] };
    }
    samples.push(r.ms);
  }
  return { label, p50: Math.round(percentile(samples, 50)), p95: Math.round(percentile(samples, 95)), samples };
}

// Parse the `build --profile` stage breakdown from stdout into structured stages.
function parseProfile(out: string): { totalMs: number; stages: { name: string; ms: number; files?: number }[] } | null {
  const total = /build profile \((\d+)ms total\)/.exec(out);
  if (!total) return null;
  const stages: { name: string; ms: number; files?: number }[] = [];
  const extractRe = /extract:(\S+)\s+(\d+)ms\s+\((\d+) files\)/g;
  for (let m; (m = extractRe.exec(out)); ) stages.push({ name: `extract:${m[1]}`, ms: Number(m[2]), files: Number(m[3]) });
  for (const name of ["list sources", "resolve", "dedup", "persist", "communities", "manifest"]) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- `name` iterates the hardcoded literal list above
    const m = new RegExp(`${name.replace(" ", "\\s+")}\\s+(\\d+)ms`).exec(out);
    if (m) stages.push({ name: name.replace(" ", "-"), ms: Number(m[1]) });
  }
  return { totalMs: Number(total[1]), stages };
}

console.log(`leina benchmark — ${target} (runs=${runs}, symbol="${symbol}")\n`);

// Cold build: no graph, no extraction cache. --profile gives us the per-stage breakdown.
rmSync(join(target, ".leina", "graph.db"), { force: true });
rmSync(join(target, ".leina", "graph.db-wal"), { force: true });
rmSync(join(target, ".leina", "extract-cache.db"), { force: true });
const cold = cli(["build", target, "--profile"]);
if (cold.code !== 0) {
  console.error(cold.out);
  process.exit(1);
}
const sizeLine = /Done\. (\d+) nodes, (\d+) edges from (\d+)/.exec(cold.out);
const profile = parseProfile(cold.out);

// Warm rebuild: extraction cache populated, forced full pipeline.
const warm = cli(["refresh", target]);

const buildRows: Sample[] = [
  { label: "build (cold, no cache)", p50: Math.round(cold.ms), p95: Math.round(cold.ms), samples: [cold.ms] },
  { label: "rebuild (warm extract cache)", p50: Math.round(warm.ms), p95: Math.round(warm.ms), samples: [warm.ms] },
];

// Read path — what an agent actually pays mid-session. Each is a fresh process.
const readRows: Sample[] = [
  timed("stats", ["stats", target], runs),
  timed(`affected "${symbol}"`, ["affected", target, symbol], runs),
  timed("query (natural language)", ["query", target, "where is the main entry point"], runs),
  timed(`impact analyze "${symbol}"`, ["impact", "analyze", target, symbol, "--json"], runs),
  timed("audit (source→sink)", ["audit", target, "--format", "json"], runs),
  timed("memory search", ["memory", "search", target, "graph"], runs),
  timed("context build (session hook)", ["agent-hook", "SessionStart"], runs, "{}"),
];

const fmt = (n: number): string => (Number.isNaN(n) ? "—" : String(n));
console.log(`| measurement | p50 ms | p95 ms |`);
console.log(`|---|---:|---:|`);
for (const r of [...buildRows, ...readRows]) console.log(`| ${r.label} | ${fmt(r.p50)} | ${fmt(r.p95)} |`);

if (profile) {
  console.log(`\nbuild breakdown (cold, ${profile.totalMs}ms total):`);
  console.log(`| stage | ms | files |`);
  console.log(`|---|---:|---:|`);
  for (const s of profile.stages) console.log(`| ${s.name} | ${s.ms} | ${s.files ?? ""} |`);
}

if (sizeLine) {
  console.log(`\ngraph: ${sizeLine[1]} nodes, ${sizeLine[2]} edges, ${sizeLine[3]} files`);
}
const machine = `node ${process.versions.node} · ${platform()}-${arch()} · ${cpus()[0]?.model?.trim() ?? "unknown cpu"}`;
console.log(machine);

if (emitJson) {
  const payload = {
    meta: {
      target,
      runs,
      symbol,
      node: process.versions.node,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model?.trim() ?? "unknown",
      cores: cpus().length,
      measuredAt: new Date().toISOString(),
    },
    graph: sizeLine ? { nodes: Number(sizeLine[1]), edges: Number(sizeLine[2]), files: Number(sizeLine[3]) } : null,
    build: buildRows.map((r) => ({ label: r.label, p50: r.p50 })),
    profile,
    read: readRows.map((r) => ({ label: r.label, p50: r.p50, p95: r.p95 })),
  };
  console.log(`\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``);
}
