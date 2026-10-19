// Memory domain — shared types. Type-stripping-safe: no enums, no namespaces.

// The closed value sets are runtime arrays (the types derive from them) so untrusted
// input — e.g. an imported snapshot — can be checked against the same single source.
export const SCOPES = [
  "project",
  "personal",
  "workspace",
  "path",
  "skill",
  "process",
  "technology",
  "security",
  "infra",
] as const;

export type Scope = (typeof SCOPES)[number];

export const OBSERVATION_TYPES = [
  "decision",
  "bugfix",
  "architecture",
  "discovery",
  "pattern",
  "config",
  "preference",
  "manual",
] as const;

export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/**
 * Type values that pre-3.0 CLIs stored without validation (`--type` was cast blindly), mapped
 * to the canonical type that replaces them. The v6 schema migration rewrites them in place
 * (any other unknown value becomes `manual`), and `memory import` accepts them so an export
 * taken before the upgrade still loads. New writes reject every value not in OBSERVATION_TYPES.
 */
export const LEGACY_TYPE_ALIASES: Readonly<Record<string, ObservationType>> = {
  note: "discovery",
  reference: "discovery",
  suggestion: "discovery",
  project: "discovery",
};

/** Raised when a write carries a type or scope outside the closed value sets. */
export class InvalidMemoryValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMemoryValueError";
  }
}

export function isObservationType(v: unknown): v is ObservationType {
  return typeof v === "string" && (OBSERVATION_TYPES as readonly string[]).includes(v);
}

export function isScope(v: unknown): v is Scope {
  return typeof v === "string" && (SCOPES as readonly string[]).includes(v);
}

/**
 * Validate a type value on its way into the store. `legacy: true` (import only) maps the
 * LEGACY_TYPE_ALIASES to their canonical type instead of rejecting them.
 */
export function parseObservationType(raw: unknown, opts?: { legacy?: boolean }): ObservationType {
  if (isObservationType(raw)) return raw;
  if (opts?.legacy === true && typeof raw === "string" && Object.hasOwn(LEGACY_TYPE_ALIASES, raw)) {
    return LEGACY_TYPE_ALIASES[raw]!;
  }
  throw new InvalidMemoryValueError(
    `invalid type ${JSON.stringify(raw)}: must be one of ${OBSERVATION_TYPES.join("|")}`,
  );
}

export function parseScope(raw: unknown): Scope {
  if (isScope(raw)) return raw;
  throw new InvalidMemoryValueError(`invalid scope ${JSON.stringify(raw)}: must be one of ${SCOPES.join("|")}`);
}

/**
 * Lifecycle of an observation, independent of its graph drift state. `active` notes are
 * current knowledge; `resolved` ones describe something that was dealt with (a fixed bug, a
 * closed backlog item); `obsolete` ones are no longer true. Only active notes are injected at
 * session start; search / verified / get still return the others, labelled and ranked below.
 */
export const OBSERVATION_STATUSES = ["active", "resolved", "obsolete"] as const;

export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

export function isObservationStatus(v: unknown): v is ObservationStatus {
  return typeof v === "string" && (OBSERVATION_STATUSES as readonly string[]).includes(v);
}

export function parseObservationStatus(raw: unknown): ObservationStatus {
  if (isObservationStatus(raw)) return raw;
  throw new InvalidMemoryValueError(
    `invalid status ${JSON.stringify(raw)}: must be one of ${OBSERVATION_STATUSES.join("|")}`,
  );
}

// Stored ids end in a random uuid segment (`<project>:<type>:<slug>:<ms>:<uuid>`), so its
// first 8 hex chars identify an observation within a project for all practical purposes.
// `memory context` and the session injection print that short form; every id-keyed verb
// (get / update / resolve / reopen, CLI and MCP) accepts it back.
const SHORT_ID_CHARS = 8;
const SHORT_ID_HEAD_RE = /^[0-9a-f]{8}/i;
/** A string that may be a short id: 4–32 hex chars, no `:` separator. */
export const SHORT_ID_RE = /^[0-9a-f]{4,32}$/i;

/** The short display form of an observation id (the whole id when it has no uuid tail). */
export function shortObservationId(id: string): string {
  const tail = id.slice(id.lastIndexOf(":") + 1);
  return SHORT_ID_HEAD_RE.test(tail) ? tail.slice(0, SHORT_ID_CHARS) : id;
}

/** True when `id`'s uuid tail starts with the (hex, case-insensitive) short form `short`. */
export function matchesShortId(id: string, short: string): boolean {
  const tail = id.slice(id.lastIndexOf(":") + 1);
  return tail.toLowerCase().startsWith(short.toLowerCase());
}

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
  status: ObservationStatus;
  /** When the status last changed (resolve / reopen). Absent for a note that was never resolved. */
  statusChangedAt?: number;
  /** Optional note saying how or why the observation was resolved / made obsolete. */
  resolution?: string;
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
  status: ObservationStatus;
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
// A status-only update (status / resolution) never touches updatedAt: resolving a note must
// not make it the "most recent" one.
export interface UpdateFields {
  title?: string;
  content?: string;
  type?: ObservationType;
  anchors?: string[];
  status?: ObservationStatus;
  /** Only with a non-active status (or on a note that already is): how it was resolved. */
  resolution?: string;
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
  /** Entries whose id already belongs to ANOTHER project in the global db — never touched. */
  skippedForeign: number;
  topicConflicts: number;
}
