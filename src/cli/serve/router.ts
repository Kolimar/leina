// cli/serve/router.ts — the `graph serve` HTTP router (task 3.4): a plain `node:http`
// request listener, no framework. Every request goes through, in order:
//   1. method gate (GET only — NFR-02: the API is read-only, non-GET → 405)
//   2. optional token auth (constant-time compare — FR-05)
//   3. dispatch: `/api/*` → handlers.ts, everything else → static.ts (assets/graph-ui)
// Errors everywhere use the FR-07 envelope (`{error:{code,message}}`), including for the
// static path — see json.ts.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as api from "./handlers.ts";
import { sendApiError, sendJson } from "./json.ts";
import { serveStatic } from "./static.ts";

export interface RouterDeps {
  /** Absent → no auth required (FR-05: "sin token configurado, procesa normal"). */
  token?: string;
  /** Root dir the frontend (assets/graph-ui) is served from. */
  assetsRoot: string;
  /**
   * Root dir the vendored `vis-network.min.js` lives in (assets/vis-network — the same
   * single copy `graph visualize`/`audit` already reuse). Optional so router tests that
   * don't care about the UI's third-party dependency don't need to wire it up; when
   * absent, the one path that would serve it (`/vendor/vis-network.min.js`) just 404s.
   * Kept OUTSIDE `assetsRoot` on purpose: `assetsRoot` stays scoped tight to
   * `assets/graph-ui` (design §7), so this is a second, narrower static root rather than
   * widening the traversal-guarded surface of the main one.
   */
  visNetworkRoot?: string;
}

const VIS_NETWORK_ROUTE = "/vendor/vis-network.min.js";

const DEFAULT_MEMORIES_LIMIT = 10;

/**
 * Constant-time token compare (FR-05/NFR-02). Buffers of different lengths can't be fed
 * to `timingSafeEqual` (it throws), and the length itself isn't the secret being
 * protected — only the token's actual bytes are — so a length mismatch short-circuits to
 * `false` without ever touching the real comparison. This is the standard shape of this
 * check (e.g. mirrored by most constant-time-compare middleware in the ecosystem).
 */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractToken(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return url.searchParams.get("token") ?? undefined;
}

function respond(res: ServerResponse, result: api.ApiResult): void {
  if (result.ok) {
    sendJson(res, 200, result.body);
    return;
  }
  sendApiError(res, result.status, result.code, result.message);
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_MEMORIES_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MEMORIES_LIMIT;
}

/**
 * Dispatch every `/api/...` path. Segment-based matching (no path-to-regexp dependency —
 * NFR-03 forbids new production deps) against the exact 6-route table of FR-06.
 */
function routeApi(pathname: string, url: URL, res: ServerResponse): void {
  const segs = pathname.split("/").filter(Boolean); // "/api/projects" -> ["api","projects"]

  if (segs.length === 2 && segs[1] === "projects") {
    respond(res, api.listProjects());
    return;
  }

  if (segs.length >= 3 && segs[1] === "projects") {
    let key: string;
    try {
      key = decodeURIComponent(segs[2]!);
    } catch {
      sendApiError(res, 400, "BAD_PATH", "malformed project key");
      return;
    }

    if (segs.length === 4 && segs[3] === "stats") {
      respond(res, api.getStats(key));
      return;
    }
    if (segs.length === 4 && segs[3] === "tree") {
      respond(res, api.getTree(key));
      return;
    }
    if (segs.length === 4 && segs[3] === "search") {
      respond(res, api.getSearch(key, url.searchParams.get("q") ?? ""));
      return;
    }
    if (segs.length >= 5 && segs[3] === "nodes") {
      let nodeId: string;
      try {
        nodeId = decodeURIComponent(segs[4]!);
      } catch {
        sendApiError(res, 400, "BAD_PATH", "malformed node id");
        return;
      }
      if (segs.length === 5) {
        respond(res, api.getNodeDetail(key, nodeId));
        return;
      }
      if (segs.length === 6 && segs[5] === "memories") {
        respond(res, api.getNodeMemories(key, nodeId, parseLimit(url.searchParams.get("limit"))));
        return;
      }
    }
  }

  sendApiError(res, 404, "NOT_FOUND", `no such API route: ${pathname}`);
}

function handleRequest(req: IncomingMessage, res: ServerResponse, deps: RouterDeps): void {
  if (req.method !== "GET") {
    sendApiError(res, 405, "METHOD_NOT_ALLOWED", `method "${req.method ?? "?"}" not allowed — this API is read-only`);
    return;
  }

  const url = new URL(req.url ?? "/", "http://internal.invalid");

  if (deps.token !== undefined) {
    const provided = extractToken(req, url);
    if (provided === undefined || !tokenMatches(deps.token, provided)) {
      sendApiError(res, 401, "UNAUTHORIZED", "missing or invalid token");
      return;
    }
  }

  if (url.pathname.startsWith("/api/")) {
    routeApi(url.pathname, url, res);
    return;
  }

  if (url.pathname === VIS_NETWORK_ROUTE) {
    if (!deps.visNetworkRoot) {
      sendApiError(res, 404, "NOT_FOUND", "no such asset");
      return;
    }
    serveStatic(deps.visNetworkRoot, "/vis-network.min.js", res);
    return;
  }

  serveStatic(deps.assetsRoot, url.pathname, res);
}

/** Build the `node:http` request listener for `graph serve`. */
export function createRouter(deps: RouterDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    try {
      handleRequest(req, res, deps);
    } catch (err) {
      sendApiError(res, 500, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
  };
}
