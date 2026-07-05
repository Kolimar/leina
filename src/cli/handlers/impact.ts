// cli/handlers/impact.ts — handler para `leina impact analyze <symbol> [--json]`.
//
// Reutiliza openFreshStore + resolveSeed del path de query.
// Nunca lanza error al usuario: símbolo no encontrado → listas vacías, exit 0.

import { openFreshStore } from "../wiring.ts";
import { resolveSeed } from "../../application/graph/query.ts";
import { analyzeImpact, type ImpactResult } from "../../application/graph/impact.ts";
import type { GraphNode } from "../../domain/graph/model.ts";
import { fail } from "../io.ts";

// Convención: si hay dos args no-flag → args[0]=dir, args[1]=symbol
//             si hay un arg → dir=".", symbol=args[0]
function parseImpactArgs(args: string[]): { dir: string; symbolArg: string | undefined } {
  if (args.length >= 2) return { dir: args[0]!, symbolArg: args[1] };
  return { dir: ".", symbolArg: args[0] };
}

// Formato humano legible
function printHumanImpact(result: ImpactResult, seed: GraphNode | null, symbolArg: string): void {
  const { files, tests, services, configs } = result.impacted;
  const symLabel = seed ? `${seed.label} (${seed.sourceFile})` : `"${symbolArg}" (not found)`;
  console.log(`Impact analysis for ${symLabel}:`);
  console.log(`  files    (${files.length}): ${files.join(", ") || "(none)"}`);
  console.log(`  tests    (${tests.length}): ${tests.join(", ") || "(none)"}`);
  console.log(`  services (${services.length}): ${services.join(", ") || "(none)"}`);
  console.log(`  configs  (${configs.length}): ${configs.join(", ") || "(none)"}`);
}

async function runImpactAnalyze(source: string[]): Promise<void> {
  const args = source.filter((a) => !a.startsWith("--"));
  const wantJson = source.includes("--json");

  const { dir, symbolArg } = parseImpactArgs(args);
  if (!symbolArg) {
    fail("usage: leina impact analyze [<dir>] <symbol> [--json]");
  }

  const store = await openFreshStore(dir);
  const seed = resolveSeed(store, symbolArg);

  // Símbolo no encontrado → listas vacías, sin error
  const result = seed
    ? analyzeImpact(store, seed.id)
    : { impacted: { files: [], tests: [], services: [], configs: [] } };
  store.close();

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(result)  }\n`);
  } else {
    printHumanImpact(result, seed, symbolArg);
  }
}

export async function handleImpact(rest: string[]): Promise<void> {
  const [sub, ...subRest] = rest;
  if (sub !== "analyze" && sub !== undefined) {
    process.stderr.write(
      `Unknown impact sub-command: "${sub}"\n` +
        `Usage: leina impact analyze [<dir>] <symbol> [--json]\n`,
    );
    process.exit(1);
  }
  // `impact [analyze]` — análisis de impacto
  await runImpactAnalyze(sub === "analyze" ? subRest : rest);
}
