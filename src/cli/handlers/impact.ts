// cli/handlers/impact.ts — handler para `leina impact analyze [<dir>] <symbol> [--json] [--depth <n>]`.
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
import { usageError } from "../io.ts";
import { positiveIntFlag } from "../args.ts";
import { dirThen } from "../project-args.ts";

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
  const wantJson = source.includes("--json");
  // One positional = <symbol>; two = <dir> <symbol> (project-args.ts).
  const { root, values } = dirThen("impact analyze", source, ["<symbol>"]);
  const depth = source.includes("--depth") ? positiveIntFlag(source, "--depth", 1) : undefined;

  const store = await openFreshStore(root);
  const { seed, resolution, ...result } = analyzeSymbolImpact(store, values[0]!, depth);
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
  // The dispatcher only routes `impact analyze` here.
  if (sub !== "analyze") usageError(`unknown sub-command '${sub ?? ""}'`, "impact");
  await runImpactAnalyze(subRest);
}
