// graph-ui-lib.test.ts — unit tests for the pure, DOM-free helpers in
// assets/graph-ui/lib.js (tasks 4.1-4.5: the graph explorer frontend, design §6 "vanilla
// SIN build"). lib.js ships to the browser exactly as written (no compile step), so it's
// imported here via a *computed* dynamic import path — a string literal specifier would
// make tsc try to resolve/typecheck a plain .js module outside the `src/`/`test/`
// TypeScript program (it has no .d.ts by design); a runtime-computed path sidesteps that
// static resolution entirely and the module is exercised exactly as the browser sees it.
//
// Run: node --no-warnings --experimental-strip-types --test test/graph-ui-lib.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const LIB_PATH = join(fileURLToPath(new URL("..", import.meta.url)), "assets", "graph-ui", "lib.js");
const lib = await import(pathToFileURL(LIB_PATH).href);

// ---------------------------------------------------------------------------
// decodeHtmlEntities — inverse of html-export.ts's escapeHtml()
// ---------------------------------------------------------------------------

test("(gl-1) decodeHtmlEntities reverses escapeHtml's 5 entities", () => {
  assert.equal(lib.decodeHtmlEntities("AT&amp;T"), "AT&T");
  assert.equal(lib.decodeHtmlEntities("&lt;Foo&gt;"), "<Foo>");
  assert.equal(lib.decodeHtmlEntities("&quot;quoted&quot;"), "\"quoted\"");
  assert.equal(lib.decodeHtmlEntities("it&#39;s"), "it's");
  assert.equal(lib.decodeHtmlEntities("plain text"), "plain text");
});

test("(gl-2) decodeHtmlEntities round-trips a string containing every special char", () => {
  const original = "<script>alert('x')</script> & \"quotes\"";
  // Manual mirror of html-export.ts's escapeHtml() replaceAll order (&, <, >, ", ').
  const escaped = original
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
  assert.equal(lib.decodeHtmlEntities(escaped), original);
});

test("(gl-3) decodeHtmlEntities passes non-strings through untouched", () => {
  assert.equal(lib.decodeHtmlEntities(undefined), undefined);
  assert.equal(lib.decodeHtmlEntities(null), null);
  assert.equal(lib.decodeHtmlEntities(42), 42);
});

// ---------------------------------------------------------------------------
// driftBadge — FR-12 badge states
// ---------------------------------------------------------------------------

test("(gl-4) driftBadge maps usable/warning/do_not_use to distinct labels+classes", () => {
  assert.deepEqual(lib.driftBadge("usable"), { label: "usable", className: "badge-usable" });
  assert.deepEqual(lib.driftBadge("warning"), { label: "warning", className: "badge-warning" });
  assert.deepEqual(lib.driftBadge("do_not_use"), { label: "no usar", className: "badge-danger" });
});

test("(gl-5) driftBadge handles an unknown/missing verdict explicitly (not silently 'usable')", () => {
  const unknown = lib.driftBadge("something-new");
  assert.equal(unknown.className, "badge-unknown");
  assert.equal(unknown.label, "something-new");

  const missing = lib.driftBadge(undefined);
  assert.equal(missing.className, "badge-unknown");
  assert.equal(missing.label, "desconocido");
});

// ---------------------------------------------------------------------------
// colorForKind — deterministic per-kind colour (FR-09)
// ---------------------------------------------------------------------------

