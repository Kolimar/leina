// application/audit/findings.ts
// deriveFindings — maps AuditPath[] to Finding[] (1:1) using the source/sink catalog.
//
// Design D2: SRP — pack = serialization, findings = interpretation (testeable aislado).
// Design D3: category resolved via catalog.sinks (real) + SYNTHETIC_SINK_DEFINITIONS (synthetic).
// Design D6: clock injectable for deterministic fixtures (default: Date.now).

import { createHash } from "node:crypto";
import type { GraphNode } from "../../domain/graph/model.ts";
import type { Finding, FindingType, FindingSeverity } from "../../domain/findings/model.ts";
import type { AuditPath } from "./reachability.ts";
import { SYNTHETIC_SINK_DEFINITIONS } from "./reachability.ts";
import type { SourceSinkCatalogResult, SinkCategory } from "./source-sink-catalog.ts";

// ---------------------------------------------------------------------------
// Mapeo SinkCategory → FindingType + FindingSeverity (spec §Mapeo)
// ---------------------------------------------------------------------------

const CATEGORY_MAP: Record<SinkCategory, { type: FindingType; severity: FindingSeverity }> = {
  eval:              { type: "code-injection",    severity: "HIGH" },
  exec:              { type: "command-injection",  severity: "HIGH" },
  sql:               { type: "sql-injection",      severity: "HIGH" },
  ssrf:              { type: "ssrf",               severity: "HIGH" },
  "path-traversal":  { type: "path-traversal",     severity: "MEDIUM" },
  "template-render": { type: "template-injection", severity: "MEDIUM" },
  "weak-crypto":     { type: "weak-crypto",        severity: "MEDIUM" },
};

// ---------------------------------------------------------------------------
// Catálogo suggestedActions por SinkCategory (spec §Catálogo)
// ---------------------------------------------------------------------------

const SUGGESTED_ACTIONS: Record<SinkCategory, string[]> = {
  eval: [
    "Evitar pasar datos controlados por el usuario a eval() o new Function().",
    "Usar una librería de evaluación sandboxed o un parser de expresiones estático.",
    "Si se requiere ejecución dinámica, validar y aplicar allowlist estricta de expresiones.",
  ],
  exec: [
    "Nunca interpolar input del usuario en comandos de shell.",
    "Usar APIs parametrizadas (execFile con array de args, sin shell: true).",
    "Aplicar validación de input y allowlist de comandos permitidos.",
  ],
  sql: [
    "Usar consultas parametrizadas o prepared statements — nunca concatenación de strings.",
    "Aplicar query builders con parámetros vinculados (ORM/Knex/pg parameterized).",
    "Validar y sanitizar todos los valores de usuario antes de interactuar con la DB.",
  ],
  ssrf: [
    "Validar las URLs salientes contra un allowlist de hosts y esquemas permitidos.",
    "Bloquear peticiones a rangos IP internos/privados (RFC 1918, loopback, link-local).",
    "Usar un proxy de egreso con filtrado estricto de destinos.",
  ],
  "path-traversal": [
    "Normalizar la ruta con path.resolve() y verificar que comienza con el directorio base esperado.",
    "Rechazar paths con segmentos '..' antes de la resolución.",
    "Usar una allowlist de extensiones y directorios permitidos.",
  ],
  "template-render": [
    "Nunca pasar strings controlados por el usuario como fuente de template.",
    "Usar un motor de templates sandboxed con auto-escape habilitado.",
    "Separar las definiciones de template (estáticas) de los datos de renderizado (dinámicos).",
  ],
  "weak-crypto": [
    "Reemplazar MD5/SHA-1 con SHA-256 o superior para fines de seguridad.",
    "Usar cifrado autenticado (AES-GCM) en lugar de modos no autenticados.",
    "Evitar algoritmos criptográficos obsoletos o personalizados.",
  ],
};

