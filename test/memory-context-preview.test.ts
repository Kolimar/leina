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
  DEFAULT_PREVIEW_CHARS,
  previewRecentContext,
} from "../src/application/memory/context-preview.ts";
import type { Observation, Session } from "../src/domain/memory/model.ts";

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
