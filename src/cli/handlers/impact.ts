// cli/handlers/impact.ts — handler para `leina impact analyze <symbol> [--json]`.
//
// Reutiliza openFreshStore + analyzeSymbolImpact (la misma resolución de selectores que
// affected/path; el mismo use-case que el tool MCP `impact_analyze`).
// Símbolo sin coincidencia exacta → mensaje "did you mean" en stderr + exit 1 (con --json,
// además el shape vacío con `note` y `suggestions` en stdout). Símbolo ambiguo → nota en
// stderr y se usa la mejor coincidencia.

import { openFreshStore } from "../wiring.ts";
import { analyzeSymbolImpact, type ImpactResult } from "../../application/graph/impact.ts";
import { ambiguityNote, noMatchMessage, resolutionInfo } from "../../application/graph/seed.ts";
import type { GraphNode } from "../../domain/graph/model.ts";
import { fail } from "../io.ts";

// Convención: si hay dos args no-flag → args[0]=dir, args[1]=symbol
//             si hay un arg → dir=".", symbol=args[0]
function parseImpactArgs(args: string[]): { dir: string; symbolArg: string | undefined } {
  if (args.length >= 2) return { dir: args[0]!, symbolArg: args[1] };
  return { dir: ".", symbolArg: args[0] };
}

// Formato humano legible
function printHumanImpact(result: ImpactResult, seed: GraphNode): void {
  const { files, tests, services, configs } = result.impacted;
  console.log(`Impact analysis for ${seed.label} (${seed.sourceFile}):`);
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
  const { seed, resolution, ...result } = analyzeSymbolImpact(store, symbolArg);
  store.close();

  if (!seed) {
    // exitCode, not process.exit: let the JSON on stdout drain (async pipes on macOS).
    if (wantJson) process.stdout.write(`${JSON.stringify({ ...result, seed: null, ...resolutionInfo(resolution) })}\n`);
    console.error(noMatchMessage(resolution));
    process.exitCode = 1;
    return;
  }
  const note = ambiguityNote(resolution);
  if (note) console.error(note);
  if (wantJson) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    printHumanImpact(result, seed);
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