const DEFAULT_SUGGESTED_ACTIONS: string[] = [
  "Revisar el flujo de taint de source a sink y evaluar su explotabilidad.",
  "Aplicar validación de input en el punto de entrada del source.",
  "Agregar una tarea de revisión de seguridad para este flujo de datos.",
];

// ---------------------------------------------------------------------------
// sha256 helper
// ---------------------------------------------------------------------------

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// deriveFindings
// ---------------------------------------------------------------------------

/**
 * Produce exactly one Finding per AuditPath, in the same order.
 *
 * @param paths   - source→sink paths from auditMNReachability
 * @param catalog - SourceSinkCatalogResult (for real-sink categories)
 * @param nodes   - all graph nodes (for label lookup)
 * @param clock   - injectable clock; defaults to Date.now (D6: determinism)
 */
export function deriveFindings(
  paths: AuditPath[],
  catalog: SourceSinkCatalogResult,
  nodes: GraphNode[],
  clock: () => number = () => Date.now(),
): Finding[] {
  // Build category lookup: sinkId → category (real catalog sinks)
  const catalogCategoryMap = new Map<string, SinkCategory>();
  for (const matched of catalog.sinks) {
    const cat = matched.pattern.category;
    // Only store SinkCategory values (filter out SourceCategory)
    if (
      cat === "eval" || cat === "exec" || cat === "sql" || cat === "ssrf" ||
      cat === "path-traversal" || cat === "template-render" || cat === "weak-crypto"
    ) {
      catalogCategoryMap.set(matched.node.id, cat);
    }
  }

  // Build category lookup: sinkId → category (synthetic sinks)
  const syntheticCategoryMap = new Map<string, SinkCategory>();
  for (const def of SYNTHETIC_SINK_DEFINITIONS) {
    syntheticCategoryMap.set(def.id, def.category);
  }

  // Build node label lookup
  const nodeById = new Map<string, GraphNode>();
  for (const n of nodes) {
    nodeById.set(n.id, n);
  }

  const now = clock();

  return paths.map((path, idx): Finding => {
    // Deterministic ID: sha256hex("source::sink::idx").slice(0,16)
    const id = sha256hex(`${path.source}::${path.sink}::${idx}`).slice(0, 16);

    // Resolve category: catalog first, then synthetic
    const category: SinkCategory | undefined =
      catalogCategoryMap.get(path.sink) ?? syntheticCategoryMap.get(path.sink);

    // Map to type + severity
    const mapping = category !== undefined ? CATEGORY_MAP[category] : undefined;
    const type: FindingType = mapping?.type ?? "taint-flow";
    const severity: FindingSeverity = mapping?.severity ?? "LOW";

    // SuggestedActions from catalog
    const suggestedActions: string[] =
      category !== undefined ? (SUGGESTED_ACTIONS[category] ?? DEFAULT_SUGGESTED_ACTIONS) : DEFAULT_SUGGESTED_ACTIONS;

    // Labels for title
    const sourceLabel = nodeById.get(path.source)?.label ?? path.source;
    const sinkLabel   = nodeById.get(path.sink)?.label   ?? path.sink;

    // Related nodes: intermediate hops (not source or sink)
    const relatedSet = new Set<string>();
    for (const step of path.steps) {
      if (step.from !== path.source && step.from !== path.sink) relatedSet.add(step.from);
      if (step.to !== path.source   && step.to !== path.sink)   relatedSet.add(step.to);
    }
    const relatedNodes = [...relatedSet];

    return {
      id,
      type,
      severity,
      title: `${type}: ${sourceLabel} → ${sinkLabel}`,
      description:
        `Potential ${type} vulnerability: tainted data flows from ${sourceLabel} ` +
        `to ${sinkLabel} through ${path.steps.length} hop(s).`,
      evidence: {
        sourceNodeId:   path.source,
        sinkNodeId:     path.sink,
        steps:          path.steps,
        reposTraversed: path.reposTraversed,
      },
      relatedNodes,
      suggestedActions,
      confidence: path.minConfidence,
      source: "audit.run",
      createdAt: now,
    };
  });
}
