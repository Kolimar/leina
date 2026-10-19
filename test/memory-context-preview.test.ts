// memory-context-preview.test.ts — previewRecentContext (MCP token-budget shaping).
//
// The MCP memory_context surface clips observation bodies and session summaries so the
// session-start payload stays a few thousand tokens regardless of how large individual
// memories grow (host tool-result caps: ~25k tokens). These tests pin the clip contract:
// passthrough under the budget, word/line-aligned truncation over it, metadata survival,
// and the memory_get redirection note appearing exactly when something was clipped.
// Run: node --no-warnings --experimental-strip-types --test test/memory-context-preview.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContextView,
  contextCountLabel,
  contextScore,
  DEFAULT_PREVIEW_CHARS,
  MAX_PER_TOPIC_PREFIX,
  previewRecentContext,
  rankForContext,
  renderContextNotes,
  renderMemoryInjection,
  TEXT_PREVIEW_CHARS,
  topicPrefix,
} from "../src/application/memory/context-preview.ts";
import { shortObservationId, type Observation, type Session } from "../src/domain/memory/model.ts";

function obs(over: Partial<Observation>): Observation {
  return {
    id: "obs-1",
    projectKey: "proj",
    scope: "project",
    type: "manual",
    title: "t",
    content: "c",
    createdAt: 1,
    updatedAt: 2,
    revision: 1,
    status: "active",
    ...over,
  };
}

function session(over: Partial<Session>): Session {
  return { id: "sess-1", projectKey: "proj", scope: "project", startedAt: 1, ...over };
}

test("(ctxprev-1) short bodies pass through verbatim — no truncation, no note", () => {
  const out = previewRecentContext({
    sessions: [session({ summary: "short summary" })],
    observations: [obs({ content: "short body" })],
  });
  assert.equal(out.observations[0]!.preview, "short body");
  assert.equal(out.observations[0]!.truncated, false);
  assert.equal(out.observations[0]!.contentChars, "short body".length);
  assert.equal(out.sessions[0]!.summary, "short summary");
  assert.equal(out.sessions[0]!.summaryTruncated, false);
  assert.equal(out.note, undefined, "no note when nothing was clipped");
});

test("(ctxprev-2) long observation body is clipped with ellipsis; note points at memory_get", () => {
  const body = "word ".repeat(400); // 2000 chars
  const out = previewRecentContext({ sessions: [], observations: [obs({ content: body })] });
  const o = out.observations[0]!;
  assert.ok(o.truncated, "marked truncated");
  assert.ok(o.preview.length <= DEFAULT_PREVIEW_CHARS + 1, `preview within budget (got ${o.preview.length})`);
  assert.ok(o.preview.endsWith("…"), "ellipsis-terminated");
  assert.equal(o.contentChars, body.length, "full length reported");
  assert.match(out.note ?? "", /memory_get/, "note redirects to memory_get");
  assert.match(out.note ?? "", /full:true/, "note mentions the full:true opt-out");
});

test("(ctxprev-3) clip prefers a word/line break — no mid-word cut", () => {
  const body = `${"a".repeat(400)}\n${"b".repeat(400)}`;
  const out = previewRecentContext({ sessions: [], observations: [obs({ content: body })] });
  // The only break inside the 500-char window is the newline at 400 (> 60% of 500).
  assert.equal(out.observations[0]!.preview, `${"a".repeat(400)}…`);
});

test("(ctxprev-4) unbroken blob still clips at the hard budget", () => {
  const body = "x".repeat(2000);
  const out = previewRecentContext({ sessions: [], observations: [obs({ content: body })] });
  assert.equal(out.observations[0]!.preview, `${"x".repeat(DEFAULT_PREVIEW_CHARS)}…`);
});

test("(ctxprev-5) session summaries are clipped too; absent summaries stay absent", () => {
  const out = previewRecentContext({
    sessions: [session({ summary: "s ".repeat(600) }), session({ id: "sess-2" })],
    observations: [],
  });
  assert.ok(out.sessions[0]!.summaryTruncated);
  assert.ok(out.sessions[0]!.summary!.endsWith("…"));
  assert.equal(out.sessions[1]!.summary, undefined);
  assert.equal(out.sessions[1]!.summaryTruncated, false);
  assert.match(out.note ?? "", /memory_get/, "session-only truncation also raises the note");
});

