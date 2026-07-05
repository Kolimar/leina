// application/graph/extractor-registry.ts — Política de orden canónico del registry.
//
// Define el orden en que los extractores deben aplicarse y una función `orderRegistry`
// que reordena un array de GraphExtractor[] según ese orden canónico.
//
// RESTRICCIÓN ARCH-RULE-3: Este módulo SOLO importa tipos de src/domain/.
// Los adaptadores concretos (infra) se inyectan desde src/cli/wiring.ts.

import type { GraphExtractor } from "../../domain/graph/extractor.ts";

// Orden canónico: tsmorph → scip-go → scip-rust → scip-python → sidecar-csharp → sidecar-java → treesitter (fallback)
// scip-<lang> precede a los sidecars/treesitter del MISMO lenguaje (más preciso primero);
// como cada extractor filtra por extensión, su posición relativa a sidecars de OTRO
// lenguaje es irrelevante en la práctica — solo importa que quede antes de treesitter.
export const EXTRACTOR_ORDER = ["tsmorph", "scip-go", "scip-rust", "scip-python", "sidecar-csharp", "sidecar-java", "treesitter"] as const;
export type ExtractorId = (typeof EXTRACTOR_ORDER)[number];

/**
 * Reordena `extractors` según el orden canónico `EXTRACTOR_ORDER`.
 * Extractores con ids no reconocidos se colocan al final (después del fallback).
 */
export function orderRegistry(extractors: GraphExtractor[]): GraphExtractor[] {
  return [...extractors].sort((a, b) => {
    const ia = EXTRACTOR_ORDER.indexOf(a.id as ExtractorId);
    const ib = EXTRACTOR_ORDER.indexOf(b.id as ExtractorId);
    const ai = ia === -1 ? EXTRACTOR_ORDER.length : ia;
    const bi = ib === -1 ? EXTRACTOR_ORDER.length : ib;
    return ai - bi;
  });
}
