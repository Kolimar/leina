// domain/memory/portable.ts — validation of the portable-memory wire format (one JSONL
// line of `memory export`, consumed by `memory import` / `memory sync`).
//
// A `.leina/memory-export.jsonl` committed in a forked or hostile repo is untrusted input,
// so every line is checked here before it reaches the repository: closed value sets must
// hold known values, sizes are capped, numbers must be finite. Ownership (never touching
// another project's rows) and the future-timestamp clamp are enforced by the repository's
// import itself, next to the merge policy they protect.
//
// Dependency rule: this file MUST import only from domain modules.

import {
  InvalidMemoryValueError,
  LEGACY_TYPE_ALIASES,
  OBSERVATION_STATUSES,
  OBSERVATION_TYPES,
  SCOPES,
  parseObservationType,
  type ObservationStatus,
  type ExportedAnchor,
  type ExportedObservation,
  type Scope,
} from "./model.ts";

/**
 * Longest accepted title. Generous for a one-line summary, and well under the 4000-char
 * memory budget SessionStart injects — one oversized title must not crowd out the rest.
 */
export const MAX_IMPORT_TITLE_CHARS = 1_000;
/** Longest accepted content (256 KiB of text — far beyond any useful observation). */
export const MAX_IMPORT_CONTENT_CHARS = 256 * 1024;
// Ids embed the title- or topic-derived slug (see SQLiteMemoryRepository.scopedId), so
// they scale with the title cap; keys, session ids and anchor fields share one bound.
const MAX_ID_CHARS = 2 * MAX_IMPORT_TITLE_CHARS;
const MAX_FIELD_CHARS = 4_096;

export type ParsedExport = { ok: true; value: ExportedObservation } | { ok: false; error: string };

class InvalidExport extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, key: string, max: number, path = key): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) throw new InvalidExport(`${path} must be a non-empty string`);
  if (v.length > max) throw new InvalidExport(`${path} exceeds ${max} characters`);
  return v;
}

// Absent and null are both "not set" (exports omit unset fields; hand-edited files may null them).
function optStr(o: Record<string, unknown>, key: string, max: number, path = key): string | undefined {
  const v = o[key];
  return v === undefined || v === null ? undefined : str(o, key, max, path);
}

function timestamp(o: Record<string, unknown>, key: string, path = key): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new InvalidExport(`${path} must be a non-negative epoch-milliseconds number`);
  }
  return v;
}

function oneOf<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = o[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new InvalidExport(`${key} must be one of ${allowed.join("|")}`);
  }
  return v as T;
}

// Exports taken before 3.0 may carry the unvalidated legacy types the CLI used to store
// (`note`, …): they load under their canonical type instead of failing the whole import.
function legacyAwareType(v: unknown): ExportedObservation["type"] {
  try {
    return parseObservationType(v, { legacy: true });
  } catch (e) {
    if (!(e instanceof InvalidMemoryValueError)) throw e;
    throw new InvalidExport(
      `type must be one of ${OBSERVATION_TYPES.join("|")} ` +
        `(legacy ${Object.keys(LEGACY_TYPE_ALIASES).join("|")} are mapped)`,
    );
  }
}

function parseAnchor(raw: unknown, i: number): ExportedAnchor {
  const path = `anchors[${i}]`;
  if (!isRecord(raw)) throw new InvalidExport(`${path} must be an object`);
  const a: ExportedAnchor = {
    nodeId: str(raw, "nodeId", MAX_FIELD_CHARS, `${path}.nodeId`),
    role: str(raw, "role", MAX_FIELD_CHARS, `${path}.role`),
    createdAt: timestamp(raw, "createdAt", `${path}.createdAt`),
  };
  const anchorLabel = optStr(raw, "anchorLabel", MAX_FIELD_CHARS, `${path}.anchorLabel`);
  const anchorFile = optStr(raw, "anchorFile", MAX_FIELD_CHARS, `${path}.anchorFile`);
  const anchorHash = optStr(raw, "anchorHash", MAX_FIELD_CHARS, `${path}.anchorHash`);
  if (anchorLabel !== undefined) a.anchorLabel = anchorLabel;
  if (anchorFile !== undefined) a.anchorFile = anchorFile;
  if (anchorHash !== undefined) a.anchorHash = anchorHash;
  return a;
}

