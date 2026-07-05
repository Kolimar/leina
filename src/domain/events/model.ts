// domain/events/model.ts — Event model for the local outbox (etapa-8-events-cloud).
// Defines the LeinaEvent type, payload shapes, and the pure factory function.
// ISOLATION RULE: no imports from application/, infrastructure/ or cli/.

import type { ObservationType } from "../memory/model.ts";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type LeinaEventType = "graph.built" | "memory.created" | "audit.completed";

// ---------------------------------------------------------------------------
// Payload interfaces (exact fields per spec type_contracts)
// ---------------------------------------------------------------------------

export interface GraphBuiltPayload {
  root: string;
  nodes: number;
  edges: number;
  filesScanned: number;
  filesExtracted: number;
}

export interface MemoryCreatedPayload {
  id: string;
  type: ObservationType;
  topicKey?: string;
  evolved: boolean;
  revision: number;
}

export interface AuditCompletedPayload {
  pathsFound: number;
  prunedPaths: number;
  findingsCount: number;
  reposInvolved: string[];
  packVersion: 3;
}

// Internal map used by makeLeinaEvent to constrain payload type per event type.
interface PayloadMap {
  "graph.built": GraphBuiltPayload;
  "memory.created": MemoryCreatedPayload;
  "audit.completed": AuditCompletedPayload;
}

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

export interface LeinaEvent {
  schemaVersion: 1;
  id: string;
  type: LeinaEventType;
  ts: number;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a LeinaEvent with the given type and payload.
 * @param idFn - Optional id generator; defaults to crypto.randomUUID().
 *               Injected in tests (D6) for deterministic ids.
 */
export function makeLeinaEvent<T extends LeinaEventType>(
  type: T,
  payload: PayloadMap[T],
  idFn: () => string = () => crypto.randomUUID(),
): LeinaEvent {
  return { schemaVersion: 1, id: idFn(), type, ts: Date.now(), payload: payload as unknown as Record<string, unknown> };
}
