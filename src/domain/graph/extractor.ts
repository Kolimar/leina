// domain/graph/extractor.ts — Puerto GraphExtractor (interfaces de dominio puras).
//
// Define el contrato que todos los adaptadores de extracción deben cumplir.
// Este módulo es PURO: cero imports de application/, infrastructure/ o cli/.
//
// NOTA DE DESVIACIÓN (override D1 del orchestrador — aprobado antes del apply):
// GraphExtractionResult incluye campos opcionales `rawCalls?` e `imports?`.
// Estos campos son datos INTERMEDIOS que el TreesitterExtractor rellena SIN resolver;
// tsmorph y sidecars los dejan `undefined`. buildGraph acumula el combined set y llama
// resolveSymbols() UNA SOLA VEZ de forma GLOBAL, preservando edges cross-extractor/cross-file
// byte-idénticos al pipeline previo (REQ-ER-4). Esto DESVÍA INTENCIONALMENTE de REQ-EP-3
// ("rawCalls/imports internos al TreesitterExtractor") para garantizar la no-regresión.

import type { GraphEdge, GraphNode, ImportBinding, RawCall } from "./model.ts";

// ---------------------------------------------------------------------------
// Resultado de la extracción — shape versionado del contrato externo.
// ---------------------------------------------------------------------------

export interface GraphExtractionResult {
  /** Versión del esquema — siempre 1 en esta etapa. */
  schemaVersion: 1;
  /** Identificador del adaptador que produjo este resultado. */
  extractor: { id: string; version: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Datos intermedios de resolución de símbolos (SOLO TreesitterExtractor los rellena).
   * DESVIACIÓN INTENCIONAL de REQ-EP-3: estos campos se exponen para que buildGraph
   * pueda ejecutar resolveSymbols() globalmente sobre el combined set de todos los
   * extractores y preservar edges cross-extractor/cross-file (REQ-ER-4 > REQ-EP-3).
   */
  rawCalls?: RawCall[];
  imports?: ImportBinding[];
  /** Mensajes informativos (advisory); p.ej. "ts-morph failed → tree-sitter". */
  diagnostics: string[];
  /** Duración de la extracción en milisegundos. */
  durationMs: number;
  /** Errores no fatales — si está vacío, el extractor manejó sus archivos candidatos. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Resultado de verificación del adaptador (solo sidecars lo implementan).
// ---------------------------------------------------------------------------

export interface VerificationCheck {
  status: "ok" | "fail" | "skip";
  message?: string;
  /** Presente en ok/fail; ausente en skip. */
  result?: GraphExtractionResult;
  expected?: { nodes: number; edges: number };
  actual?: { nodes: number; edges: number };
}

// ---------------------------------------------------------------------------
// Puerto GraphExtractor — firma única para todos los adaptadores.
// ---------------------------------------------------------------------------

export interface GraphExtractor {
  /** Identificador canónico del adaptador: "tsmorph" | "sidecar-csharp" | "sidecar-java" | "treesitter". */
  readonly id: string;
  /** Versión semántica del adaptador (e.g. "1.4.0-beta"). */
  readonly version: string;
  /**
   * Indica si este adaptador puede procesar el archivo dado.
   * buildGraph usa esto para asignar archivos al adaptador correcto.
   */
  supports(filePath: string): boolean;
  /**
   * Verificación opcional de la disponibilidad del adaptador.
   * Solo los sidecars implementan este método.
   * Nunca debe lanzar — devuelve {status:"skip"} cuando la herramienta no está instalada.
   */
  verify?(): Promise<VerificationCheck>;
  /**
   * Extrae nodos y edges del conjunto de archivos dado bajo `root`.
   * El resultado debe incluir schemaVersion=1, diagnostics y durationMs siempre.
   */
  extract(root: string, files: string[]): Promise<GraphExtractionResult>;
}
