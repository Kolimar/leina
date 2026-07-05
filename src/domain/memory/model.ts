// Memory domain — shared types. Type-stripping-safe: no enums, no namespaces.

export type Scope =
  | "project"
  | "personal"
  | "workspace"
  | "path"
  | "skill"
  | "process"
  | "technology"
  | "security"
  | "infra";

export type ObservationType =
  | "decision"
  | "bugfix"
  | "architecture"
  | "discovery"
  | "pattern"
  | "config"
  | "preference"
  | "manual";

export interface ObservationInput {
  title: string;
  content: string;
  type: ObservationType;
  topicKey?: string;
  scope?: Scope;
  sessionId?: string;
  anchors?: string[];
}

export interface Observation {
  id: string;
  projectKey: string;
  scope: Scope;
  type: ObservationType;
  title: string;
  content: string;
  topicKey?: string;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  supersededBy?: string;
}

export interface SearchHit {
  id: string;
  title: string;
  type: ObservationType;
  topicKey?: string;
  snippet: string;
  score: number;
  updatedAt: number;
  scope: Scope;
}

export interface Session {
  id: string;
  projectKey: string;
  scope: Scope;
  title?: string;
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

// UpdateFields — partial mutable fields for mem_update (id-stable in-place correction).
export interface UpdateFields {
  title?: string;
  content?: string;
  type?: ObservationType;
  anchors?: string[];
}

// TopicKeySuggestion — return shape for mem_suggest_topic_key.
export interface TopicKeySuggestion {
  suggestion: string;
  nearMatches: string[];
}

// ---------------------------------------------------------------------------
// Portable memory (export/import) — the on-the-wire shape of an observation.
// ---------------------------------------------------------------------------

export interface ExportedAnchor {
  nodeId: string;
  role: string;
  anchorLabel?: string;
  anchorFile?: string;
  anchorHash?: string;
  createdAt: number;
}

/** One JSONL line of a memory export: the full observation plus its anchors. */
export interface ExportedObservation extends Observation {
  schemaVersion: 1;
  anchors: ExportedAnchor[];
}

export interface ImportReport {
  inserted: number;
  updated: number;
  skippedOlder: number;
  topicConflicts: number;
}