test("(gl-6) colorForKind is deterministic and returns a hex colour", () => {
  const a = lib.colorForKind("function");
  const b = lib.colorForKind("function");
  assert.equal(a, b);
  assert.match(a, /^#[0-9a-f]{6}$/i);
});

test("(gl-7) colorForKind falls back to a stable colour for missing/unknown kind", () => {
  assert.equal(lib.colorForKind(undefined), lib.colorForKind(""));
  assert.match(lib.colorForKind(undefined), /^#[0-9a-f]{6}$/i);
});

// ---------------------------------------------------------------------------
// folderMatches / isOutsideFolder — FR-10
// ---------------------------------------------------------------------------

test("(gl-8) folderMatches: no filter always matches", () => {
  assert.equal(lib.folderMatches("src/domain/model.ts", ""), true);
  assert.equal(lib.folderMatches("src/domain/model.ts", undefined), true);
});

test("(gl-9) folderMatches: file must be under the folder, not merely name-prefixed", () => {
  assert.equal(lib.folderMatches("src/domain/model.ts", "src/domain"), true);
  assert.equal(lib.folderMatches("src/domain/nested/deep.ts", "src/domain"), true);
  assert.equal(lib.folderMatches("src/domain-extra/model.ts", "src/domain"), false, "must not match sibling 'domain-extra'");
  assert.equal(lib.folderMatches("src/application/model.ts", "src/domain"), false);
});

test("(gl-10) isOutsideFolder is the exact negation of folderMatches", () => {
  assert.equal(lib.isOutsideFolder("src/domain/model.ts", "src/domain"), false);
  assert.equal(lib.isOutsideFolder("src/application/model.ts", "src/domain"), true);
});

// ---------------------------------------------------------------------------
// vis-network dataset builders
// ---------------------------------------------------------------------------

test("(gl-11) buildNodeFromSearchResult carries id/label/_kind/_file straight through (raw, unescaped payload)", () => {
  const node = lib.buildNodeFromSearchResult({ id: "n1", label: "MyClass", kind: "class", file: "src/a.ts" });
  assert.deepEqual(node, { id: "n1", label: "MyClass", _kind: "class", _file: "src/a.ts" });
});

test("(gl-12) buildNodeFromSearchResult defaults missing label/kind/file", () => {
  const node = lib.buildNodeFromSearchResult({ id: "n1" });
  assert.equal(node.label, "n1");
  assert.equal(node._kind, "unknown");
  assert.equal(node._file, "");
});

test("(gl-13) buildNodeFromDetail decodes the HTML-escaped node-detail fields", () => {
  const node = lib.buildNodeFromDetail("n1", {
    label: "AT&amp;T &lt;Corp&gt;",
    kind: "class",
    file: "src/a&amp;b.ts",
  });
  assert.equal(node.id, "n1");
  assert.equal(node.label, "AT&T <Corp>");
  assert.equal(node._kind, "class");
  assert.equal(node._file, "src/a&b.ts");
});

test("(gl-14) buildEdgeFromRef points from the ref (declarer/caller) to the centre node", () => {
  const edge = lib.buildEdgeFromRef("center1", { id: "caller1", label: "foo", kind: "function", file: "a.ts", relation: "calls" });
  assert.equal(edge.from, "caller1");
  assert.equal(edge.to, "center1");
  assert.equal(edge.label, "calls");
  assert.equal(edge._relation, "calls");
  assert.equal(edge.id, "caller1->center1:calls");
});

// ---------------------------------------------------------------------------
// URL state — FR-08
// ---------------------------------------------------------------------------

test("(gl-15) parseUrlState reads project/node/token, omitting absent fields", () => {
  assert.deepEqual(lib.parseUrlState("?project=demo&node=abc"), { project: "demo", node: "abc" });
  assert.deepEqual(lib.parseUrlState(""), {});
  assert.deepEqual(lib.parseUrlState("?token=s3cr3t"), { token: "s3cr3t" });
});

test("(gl-16) buildUrlQuery/parseUrlState round-trip", () => {
  const state = { project: "demo-project", node: "n:1", token: undefined };
  const qs = lib.buildUrlQuery(state);
  assert.match(qs, /^\?/);
  const parsed = lib.parseUrlState(qs);
  assert.equal(parsed.project, "demo-project");
  assert.equal(parsed.node, "n:1");
  assert.equal(parsed.token, undefined);
});

test("(gl-17) buildUrlQuery returns empty string when nothing to represent", () => {
  assert.equal(lib.buildUrlQuery({}), "");
  assert.equal(lib.buildUrlQuery({ project: "", node: "" }), "");
});
