// Unit tests for normalizeProjectKey — pure function, zero I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeProjectKey } from "../../src/application/project/detect-key.ts";

test("normalizeProjectKey: lowercases and hyphenates", () => {
  assert.equal(normalizeProjectKey("My-Cool-Project"), "my-cool-project");
});

test("normalizeProjectKey: collapses non-alphanumeric runs to hyphens", () => {
  assert.equal(normalizeProjectKey("foo___bar!!!baz"), "foo-bar-baz");
});

test("normalizeProjectKey: path separators become hyphens", () => {
  assert.equal(normalizeProjectKey("org/repo/name"), "org-repo-name");
  assert.equal(normalizeProjectKey("C:\\Users\\project"), "c-users-project");
});

test("normalizeProjectKey: trims leading and trailing hyphens", () => {
  assert.equal(normalizeProjectKey("--trimmed--"), "trimmed");
});

test("normalizeProjectKey: empty string returns fallback 'project'", () => {
  assert.equal(normalizeProjectKey(""), "project");
  assert.equal(normalizeProjectKey("---"), "project");
});

test("normalizeProjectKey: NFKC normalization applied", () => {
  // ﬁ (U+FB01 ligature) → "fi" under NFKC
  assert.equal(normalizeProjectKey("ﬁle-test"), "file-test");
});

test("normalizeProjectKey: git URL-style names", () => {
  assert.equal(
    normalizeProjectKey("github.com/acme/leina"),
    "github-com-acme-leina",
  );
});

test("normalizeProjectKey: preserves digits", () => {
  assert.equal(normalizeProjectKey("project-v2.1"), "project-v2-1");
});
