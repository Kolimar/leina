// application/memory/context-preview.ts — what "memory context" shows, and how.
//
// One pipeline serves every context surface — the SessionStart / PostCompaction injection,
// `leina memory context` and MCP `memory_context`:
//
//   1. rankForContext()      — WHICH notes: active only, ranked by type weight × recency
//                              decay, deterministic tie-break, at most MAX_PER_TOPIC_PREFIX
//                              per topic prefix so one SDD change or backlog batch cannot
//                              crowd out everything else.
//   2. previewRecentContext()— HOW MUCH of each: bodies and session summaries clipped to a
//                              preview (code-point safe), plus the short id / status the
//                              follow-up verbs accept.
//   3. renderContextNotes() / renderMemoryInjection()
//                            — the text form (CLI + injection). MCP returns step 2 as JSON.
//
// recentContext() returns FULL bodies; over MCP that payload lands verbatim in the calling
// agent's context window and hosts cap tool results (Claude Code: ~25k tokens), so the
// context surfaces are previews that point at memory get for full content on demand.
//
// This lives in the application layer (not the repository) because it is a presentation
// policy of the context capability, not a storage concern: workspace federation and the
// archival reads keep using the untruncated, newest-first recentContext() port.

import {
  shortObservationId,
  type Observation,
  type ObservationStatus,
  type ObservationType,
  type Scope,
  type Session,
} from "../../domain/memory/model.ts";

/** Default per-body clip. 20 observations × 500 chars ≈ 3–4k tokens — well under host caps. */
export const DEFAULT_PREVIEW_CHARS = 500;

/** Per-body clip of the TEXT surfaces (injection + CLI): 10 notes ≈ 1.2–1.6k tokens in all. */
export const TEXT_PREVIEW_CHARS = 280;

/** How many notes the session injection and `memory context` show by default. */
export const CONTEXT_NOTES = 10;

/**
 * How many of the newest active notes the ranking looks at. Older ones cannot outrank them
 * after RECENCY decay anyway; the cap bounds the read on huge projects.
 */
export const CONTEXT_POOL = 500;

/** Recency half-life: a note this many days older than the newest one weighs half as much. */
export const CONTEXT_HALF_LIFE_DAYS = 45;

/** At most this many notes per topic prefix (see topicPrefix). */
export const MAX_PER_TOPIC_PREFIX = 2;

/** An arbitrarily old note keeps this share of its type weight (so the type still orders them). */
const RECENCY_FLOOR = 0.1;
const DAY_MS = 86_400_000;

/**
 * Type weights: the normative / structural kinds (what the next change must respect) before
 * the descriptive ones (what happened). Tunable here only.
 */
export const CONTEXT_TYPE_WEIGHTS: Readonly<Record<ObservationType, number>> = {
  decision: 1,
  preference: 1,
  architecture: 0.9,
  pattern: 0.85,
  bugfix: 0.8,
  config: 0.75,
  discovery: 0.7,
  manual: 0.6,
};

export interface ObservationPreview {
  id: string;
  /** First 8 hex chars of the id's uuid tail — accepted back by memory get/update/resolve. */
  shortId: string;
  projectKey: string;
  scope: Scope;
  type: ObservationType;
  status: ObservationStatus;
  title: string;
  topicKey?: string;
  updatedAt: number;
  /** First N code points of content (word/line-aligned), "…"-terminated when clipped. */
  preview: string;
  truncated: boolean;
  /** Full body length in code points, so the caller can judge whether memory.get is worth it. */
  contentChars: number;
}

export interface SessionPreview {
  id: string;
  title?: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  summaryTruncated: boolean;
}

export interface RecentContextPreview {
  sessions: SessionPreview[];
  observations: ObservationPreview[];
  /**
   * Active notes the ranking considered (capped at CONTEXT_POOL) — "10 of N". Set by
   * buildContextView only.
   */
  activeTotal?: number;
  /** Present only when something was clipped — tells the agent how to get full bodies. */
  note?: string;
}

// ---------------------------------------------------------------------------------------------
// 1. ranking
// ---------------------------------------------------------------------------------------------

/**
 * The family a topic key belongs to: its first two segments, never the leaf itself —
 * `sdd/auth-rework/proposal` → `sdd/auth-rework`, `backlog/review-2026-07/x` →
 * `backlog/review-2026-07`, a flat `backlog/graph-gc` → `backlog`, a one-segment `release`
 * → `release`. No topic → undefined (such notes are never capped).
 */
export function topicPrefix(topicKey: string | undefined): string | undefined {
  if (topicKey === undefined) return undefined;
  const segments = topicKey.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  return segments.slice(0, Math.max(1, Math.min(2, segments.length - 1))).join("/");
}

