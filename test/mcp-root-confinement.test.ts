// mcp-root-confinement.test.ts — the MCP `root` argument confinement (SEC).
//
// `root` arrives from the MODEL, so under prompt injection it is attacker-controlled:
// unconfined it allows cross-project reads (graph_query/context_build on a foreign
// root), harness_verify against an attacker-staged repo, and consent lookups on roots
// that never opted in. confineRoot must keep every root inside the server cwd unless
// LEINA_MCP_ALLOW_ROOTS explicitly allow-lists an external path.
//
// confineRoot takes cwd, the allow-list AND the realpath function as inputs. The
// lexical tests (root-1..6) use paths that do not exist, so they exercise the
// nearest-existing-ancestor canonicalisation; the symlink tests inject a fake realpath
// (root-7..11) and finish with one real-filesystem check (root-12).
//
// Run: node --no-warnings --experimental-strip-types --test test/mcp-root-confinement.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ---------------------------------------------------------------------------
// Symlink-aware confinement. A purely lexical check is fooled by a symlink INSIDE the
// workspace that points outside it (a cloned repo can ship `rootlink -> /`): the path
// string stays under cwd while every file operation lands elsewhere. confineRoot
// therefore canonicalises cwd, root and allow-list entries through realpath first.
// ---------------------------------------------------------------------------

/** Fake realpath for the pure tests: `links` maps a path prefix to its real target,
 *  `missing` paths do not exist (→ undefined), `broken` paths cannot be resolved. */
function fakeReal(opts: {
  links?: Record<string, string>;
  missing?: string[];
  broken?: string[];
}): (p: string) => string | undefined {
  return (p) => {
    if (opts.broken?.includes(p)) throw new Error(`ENOENT: dangling link ${p}`);
    if (opts.missing?.includes(p)) return undefined;
    for (const [from, to] of Object.entries(opts.links ?? {})) {
      if (p === from) return to;
      if (p.startsWith(from + path.sep)) return to + p.slice(from.length);
    }
    return p;
  };
}

test("(root-7) a symlink inside cwd that points outside it is rejected", () => {
  const link = path.join(CWD, "rootlink");
  const real = fakeReal({ links: { [link]: path.resolve(path.sep, "etc") } });
  assert.throws(() => confineRoot("rootlink", CWD, undefined, real), /outside the server workspace/);
  assert.throws(
    () => confineRoot(path.join("rootlink", "ssl"), CWD, undefined, real),
    /outside the server workspace/,
  );
  // The error names where the root actually resolves, not just what was asked for.
  assert.throws(() => confineRoot("rootlink", CWD, undefined, real), /resolves to/);
});

test("(root-8) symlinks that stay inside cwd are accepted and the CANONICAL path is returned", () => {
  const target = path.join(CWD, "packages", "app");
  const real = fakeReal({ links: { [path.join(CWD, "alias")]: target } });
  assert.equal(confineRoot("alias", CWD, undefined, real), target);
  // A cwd reached through a symlink is compared on its canonical form too.
  const linkedCwd = path.resolve(path.sep, "home", "me", "repo-link");
  const real2 = fakeReal({ links: { [linkedCwd]: CWD } });
  assert.equal(confineRoot(path.join(CWD, "src"), linkedCwd, undefined, real2), path.join(CWD, "src"));
});

test("(root-9) a not-yet-created root canonicalises through its nearest existing ancestor", () => {
  const link = path.join(CWD, "rootlink");
  const fresh = path.join(CWD, "new", "pkg");
  const real = fakeReal({
    links: { [link]: path.resolve(path.sep, "elsewhere") },
    missing: [fresh, path.join(CWD, "new"), path.join(link, "x", "y"), path.join(link, "x")],
  });
  assert.equal(confineRoot(path.join("new", "pkg"), CWD, undefined, real), fresh);
  // A missing tail below an escaping link still escapes.
  assert.throws(
    () => confineRoot(path.join("rootlink", "x", "y"), CWD, undefined, real),
    /outside the server workspace/,
  );
});

test("(root-10) an unresolvable root (dangling link, loop, EACCES) is rejected, never guessed", () => {
  const real = fakeReal({ broken: [path.join(CWD, "dangle")] });
  assert.throws(() => confineRoot("dangle", CWD, undefined, real), /cannot be resolved/);
});

test("(root-11) allow-list entries are canonicalised and cannot be escaped through a link", () => {
  const allowed = path.resolve(path.sep, "srv", "other-project");
  const allowedAlias = path.resolve(path.sep, "mnt", "other-alias");
  const escape = path.join(allowed, "evil-link");
  const real = fakeReal({
    links: { [allowedAlias]: allowed, [escape]: path.resolve(path.sep, "etc") },
  });
  // An entry spelled through an alias admits its canonical target.
  assert.equal(confineRoot(allowed, CWD, allowedAlias, real), allowed);
  // A link inside an allowed root that points elsewhere is still rejected.
  assert.throws(() => confineRoot(escape, CWD, allowed, real), /outside the server workspace/);
});

test("(root-12) real filesystem: escaping, dangling and inner symlinks", (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "leina-root-")));
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(ws, "pkg"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  try {
    try {
      symlinkSync(outside, path.join(ws, "rootlink"), "dir");
      symlinkSync(path.join(ws, "pkg"), path.join(ws, "inner"), "dir");
      symlinkSync(path.join(base, "gone", "x"), path.join(ws, "dangle"), "dir");
      symlinkSync(ws, path.join(base, "ws-link"), "dir");
    } catch {
      t.skip("symlinks unavailable on this platform/user");
      return;
    }
    assert.throws(() => confineRoot("rootlink", ws), /outside the server workspace/);
    assert.throws(() => confineRoot(path.join("rootlink", "not-yet"), ws), /outside the server workspace/);
    // mkdir -p through a dangling link would create the target wherever it points.
    assert.throws(() => confineRoot("dangle", ws), /cannot be resolved/);
    assert.equal(confineRoot("inner", ws), path.join(ws, "pkg"));
    assert.equal(
      confineRoot(path.join("pkg", "not-yet", "deeper"), ws),
      path.join(ws, "pkg", "not-yet", "deeper"),
    );
    // A server launched from a symlinked path to the workspace accepts the real paths.
    assert.equal(confineRoot(path.join(ws, "pkg"), path.join(base, "ws-link")), path.join(ws, "pkg"));
    // The explicit allow-list still opens the outside dir on purpose.
    assert.equal(confineRoot("rootlink", ws, outside), outside);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
