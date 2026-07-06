// serve-router.test.ts — unit/integration tests for the `graph serve` HTTP transport
// (task 3.4): cli/serve/router.ts + cli/serve/static.ts. Every test spins up a real
// node:http server on an ephemeral port (0 → OS assigns) and drives it with fetch,
// per the apply-progress instructions for this wave.
// Run: node --no-warnings --experimental-strip-types --test test/serve-router.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { createRouter, type RouterDeps } from "../src/cli/serve/router.ts";
import { resolveStaticPath } from "../src/cli/serve/static.ts";
import { MAX_RESPONSE_BYTES, sendJson } from "../src/cli/serve/json.ts";

function tmpAssetsRoot(files: Record<string, string> = { "index.html": "<html>ok</html>" }): string {
  const dir = mkdtempSync(join(tmpdir(), "leina-serve-assets-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
  return dir;
}

/**
 * fetch()/the WHATWG URL parser both collapse "../" AND their percent-encoded form
 * ("%2e%2e") client-side before a request ever leaves the process — the URL Standard
 * explicitly special-cases %2e as a dot for path-segment normalization. That's a real
 * defense-in-depth layer, but it means neither form can reach the server verbatim
 * through fetch, so the traversal guard itself can only be exercised over the wire with
 * a raw request line. node:http's `path` option is NOT normalized — it's written
 * straight into the request line — which is exactly what's needed here.
 */
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

interface ServerHandle {
  baseUrl: string;
  port: number;
}

async function withServer<T>(
  deps: RouterDeps,
  use: (server: ServerHandle) => Promise<T>,
): Promise<T> {
  const server: Server = createServer(createRouter(deps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no server address");
  try {
    return await use({ baseUrl: `http://127.0.0.1:${addr.port}`, port: addr.port });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Method gate — NFR-02: read-only API, non-GET → 405
// ---------------------------------------------------------------------------

test("(sr-1) POST/PUT/DELETE → 405 METHOD_NOT_ALLOWED, GET unaffected", async () => {
  const assetsRoot = tmpAssetsRoot();
  try {
    await withServer({ assetsRoot }, async ({ baseUrl: base }) => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const res = await fetch(`${base}/api/projects`, { method });
        assert.equal(res.status, 405, method);
        const body = (await res.json()) as { error: { code: string } };
        assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
      }
      const ok = await fetch(`${base}/api/projects`);
      assert.equal(ok.status, 200);
    });
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Token auth — FR-05: constant-time compare, 401 on missing/invalid, no token → open
// ---------------------------------------------------------------------------

test("(sr-2) no token configured → every request processes normally", async () => {
  const assetsRoot = tmpAssetsRoot();
  try {
    await withServer({ assetsRoot }, async ({ baseUrl: base }) => {
      const res = await fetch(`${base}/api/projects`);
      assert.equal(res.status, 200);
    });
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("(sr-3) token configured: missing/invalid → 401, valid header → 200", async () => {
  const assetsRoot = tmpAssetsRoot();
  try {
    await withServer({ assetsRoot, token: "s3cr3t" }, async ({ baseUrl: base }) => {
      const noToken = await fetch(`${base}/api/projects`);
      assert.equal(noToken.status, 401);
      const bad = (await noToken.json()) as { error: { code: string } };
      assert.equal(bad.error.code, "UNAUTHORIZED");

      const wrong = await fetch(`${base}/api/projects`, { headers: { authorization: "Bearer nope" } });
      assert.equal(wrong.status, 401);

      const okHeader = await fetch(`${base}/api/projects`, { headers: { authorization: "Bearer s3cr3t" } });
      assert.equal(okHeader.status, 200);

      const okQuery = await fetch(`${base}/api/projects?token=s3cr3t`);
      assert.equal(okQuery.status, 200);
    });
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path traversal guard — static.ts (task 3.4)
// ---------------------------------------------------------------------------

test("(sr-4) resolveStaticPath rejects ../ traversal, encoded traversal and NUL bytes", () => {
  const root = "/srv/graph-ui";
  assert.equal(resolveStaticPath(root, "/../../etc/passwd"), null);
  assert.equal(resolveStaticPath(root, "/..%2f..%2fetc%2fpasswd"), null);
  assert.equal(resolveStaticPath(root, "/%2e%2e/%2e%2e/etc/passwd"), null);
  assert.equal(resolveStaticPath(root, "/foo\0bar"), null);
  assert.equal(resolveStaticPath(root, "/%"), null, "malformed percent-encoding rejected");
});

test("(sr-5) resolveStaticPath accepts paths that stay inside root", () => {
  const root = "/srv/graph-ui";
  // Expected via resolve() (NOT join()): the source anchors root with path.resolve(),
  // which on Windows prepends the current drive (e.g. `D:\srv\graph-ui`). join() would
  // omit the drive and diverge from the actual only on win32. On POSIX the two agree.
  assert.equal(resolveStaticPath(root, "/"), resolve(root, "index.html"));
  assert.equal(resolveStaticPath(root, "/app.js"), resolve(root, "app.js"));
  assert.equal(resolveStaticPath(root, "/sub/dir/file.css"), resolve(root, "sub", "dir", "file.css"));
});

test("(sr-6) HTTP: literal and percent-encoded traversal on the wire never escapes root", async () => {
  const assetsRoot = tmpAssetsRoot();
  try {
    await withServer({ assetsRoot }, async ({ port }) => {
      // router.ts derives the request path via `new URL(req.url, base)` — and the WHATWG
      // URL Standard ITSELF collapses dot-segments during parsing (both literal ".." and
      // its percent-encoded form: %2e is explicitly special-cased as a dot). So by the
      // time resolveStaticPath() ever sees a path, traversal segments are already gone —
      // "/../../../../etc/passwd" normalizes to "/etc/passwd" before routing. That's an
      // extra layer on top of resolveStaticPath()'s own guard (proven directly by
      // sr-4/sr-5, which bypass this normalization to test the guard in isolation): the
      // request lands on a path INSIDE assetsRoot (never outside it) that simply doesn't
      // exist there, so the observable behaviour on the wire is 404 (asset not found) —
      // crucially NEVER 200 with the traversed file's content.
      for (const rawPath of ["/../../../../etc/passwd", "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd"]) {
        const res = await rawGet(port, rawPath);
        assert.notEqual(res.status, 200, rawPath);
        assert.equal(res.status, 404, rawPath);
        assert.doesNotMatch(res.body, /root:/, "must never leak /etc/passwd content");
      }
    });
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("(sr-7) HTTP: static index.html served at '/', unknown asset → 404", async () => {
  const assetsRoot = tmpAssetsRoot({ "index.html": "<html>hi</html>", "app.js": "console.log(1)" });
  try {
    await withServer({ assetsRoot }, async ({ baseUrl: base }) => {
      const idx = await fetch(`${base}/`);
      assert.equal(idx.status, 200);
      assert.equal(await idx.text(), "<html>hi</html>");
      assert.match(idx.headers.get("content-type") ?? "", /text\/html/);

      const js = await fetch(`${base}/app.js`);
      assert.equal(js.status, 200);
      assert.match(js.headers.get("content-type") ?? "", /javascript/);

      const missing = await fetch(`${base}/nope.html`);
      assert.equal(missing.status, 404);

      // Extension not in the whitelist → 404, not 200/403 (no existence leak).
      const disallowed = await fetch(`${base}/secret.env`);
      assert.equal(disallowed.status, 404);
    });
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unknown API route + response size cap
// ---------------------------------------------------------------------------

test("(sr-8) unknown /api/ route → 404 NOT_FOUND", async () => {
  const assetsRoot = tmpAssetsRoot();
  try {
    await withServer({ assetsRoot }, async ({ baseUrl: base }) => {
      const res = await fetch(`${base}/api/nope`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, "NOT_FOUND");
    });
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Frontend (wave 5): the real assets/graph-ui tree + the vendored vis-network route
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_GRAPH_UI_ROOT = join(REPO_ROOT, "assets", "graph-ui");
const REAL_VIS_NETWORK_ROOT = join(REPO_ROOT, "assets", "vis-network");

test("(sr-10) real assets/graph-ui: index/app.js/lib.js/style.css all serve 200 with the right MIME", async () => {
  await withServer({ assetsRoot: REAL_GRAPH_UI_ROOT }, async ({ baseUrl: base }) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await index.text(), /<title>/);

    const app = await fetch(`${base}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") ?? "", /javascript/);

    const lib = await fetch(`${base}/lib.js`);
    assert.equal(lib.status, 200);
    assert.match(lib.headers.get("content-type") ?? "", /javascript/);

    const css = await fetch(`${base}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  });
});

test("(sr-11) /vendor/vis-network.min.js serves the vendored bundle when visNetworkRoot is wired", async () => {
  await withServer(
    { assetsRoot: REAL_GRAPH_UI_ROOT, visNetworkRoot: REAL_VIS_NETWORK_ROOT },
    async ({ baseUrl: base }) => {
      const res = await fetch(`${base}/vendor/vis-network.min.js`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /javascript/);
      const body = await res.text();
      assert.ok(body.length > 1000, "should serve the actual vis-network bundle, not a stub");
    },
  );
});

test("(sr-12) /vendor/vis-network.min.js 404s when visNetworkRoot isn't configured (no zero-config path traversal surface)", async () => {
  await withServer({ assetsRoot: REAL_GRAPH_UI_ROOT }, async ({ baseUrl: base }) => {
    const res = await fetch(`${base}/vendor/vis-network.min.js`);
    assert.equal(res.status, 404);
  });
});

test("(sr-13) sendJson: response over the size cap → 500 RESPONSE_TOO_LARGE, not the oversized body", () => {
  const written: { status?: number; body?: string } = {};
  const fakeRes = {
    writeHead(status: number) {
      written.status = status;
      return fakeRes;
    },
    end(payload: string) {
      written.body = payload;
    },
  } as unknown as ServerResponse;

  sendJson(fakeRes, 200, { blob: "x".repeat(MAX_RESPONSE_BYTES + 1) });

  assert.equal(written.status, 500);
  const parsed = JSON.parse(written.body ?? "{}") as { error: { code: string } };
  assert.equal(parsed.error.code, "RESPONSE_TOO_LARGE");
});