/** Type weight × recency decay relative to `newest` (the reference instant). */
export function contextScore(o: Pick<Observation, "type" | "updatedAt">, newest: number): number {
  const ageDays = Math.max(0, newest - o.updatedAt) / DAY_MS;
  const decay = 0.5 ** (ageDays / CONTEXT_HALF_LIFE_DAYS);
  return (CONTEXT_TYPE_WEIGHTS[o.type] ?? CONTEXT_TYPE_WEIGHTS.manual) * (RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decay);
}

/**
 * The notes a context surface shows, best first. Active live notes only; score desc, then
 * newest, then id desc (the store's own tie-break) — the same input always yields the same
 * order. Recency is measured from the newest note (`now` overrides), so a project that sat
 * idle for months ranks exactly as it did when it was last touched.
 */
export function rankForContext(
  observations: readonly Observation[],
  opts: { limit: number; now?: number },
): Observation[] {
  const live = observations.filter((o) => o.status === "active" && o.supersededBy === undefined);
  if (live.length === 0 || opts.limit <= 0) return [];
  const newest = opts.now ?? live.reduce((m, o) => Math.max(m, o.updatedAt), 0);
  const scored = live.map((o) => ({ o, s: contextScore(o, newest) }));
  scored.sort(
    (a, b) => b.s - a.s || b.o.updatedAt - a.o.updatedAt || (a.o.id < b.o.id ? 1 : a.o.id > b.o.id ? -1 : 0),
  );
  const perPrefix = new Map<string, number>();
  const out: Observation[] = [];
  for (const { o } of scored) {
    if (out.length >= opts.limit) break;
    const prefix = topicPrefix(o.topicKey);
    if (prefix !== undefined) {
      const seen = perPrefix.get(prefix) ?? 0;
      if (seen >= MAX_PER_TOPIC_PREFIX) continue;
      perPrefix.set(prefix, seen + 1);
    }
    out.push(o);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 2. previews
// ---------------------------------------------------------------------------------------------

// "Chars" throughout this module are Unicode CODE POINTS, not UTF-16 units: a UTF-16
// cut can land between the two halves of a surrogate pair (any emoji / astral char),
// leaving a lone high surrogate that serialises as U+FFFD or breaks strict JSON
// consumers. Clipping by code point never splits a pair. (Grapheme clusters such as
// ZWJ emoji sequences may still be split into their component code points — that is
// still valid text, and a segmenter would be overkill for a preview budget.)

/** Number of Unicode code points in `s`. */
function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Clip to `max` code points, preferring the last line/word break past 60% so previews end cleanly. */
function clip(text: string, max: number): { text: string; truncated: boolean } {
  // UTF-16 length bounds the code-point count from above: the common short case is free.
  if (text.length <= max) return { text, truncated: false };
  const points = Array.from(text);
  if (points.length <= max) return { text, truncated: false };
  const slice = points.slice(0, max).join("");
  // Breaks are BMP chars, so cutting at one never splits a pair either.
  const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  const cut = lastBreak > slice.length * 0.6 ? slice.slice(0, lastBreak) : slice;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

/** Clip bodies and summaries to previews, keeping the given order. */
export function previewRecentContext(
  ctx: { sessions: Session[]; observations: Observation[] },
  opts?: { previewChars?: number },
): RecentContextPreview {
  const max = opts?.previewChars ?? DEFAULT_PREVIEW_CHARS;

  const sessions: SessionPreview[] = ctx.sessions.map((s) => {
    const clipped = s.summary === undefined ? undefined : clip(s.summary, max);
    return {
      id: s.id,
      title: s.title,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      summary: clipped?.text,
      summaryTruncated: clipped?.truncated ?? false,
    };
  });

  const observations: ObservationPreview[] = ctx.observations.map((o) => {
    const clipped = clip(o.content, max);
    return {
      id: o.id,
      shortId: shortObservationId(o.id),
      projectKey: o.projectKey,
      scope: o.scope,
      type: o.type,
      status: o.status,
      title: o.title,
      topicKey: o.topicKey,
      updatedAt: o.updatedAt,
      preview: clipped.text,
      truncated: clipped.truncated,
      contentChars: codePointLength(o.content),
    };
  });

  const anyTruncated =
    sessions.some((s) => s.summaryTruncated) || observations.some((o) => o.truncated);

  return {
    sessions,
    observations,
    ...(anyTruncated
      ? {
          note:
            "bodies clipped to previews — fetch full content with memory_get " +
            "(single id, or ids[] for a batch); pass full:true to memory_context to opt out",
        }
      : {}),
  };
}

/**
 * Rank + preview: the view every context surface starts from. `ctx.observations` should be
 * the newest CONTEXT_POOL active notes (recentContext({ limit: CONTEXT_POOL })).
 */
export function buildContextView(
  ctx: { sessions: Session[]; observations: Observation[] },
  opts?: { limit?: number; previewChars?: number; now?: number },
): RecentContextPreview {
  const ranked = rankForContext(ctx.observations, { limit: opts?.limit ?? CONTEXT_NOTES, now: opts?.now });
  const view = previewRecentContext({ sessions: ctx.sessions, observations: ranked }, opts);
  view.activeTotal = ctx.observations.filter((o) => o.status === "active" && o.supersededBy === undefined).length;
  return view;
}

// ---------------------------------------------------------------------------------------------
// 3. text
// ---------------------------------------------------------------------------------------------

const TITLE_CHARS = 110;
const PREVIEW_LINES = 3;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function stripHeading(line: string): string {
  return line.replace(/^#+\s*/, "").trim();
}

// The preview as up to PREVIEW_LINES indented lines: blank lines and markdown heading marks
// dropped, a first line that only repeats the title skipped, "…" kept when anything was left
// out.
function previewLines(o: ObservationPreview): string[] {
  let lines = o.preview.split("\n").map(stripHeading).filter((l) => l.length > 0);
  if (lines.length > 0 && lines[0]!.toLowerCase() === o.title.trim().toLowerCase()) lines = lines.slice(1);
  const kept = lines.slice(0, PREVIEW_LINES);
  const dropped = kept.length < lines.length;
  if (kept.length > 0 && (dropped || o.truncated) && !kept[kept.length - 1]!.endsWith("…")) {
    kept[kept.length - 1] = `${kept[kept.length - 1]!}…`;
  }
  return kept.map((l) => `  ${l}`);
}

/** One block per note: `- [type] title (#short · date · topic)` + indented preview lines. */
export function renderContextNotes(view: RecentContextPreview): string[] {
  return view.observations.map((o) => {
    const title = clip(o.title.replace(/\s+/g, " ").trim(), TITLE_CHARS).text;
    const meta = [`#${o.shortId}`, isoDay(o.updatedAt), ...(o.topicKey ? [o.topicKey] : [])].join(" · ");
    const status = o.status === "active" ? "" : ` (${o.status})`;
    return [`- [${o.type}]${status} ${title} (${meta})`, ...previewLines(o)].join("\n");
  });
}

/** "10 of 126 active notes" (with "+" when the ranking pool was full). */
export function contextCountLabel(view: RecentContextPreview): string {
  const total = view.activeTotal ?? view.observations.length;
  return `${view.observations.length} of ${total}${total >= CONTEXT_POOL ? "+" : ""} active notes`;
}

/** The newest session that has a summary, as one line (undefined when there is none). */
export function renderLatestSession(view: RecentContextPreview): string | undefined {
  const s = view.sessions.find((x) => x.summary !== undefined && x.summary.trim().length > 0);
  if (s === undefined) return undefined;
  const summary = s.summary!.replace(/\s+/g, " ").trim();
  return `Last session (${isoDay(s.endedAt ?? s.startedAt)}): ${summary}`;
}

/**
 * The memory section of the SessionStart / PostCompaction injection: header, latest session
 * summary, ranked notes and the follow-up verbs. Notes past `maxChars` are dropped whole.
 */
export function renderMemoryInjection(view: RecentContextPreview, opts?: { maxChars?: number }): string {
  const maxChars = opts?.maxChars ?? 6000;
  if (view.observations.length === 0 && renderLatestSession(view) === undefined) {
    return "## Project memory\n(no observations yet)";
  }
  const head = [`## Project memory — ${contextCountLabel(view)} (ranked by type and recency; resolved notes hidden)`];
  const session = renderLatestSession(view);
  if (session !== undefined) head.push(session);
  const footer =
    "Full text: `leina memory get <dir> <id>`; more: `leina memory search <dir> \"<query>\"`. " +
    "A note that is done or no longer true: `leina memory resolve <dir> <id> [--note \"...\"]`.";
  let used = head.join("\n").length + footer.length + 4;
  const notes: string[] = [];
  for (const block of renderContextNotes(view)) {
    if (used + block.length + 1 > maxChars) break;
    notes.push(block);
    used += block.length + 1;
  }
  return [head.join("\n"), notes.join("\n"), footer].filter((p) => p.length > 0).join("\n\n");
}