test("(ctxprev-6) metadata needed for follow-up fetches survives the preview", () => {
  const out = previewRecentContext({
    sessions: [],
    observations: [
      obs({ id: "obs-9", projectKey: "repo-b", scope: "workspace", type: "decision", topicKey: "topic/x", updatedAt: 42, content: "y".repeat(1000) }),
    ],
  }, { previewChars: 100 });
  const o = out.observations[0]!;
  assert.equal(o.id, "obs-9");
  assert.equal(o.projectKey, "repo-b");
  assert.equal(o.scope, "workspace");
  assert.equal(o.type, "decision");
  assert.equal(o.topicKey, "topic/x");
  assert.equal(o.updatedAt, 42);
  assert.equal(o.preview, `${"y".repeat(100)}…`, "previewChars override respected");
});

/** True when `s` contains a high surrogate not followed by a low one (or a stray low). */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

test("(ctxprev-7) clipping never splits a surrogate pair (emoji at the budget boundary)", () => {
  // 99 ASCII chars then emoji: a UTF-16 cut at 100 would land between the two halves.
  const body = `${"x".repeat(99)}${"😀".repeat(50)}`;
  const out = previewRecentContext({ sessions: [], observations: [obs({ content: body })] }, { previewChars: 100 });
  const o = out.observations[0]!;
  assert.ok(o.truncated);
  assert.ok(!hasLoneSurrogate(o.preview), "no lone surrogate in the preview");
  assert.equal(o.preview, `${"x".repeat(99)}😀…`, "budget counted in code points");
  // The serialized payload stays valid UTF-8 (a lone surrogate would turn into U+FFFD).
  assert.equal(Buffer.from(JSON.stringify(o), "utf8").toString("utf8"), JSON.stringify(o));
});

test("(ctxprev-8) contentChars counts code points; an all-emoji body under budget is not clipped", () => {
  const body = "🚀".repeat(300); // 300 code points, 600 UTF-16 units
  const out = previewRecentContext({ sessions: [], observations: [obs({ content: body })] });
  const o = out.observations[0]!;
  assert.equal(o.contentChars, 300, "code points, not UTF-16 units");
  assert.equal(o.truncated, false, "300 code points fit the 500 budget");
  assert.equal(o.preview, body);
  // Session summaries go through the same clip.
  const s = previewRecentContext(
    { sessions: [session({ summary: `${"s".repeat(9)}${"🚀".repeat(5)}` })], observations: [] },
    { previewChars: 10 },
  ).sessions[0]!;
  assert.equal(s.summary, `${"s".repeat(9)}🚀…`);
});

// ---------------------------------------------------------------------------------------------
// ranking + text rendering (the view shared by the injection, `memory context` and MCP)
// ---------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const T0 = 1_780_000_000_000;

test("(ctxprev-9) topicPrefix is the topic's family, never the leaf", () => {
  assert.equal(topicPrefix("sdd/auth-rework/proposal"), "sdd/auth-rework");
  assert.equal(topicPrefix("backlog/review-2026-07/memory-retention"), "backlog/review-2026-07");
  assert.equal(topicPrefix("a/b/c/d"), "a/b");
  assert.equal(topicPrefix("backlog/graph-gc"), "backlog");
  assert.equal(topicPrefix("release"), "release");
  assert.equal(topicPrefix(undefined), undefined);
  assert.equal(topicPrefix("/"), undefined);
});

test("(ctxprev-10) rank: type weight × recency, inactive and snapshots excluded", () => {
  const ranked = rankForContext(
    [
      obs({ id: "p:manual-new", type: "manual", updatedAt: T0 }),
      obs({ id: "p:decision-new", type: "decision", updatedAt: T0 - DAY }),
      obs({ id: "p:decision-old", type: "decision", updatedAt: T0 - 200 * DAY }),
      obs({ id: "p:bugfix-mid", type: "bugfix", updatedAt: T0 - 10 * DAY }),
      obs({ id: "p:resolved", type: "decision", updatedAt: T0, status: "resolved" }),
      obs({ id: "p:snap", type: "decision", updatedAt: T0, supersededBy: "p:decision-new" }),
    ],
    { limit: 10 },
  );
  assert.deepEqual(ranked.map((o) => o.id), ["p:decision-new", "p:bugfix-mid", "p:manual-new", "p:decision-old"]);
  // The reference instant is the newest note, so an idle project ranks the same later on.
  const later = rankForContext(ranked, { limit: 10, now: T0 });
  assert.deepEqual(later.map((o) => o.id), ranked.map((o) => o.id));
  assert.ok(contextScore({ type: "decision", updatedAt: T0 - 45 * DAY }, T0) < contextScore({ type: "decision", updatedAt: T0 }, T0) * 0.6);
});

test("(ctxprev-11) rank: ties break deterministically (newest, then id desc) whatever the input order", () => {
  const notes = ["p:a", "p:c", "p:b"].map((id) => obs({ id, type: "pattern", updatedAt: T0 }));
  const once = rankForContext(notes, { limit: 3 }).map((o) => o.id);
  const reversed = rankForContext([...notes].reverse(), { limit: 3 }).map((o) => o.id);
  assert.deepEqual(once, ["p:c", "p:b", "p:a"]);
  assert.deepEqual(reversed, once);
});

