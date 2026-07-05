// domain/findings/model.ts
// Finding domain model — pure types, no imports from application/, cli/, infra/.
// Precedent: FileArtifact in domain/install/artifact.ts (arch-rule D1).

import type { Confidence, Relation } from "../graph/model.ts";

// ---------------------------------------------------------------------------
// Severity and type unions
// ---------------------------------------------------------------------------

export type FindingSeverity = "HIGH" | "MEDIUM" | "LOW";

export type FindingType =
  | "code-injection"
  | "command-injection"
  | "sql-injection"
  | "ssrf"
  | "path-traversal"
  | "template-injection"
  | "weak-crypto"
  | "taint-flow";

// ---------------------------------------------------------------------------
// Evidence — the path that produced this finding
// ---------------------------------------------------------------------------

export interface FindingEvidence {
  sourceNodeId: string;
  sinkNodeId: string;
  steps: {
    from: string;
    to: string;
    relation: Relation;
    confidence: Confidence;
  }[];
  reposTraversed: string[];
}

// ---------------------------------------------------------------------------
// Finding — one security observation derived from an AuditPath
// ---------------------------------------------------------------------------

export interface Finding {
  /** sha256hex("source::sink::idx").slice(0,16) — deterministic */
  id: string;
  type: FindingType;
  severity: FindingSeverity;
  /** "<type>: <sourceLabel> → <sinkLabel>" */
  title: string;
  description: string;
  evidence: FindingEvidence;
  /** IDs of intermediate hops (source and sink excluded) */
  relatedNodes: string[];
  /** Ordered action strings from the SinkCategory catalog */
  suggestedActions: string[];
  /** Minimum confidence across all path edges */
  confidence: Confidence;
  /** Fixed literal — all findings come from the audit pipeline */
  source: "audit.run";
  /** Unix ms — injected via clock for deterministic fixtures */
  createdAt: number;
}
