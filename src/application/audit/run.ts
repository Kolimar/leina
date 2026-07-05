// application/audit/run.ts — runAudit use case.
//
// Extracts the audit orchestration logic from cli/handlers/audit.ts so the
// pipeline can be referenced in the capability registry and invoked without
// importing CLI concerns.
//
// D3 decision: store is INJECTED (not opened here) because opening a store
// requires cli/wiring.ts or infrastructure/sqlite imports in application/.
// The transport layer (CLI handler, future MCP adapter) calls openGraphRepo()
// and passes the result here.
//
// arch-rule-3: no node:sqlite, node:child_process, web-tree-sitter, ts-morph imports.

import type { GraphRepository } from "../../domain/graph/ports.ts";
import { buildSourceSinkCatalog } from "./source-sink-catalog.ts";
import { auditMNReachability, SyntheticSinkOverlay, makeSyntheticSinkNodes } from "./reachability.ts";
import { buildAuditPack, type AuditPack } from "./pack.ts";
import { deriveFindings } from "./findings.ts";

export interface RunAuditOpts {
  /** Explicit source entry-point IDs. If omitted, auto-detected from source/sink catalog. */
  fromIds?: string[];
  /** Maximum serialised pack size in bytes (default 128 KB). */
  maxBytes?: number;
}

/**
 * Run the full audit pipeline on an already-opened graph store.
 *
 * Pipeline:
 *   1. buildSourceSinkCatalog   → detect sources and sinks from node labels
 *   2. makeSyntheticSinkNodes   → ephemeral high-confidence sinks (CRIT-4)
 *   3. SyntheticSinkOverlay     → read-only view with synthetic sinks injected
 *   4. auditMNReachability      → M sources × N sinks with confidence per edge
 *   5. buildAuditPack           → serialisable pack with size-limit + pruning
 *
 * The caller is responsible for opening and closing `store`.
 */
export async function runAudit(store: GraphRepository, opts?: RunAuditOpts): Promise<AuditPack> {
  const maxBytes = opts?.maxBytes ?? 128 * 1024;

  // 1. Build source/sink catalog
  const ssCatalog = buildSourceSinkCatalog(store);

  // 2. Collect source and sink IDs
  const sourceIds = (opts?.fromIds && opts.fromIds.length > 0)
    ? opts.fromIds
    : ssCatalog.sources.map((m) => m.node.id);

  const sinkIds = ssCatalog.sinks.map((m) => m.node.id);

  // 3. Synthetic sinks + overlay
  const syntheticSinks = makeSyntheticSinkNodes();
  const overlay = new SyntheticSinkOverlay(store, syntheticSinks);
  const allSinkIds = [...sinkIds, ...syntheticSinks.map((n) => n.id)];

  // 4. M:N reachability
  const paths = auditMNReachability(overlay, sourceIds, allSinkIds);

  // 5. Derive findings (one per path) before building the pack (D2/D3)
  const nodes = overlay.allNodes();
  const findings = deriveFindings(paths, ssCatalog, nodes);

  // 6. Build pack (findings injected as 3rd arg, per new signature)
  return buildAuditPack(paths, overlay, findings, maxBytes);
}
