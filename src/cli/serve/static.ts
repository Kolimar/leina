// cli/serve/static.ts — static asset server for the `graph serve` frontend
// (assets/graph-ui/, wave 4 — this wave only wires the transport, the tree may still
// be empty/absent). GET-only (enforced by router.ts), read-only, no directory listing.
//
// Security (design §7 / task 3.4): every request path is resolved against `assetsRoot`
// and the result MUST stay inside it — rejects `../`, absolute paths that escape via
// `resolve()`, percent-encoded traversal (`%2e%2e`), and embedded NUL bytes. Only a
// whitelisted set of extensions is ever served; anything else (including directories
// other than the root) 404s rather than leaking existence.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve as resolvePath, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { sendApiError } from "./json.ts";

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Resolve a raw (still percent-encoded) request path against `root`, returning the
 * absolute filesystem path or `null` when the request is malformed or would escape
 * `root`. Pure — no fs access here, only string/path math.
 */
export function resolveStaticPath(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null; // malformed percent-encoding (e.g. a lone "%")
  }
  if (decoded.includes("\0")) return null; // embedded NUL — never a legitimate asset path

  const rel = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  const rootResolved = resolvePath(root);
  const target = resolvePath(rootResolved, rel);

  // Traversal guard: the resolved target MUST be the root itself or a path strictly
  // inside it. `resolve()` already collapses ".." segments, so this catches both
  // `../../etc/passwd` and the fully-decoded form of `%2e%2e%2f%2e%2e%2fetc%2fpasswd`.
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) return null;
  return target;
}

/** Serve `pathname` from `assetsRoot`. Assumes the caller already enforced GET-only. */
export function serveStatic(assetsRoot: string, pathname: string, res: ServerResponse): void {
  const target = resolveStaticPath(assetsRoot, pathname);
  if (!target) {
    sendApiError(res, 400, "BAD_PATH", "malformed or unsafe request path");
    return;
  }

  const ext = extname(target);
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    // Unknown/unlisted extension — 404 rather than 403 so a probe can't distinguish
    // "exists but forbidden" from "doesn't exist".
    sendApiError(res, 404, "NOT_FOUND", "no such asset");
    return;
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    sendApiError(res, 404, "NOT_FOUND", "no such asset");
    return;
  }

  const body = readFileSync(target);
  res.writeHead(200, { "content-type": mime, "content-length": body.length });
  res.end(body);
}
