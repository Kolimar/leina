// parse-remote.test.ts — unit tests for parseRemote and readProjectKeyFormat (T-12)
// Covers: multiple URL forms, B2 org/repo format, backward-compat repoNameFromRemote.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseRemote,
  repoNameFromRemote,
  readProjectKeyFormat,
} from "../src/application/project/detect-key.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "parse-remote-"));
}

// ---------------------------------------------------------------------------
// parseRemote — URL forms
// ---------------------------------------------------------------------------

test("(parseRemote-https) HTTPS with .git suffix → name + org", () => {
  const r = parseRemote("https://github.com/acme-corp/my-service.git");
  assert.ok(r, "should return ParsedRemote");
  assert.equal(r.name, "my-service");
  assert.equal(r.org, "acme-corp");
});

test("(parseRemote-https-no-git) HTTPS without .git suffix", () => {
  const r = parseRemote("https://github.com/acme-corp/my-service");
  assert.ok(r);
  assert.equal(r.name, "my-service");
  assert.equal(r.org, "acme-corp");
});

test("(parseRemote-scp-ssh) git@ SCP-like SSH URL", () => {
  const r = parseRemote("git@github.com:acme-corp/my-service.git");
  assert.ok(r);
  assert.equal(r.name, "my-service");
  assert.equal(r.org, "acme-corp");
});

test("(parseRemote-scp-ssh-no-org) git@ SCP-like SSH URL with no sub-path", () => {
  const r = parseRemote("git@github.com:my-service.git");
  assert.ok(r);
  assert.equal(r.name, "my-service");
});

test("(parseRemote-ssh-uri) ssh:// URI with port", () => {
  const r = parseRemote("ssh://git@git.company.com:22/org/my-repo.git");
  assert.ok(r);
  assert.equal(r.name, "my-repo");
});

test("(parseRemote-local-path) local path /repos/org/my-repo", () => {
  const r = parseRemote("/repos/org/my-repo");
  assert.ok(r);
  assert.equal(r.name, "my-repo");
});

test("(parseRemote-trailing-slash) trailing slashes stripped", () => {
  const r = parseRemote("https://github.com/org/repo///");
  assert.ok(r);
  assert.equal(r.name, "repo");
});

test("(parseRemote-empty) empty string → null", () => {
  assert.equal(parseRemote(""), null);
});

test("(parseRemote-whitespace) whitespace-only → null", () => {
  assert.equal(parseRemote("   "), null);
});

// ---------------------------------------------------------------------------
// Backward-compat: repoNameFromRemote wraps parseRemote.name
// ---------------------------------------------------------------------------

test("(repoNameFromRemote-compat) HTTPS URL returns only name, same as before", () => {
  const name = repoNameFromRemote("https://github.com/org/my-repo.git");
  assert.equal(name, "my-repo", "backward-compat: repoNameFromRemote must return the name segment");
});

test("(repoNameFromRemote-null) empty URL → null (backward-compat)", () => {
  assert.equal(repoNameFromRemote(""), null);
});

// ---------------------------------------------------------------------------
// readProjectKeyFormat
// ---------------------------------------------------------------------------

test("(readProjectKeyFormat-absent) no config.json → null", () => {
  const dir = tmpDir();
  try {
    assert.equal(readProjectKeyFormat(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(readProjectKeyFormat-default) config.json without the field → null", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(join(dir, ".leina", "config.json"), JSON.stringify({ project_name: "my-svc" }), "utf8");
    assert.equal(readProjectKeyFormat(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(readProjectKeyFormat-org-repo) project_key_format = org/repo → 'org/repo'", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(
      join(dir, ".leina", "config.json"),
      JSON.stringify({ project_key_format: "org/repo" }),
      "utf8",
    );
    assert.equal(readProjectKeyFormat(dir), "org/repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(readProjectKeyFormat-unknown-format) unknown value → null", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(
      join(dir, ".leina", "config.json"),
      JSON.stringify({ project_key_format: "custom" }),
      "utf8",
    );
    assert.equal(readProjectKeyFormat(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(readProjectKeyFormat-malformed-json) malformed config → null (fail-open)", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(join(dir, ".leina", "config.json"), "{ invalid json", "utf8");
    assert.equal(readProjectKeyFormat(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