test("(ctxprev-12) rank: at most two notes per topic family; untopicked notes are never capped", () => {
  const notes = [
    ...[1, 2, 3, 4].map((i) => obs({ id: `p:sdd${i}`, type: "architecture", topicKey: `sdd/x/phase${i}`, updatedAt: T0 - i })),
    ...[1, 2, 3].map((i) => obs({ id: `p:free${i}`, type: "manual", updatedAt: T0 - 100 - i })),
  ];
  const ids = rankForContext(notes, { limit: 10 }).map((o) => o.id);
  assert.deepEqual(ids, ["p:sdd1", "p:sdd2", "p:free1", "p:free2", "p:free3"]);
  assert.equal(MAX_PER_TOPIC_PREFIX, 2);
});

test("(ctxprev-13) buildContextView: ranked previews carry shortId/status and the active total", () => {
  const view = buildContextView(
    {
      sessions: [],
      observations: [
        obs({ id: "p:manual:t:1:7e14a845_6f49_4901", type: "manual", updatedAt: T0 }),
        obs({ id: "p:decision:t:1:8daf3a77_484a_404b", type: "decision", updatedAt: T0 }),
        obs({ id: "p:x", status: "obsolete", updatedAt: T0 }),
      ],
    },
    { limit: 1 },
  );
  assert.equal(view.observations.length, 1);
  assert.equal(view.observations[0]!.shortId, "8daf3a77");
  assert.equal(view.observations[0]!.status, "active");
  assert.equal(view.activeTotal, 2);
  assert.equal(contextCountLabel(view), "1 of 2 active notes");
});

test("(ctxprev-14) text: header line with short id/date/topic, multi-line preview, ellipsis when cut", () => {
  const content = "# Cache plan\n\nWe invalidate on write.\nTTL is a fallback.\nThird line.\nFourth line is dropped.";
  const view = buildContextView(
    { sessions: [], observations: [obs({ id: "p:d:t:1:abcdef12_x", type: "decision", title: "Cache plan", topicKey: "sdd/cache/design", updatedAt: Date.UTC(2026, 6, 19), content })] },
    { previewChars: TEXT_PREVIEW_CHARS },
  );
  const [block] = renderContextNotes(view);
  assert.equal(
    block,
    "- [decision] Cache plan (#abcdef12 · 2026-07-19 · sdd/cache/design)\n" +
      "  We invalidate on write.\n  TTL is a fallback.\n  Third line.…",
    "title-only heading skipped, blank lines dropped, 3 lines kept, cut marked",
  );
});

test("(ctxprev-15) injection: header with counts, latest summarised session, notes, follow-up verbs; cap drops whole notes", () => {
  const view = buildContextView(
    {
      sessions: [
        session({ id: "s-open", startedAt: T0 }),
        session({ id: "s-done", startedAt: Date.UTC(2026, 6, 18), endedAt: Date.UTC(2026, 6, 18), summary: "Shipped   the\nlifecycle." }),
      ],
      observations: Array.from({ length: 12 }, (_, i) => obs({ id: `p:n${i}`, title: `note ${i}`, content: "x ".repeat(200), updatedAt: T0 - i })),
    },
    { previewChars: TEXT_PREVIEW_CHARS },
  );
  const text = renderMemoryInjection(view);
  assert.match(text, /^## Project memory — 10 of 12 active notes \(ranked by type and recency; resolved notes hidden\)\n/);
  assert.match(text, /\nLast session \(2026-07-18\): Shipped the lifecycle\.\n/);
  assert.equal((text.match(/^- \[manual\]/gm) ?? []).length, 10);
  assert.match(text, /leina memory resolve <dir> <id>/);

  const capped = renderMemoryInjection(view, { maxChars: 1200 });
  assert.ok(capped.length <= 1200, `within the cap (got ${capped.length})`);
  const shown = (capped.match(/^- \[manual\]/gm) ?? []).length;
  assert.ok(shown >= 1 && shown < 10, `whole notes dropped past the cap (kept ${shown})`);

  assert.equal(renderMemoryInjection(buildContextView({ sessions: [], observations: [] })), "## Project memory\n(no observations yet)");
});

test("(ctxprev-16) shortObservationId: 8 hex chars of the uuid tail, else the whole id", () => {
  assert.equal(shortObservationId("leina:decision:x:1792401045827:7e14a845_6f49_4901_8258_3c656d273081"), "7e14a845");
  assert.equal(shortObservationId("legacy:1"), "legacy:1");
  assert.equal(shortObservationId("plain"), "plain");
});
