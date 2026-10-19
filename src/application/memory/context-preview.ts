// application/memory/context-preview.ts — token-budget shaping for memory.context.
//
// recentContext() returns FULL observation bodies and session summaries. Over MCP that
// payload lands verbatim in the calling agent's context window, and hosts cap tool
// results (Claude Code: ~25k tokens) — a project with a few large observations (SDD
// plans, long session digests) blows straight past the cap and the whole result gets
// spilled to a file instead of the context. memory.context is a session-START payload:
// its job is orientation, not archival reads. So the MCP surface clips every body to a
// preview and points at memory.get for full content on demand.
//
// This lives in the application layer (not the repository) because it is a
// presentation budget of the context capability, not a storage concern: the CLI
// renders its own compact text, workspace federation merges repositories, and both
// keep using the untruncated recentContext() port.

import type { Observation, ObservationType, Scope, Session } from "../../domain/memory/model.ts";

/** Default per-body clip. 20 observations × 500 chars ≈ 3–4k tokens — well under host caps. */
export const DEFAULT_PREVIEW_CHARS = 500;

export interface ObservationPreview {
  id: string;
  projectKey: string;
  scope: Scope;
  type: ObservationType;
  title: string;
  topicKey?: string;
  updatedAt: number;
  /** First DEFAULT_PREVIEW_CHARS of content (word/line-aligned), "…"-terminated when clipped. */
  preview: string;
  truncated: boolean;
  /** Full body length, so the caller can judge whether memory.get is worth it. */
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
  /** Present only when something was clipped — tells the agent how to get full bodies. */
  note?: string;
}

/** Clip to `max` chars, preferring the last line/word break past 60% so previews end cleanly. */
function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const slice = text.slice(0, max);
  const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  const cut = lastBreak > max * 0.6 ? slice.slice(0, lastBreak) : slice;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

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
      projectKey: o.projectKey,
      scope: o.scope,
      type: o.type,
      title: o.title,
      topicKey: o.topicKey,
      updatedAt: o.updatedAt,
      preview: clipped.text,
      truncated: clipped.truncated,
      contentChars: o.content.length,
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
