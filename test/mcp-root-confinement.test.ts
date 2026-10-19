// mcp-root-confinement.test.ts — the MCP `root` argument confinement (SEC).
//
// `root` arrives from the MODEL, so under prompt injection it is attacker-controlled:
// unconfined it allows cross-project reads (graph_query/context_build on a foreign
// root), harness_verify against an attacker-staged repo, and consent lookups on roots
// that never opted in. confineRoot must keep every root inside the server cwd unless
// LEINA_MCP_ALLOW_ROOTS explicitly allow-lists an external path.
//
// confineRoot is pure (cwd + allow-list injected), so these tests need no real
// directories — only path arithmetic.
//
// Run: node --no-warnings --experimental-strip-types --test test/mcp-root-confinement.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { confineRoot } from "../src/cli/handlers/mcp.ts";

const CWD = path.resolve(path.sep, "srv", "workspace", "repo");

test("(root-1) default '.' and the cwd itself resolve to the server cwd", () => {
  assert.equal(confineRoot(undefined, CWD), CWD);
  assert.equal(confineRoot(".", CWD), CWD);
  assert.equal(confineRoot(CWD, CWD), CWD);
});

test("(root-2) subdirectories of cwd are allowed (relative and absolute forms)", () => {
  const sub = path.join(CWD, "packages", "app");
  assert.equal(confineRoot(path.join("packages", "app"), CWD), sub);
  assert.equal(confineRoot(sub, CWD), sub);
  // Normalised traversal that stays inside cwd is fine too.
  assert.equal(confineRoot(path.join("packages", "..", "packages", "app"), CWD), sub);
});

test("(root-3) roots outside cwd are rejected with an explanatory error", () => {
  const outside = [
    "..",
    path.join("..", "other"),
    path.resolve(path.sep, "etc"),
    path.resolve(path.sep, "srv", "workspace", "other-repo"),
    // Traversal that escapes and comes back elsewhere.
    path.join("..", "..", "somewhere"),
  ];
  for (const bad of outside) {
    assert.throws(
      () => confineRoot(bad, CWD),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /outside the server workspace/, "explains the why");
        assert.match(err.message, /LEINA_MCP_ALLOW_ROOTS/, "explains the escape hatch");
        return true;
      },
      `"${bad}" must be rejected`,
    );
  }
});

test("(root-4) a sibling sharing cwd as a string prefix is still outside", () => {
  // "/srv/workspace/repo-evil" starts with "/srv/workspace/repo" as a STRING but is
  // not inside it — the path.relative-based check must not fall for prefix collisions.
  assert.throws(() => confineRoot(`${CWD}-evil`, CWD), /outside the server workspace/);
});

test("(root-5) LEINA_MCP_ALLOW_ROOTS admits listed paths and their subdirectories", () => {
  const other = path.resolve(path.sep, "srv", "other-project");
  const third = path.resolve(path.sep, "srv", "third");
  // ':' PATH-style separator (path.delimiter on POSIX).
  assert.equal(confineRoot(other, CWD, `${other}${path.delimiter}${third}`), other);
  // ',' separator.
  assert.equal(confineRoot(third, CWD, `${other},${third}`), third);
  // A subdirectory of an allowed root is inside the allowance.
  const inside = path.join(other, "sub", "dir");
  assert.equal(confineRoot(inside, CWD, other), inside);
  // Whitespace around entries is tolerated.
  assert.equal(confineRoot(other, CWD, ` ${other} , ${third} `), other);
});

test("(root-6) the allow-list does not open unlisted or prefix-colliding paths", () => {
  const other = path.resolve(path.sep, "srv", "other-project");
  const unlisted = path.resolve(path.sep, "srv", "unlisted");
  assert.throws(() => confineRoot(unlisted, CWD, other), /outside the server workspace/);
  // Allowing /srv/other-project must NOT allow /srv/other-project-evil.
  assert.throws(() => confineRoot(`${other}-evil`, CWD, other), /outside the server workspace/);
  // Blank/whitespace-only entries are ignored, never treated as wildcards.
  assert.throws(
    () => confineRoot(unlisted, CWD, ` ${path.delimiter} , `),
    /outside the server workspace/,
  );
  // An empty allow-list changes nothing.
  assert.throws(() => confineRoot(unlisted, CWD, ""), /outside the server workspace/);
});