// Exports taken before the lifecycle existed carry no status: they were all active.
function parseLifecycle(raw: Record<string, unknown>): Pick<ExportedObservation, "status" | "statusChangedAt" | "resolution"> {
  const status = raw.status === undefined || raw.status === null
    ? "active"
    : oneOf<ObservationStatus>(raw, "status", OBSERVATION_STATUSES);
  const out: Pick<ExportedObservation, "status" | "statusChangedAt" | "resolution"> = { status };
  if (raw.statusChangedAt !== undefined && raw.statusChangedAt !== null) {
    out.statusChangedAt = timestamp(raw, "statusChangedAt");
  }
  const resolution = optStr(raw, "resolution", MAX_FIELD_CHARS);
  if (resolution !== undefined) out.resolution = resolution;
  return out;
}

function parseOrThrow(raw: unknown): ExportedObservation {
  if (!isRecord(raw)) throw new InvalidExport("not a JSON object");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    throw new InvalidExport(`unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected 1)`);
  }
  const id = str(raw, "id", MAX_ID_CHARS);
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1) {
    throw new InvalidExport("revision must be a positive integer");
  }
  // title/content may legitimately be empty (`memory save --title ""`), so they get their
  // own checks instead of str()'s non-empty rule.
  if (typeof raw.title !== "string") throw new InvalidExport("title must be a string");
  if (raw.title.length > MAX_IMPORT_TITLE_CHARS) {
    throw new InvalidExport(`title exceeds ${MAX_IMPORT_TITLE_CHARS} characters`);
  }
  if (typeof raw.content !== "string") throw new InvalidExport("content must be a string");
  if (raw.content.length > MAX_IMPORT_CONTENT_CHARS) {
    throw new InvalidExport(`content exceeds ${MAX_IMPORT_CONTENT_CHARS} characters`);
  }
  const anchors = raw.anchors ?? [];
  if (!Array.isArray(anchors)) throw new InvalidExport("anchors must be an array");

  const o: ExportedObservation = {
    schemaVersion: 1,
    id,
    // The stored project key is always the importing store's own; carried for shape only.
    projectKey: typeof raw.projectKey === "string" ? raw.projectKey : "",
    scope: oneOf<Scope>(raw, "scope", SCOPES),
    type: legacyAwareType(raw.type),
    title: raw.title,
    content: raw.content,
    createdAt: timestamp(raw, "createdAt"),
    updatedAt: timestamp(raw, "updatedAt"),
    revision: raw.revision,
    ...parseLifecycle(raw),
    anchors: anchors.map(parseAnchor),
  };
  const topicKey = optStr(raw, "topicKey", MAX_IMPORT_TITLE_CHARS);
  const sessionId = optStr(raw, "sessionId", MAX_ID_CHARS);
  const supersededBy = optStr(raw, "supersededBy", MAX_ID_CHARS);
  if (supersededBy === id) throw new InvalidExport("supersededBy must not point at the entry itself");
  if (topicKey !== undefined) o.topicKey = topicKey;
  if (sessionId !== undefined) o.sessionId = sessionId;
  if (supersededBy !== undefined) o.supersededBy = supersededBy;
  return o;
}

/**
 * Validate one decoded JSONL entry of a memory export. Returns the normalised observation
 * (unknown keys dropped, null optionals removed) or a one-line reason naming the field.
 */
export function parseExportedObservation(raw: unknown): ParsedExport {
  try {
    return { ok: true, value: parseOrThrow(raw) };
  } catch (e) {
    if (e instanceof InvalidExport) return { ok: false, error: e.message };
    throw e;
  }
}
