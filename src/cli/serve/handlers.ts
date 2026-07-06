// cli/serve/handlers.ts — the 6 JSON API endpoints of `graph serve` (FR-06), composed
// over application/graph/serve-payloads.ts (wave 3a) + the project registry (wave 1).
//
// Each function is transport-agnostic: it returns an ApiResult (either a 200 body or a
// {status,code,message} error) rather than writing to a ServerResponse — router.ts owns
// status codes / headers / the size cap. Every graph/memory store this module opens is
// closed before returning, whatever project the caller asked for (default or otherwise):
// there is no long-lived per-project cache, matching the CLI's short-lived-process ethos.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { openGraphRepo, openMemoryRepo } from "../wiring.ts";
import { readProjectRegistry } from "../../infrastructure/config/project-registry-store.ts";
import { withAvailability, type ProjectEntry } from "../../application/project/registry.ts";
import {
  buildGraphPayload,
  buildNodeDetailPayload,
  buildNodeMemoriesPayload,
  buildSearchPayload,
  buildStatsPayload,
  buildTreePayload,
} from "../../application/graph/serve-payloads.ts";

export type ApiResult =
  | { ok: true; status: 200; body: unknown }
  | { ok: false; status: number; code: string; message: string };

function ok(body: unknown): ApiResult {
  return { ok: true, status: 200, body };
}

function apiError(status: number, code: string, message: string): ApiResult {
  return { ok: false, status, code, message };
}

// ---------------------------------------------------------------------------
// Project resolution — GET /api/projects and the :key param every other route takes.
// ---------------------------------------------------------------------------

/**
 * Registered projects whose root still exists on disk, shaped exactly per FR-06's
 * `/api/projects` response (no `unavailable` flag — that's an internal registry
 * concept; the API contract doesn't expose it, it just never lists a stale root).
 */
function availableProjects(): ProjectEntry[] {
  return withAvailability(readProjectRegistry(), existsSync)
    .filter((p) => !p.unavailable)
    .map(({ projectKey, root, lastBuild }) => ({ projectKey, root, lastBuild }));
}

/** First registered (available) project matching `key`. Undefined when unknown/stale. */
function resolveProject(key: string): ProjectEntry | undefined {
  return availableProjects().find((p) => p.projectKey === key);
}

function graphDbExists(root: string): boolean {
  return existsSync(join(root, ".leina", "graph.db"));
}

/**
 * Resolve `key` to a project with a live graph.db, or the 400 PROJECT_NOT_FOUND error
 * FR-06/FR-07 require for an unknown/stale key. Shared by every :key-scoped endpoint.
 */
function requireProject(key: string): ProjectEntry | ApiResult {
  const project = resolveProject(key);
  if (!project) return apiError(400, "PROJECT_NOT_FOUND", `unknown project key "${key}"`);
  if (!graphDbExists(project.root)) {
    return apiError(400, "PROJECT_NOT_FOUND", `project "${key}" has no graph.db at ${project.root}`);
  }
  return project;
}

function isApiResult(v: ProjectEntry | ApiResult): v is ApiResult {
  return "ok" in v;
}

/** GET /api/projects — FR-01/FR-06. */
export function listProjects(): ApiResult {
  return ok({ projects: availableProjects() });
}

/** Open `project.root`'s graph, run `use`, always close — even on a thrown error. */
function withGraphStore(project: ProjectEntry, use: (store: ReturnType<typeof openGraphRepo>) => unknown): ApiResult {
  const store = openGraphRepo(project.root);
  try {
    return ok(use(store));
  } finally {
    store.close();
  }
}

/** GET /api/projects/:key/stats — FR-06/FR-14. */
export function getStats(key: string): ApiResult {
  const project = requireProject(key);
  if (isApiResult(project)) return project;
  return withGraphStore(project, (store) => buildStatsPayload(store));
}

/** GET /api/projects/:key/tree — FR-06/FR-10. */
export function getTree(key: string): ApiResult {
  const project = requireProject(key);
  if (isApiResult(project)) return project;
  return withGraphStore(project, (store) => buildTreePayload(store.allNodes()));
}

/** GET /api/projects/:key/graph — full graph for the explorer's initial render. */
export function getGraph(key: string): ApiResult {
  const project = requireProject(key);
  if (isApiResult(project)) return project;
  return withGraphStore(project, (store) => buildGraphPayload(store));
}

/** GET /api/projects/:key/search?q= — FR-06. */
export function getSearch(key: string, query: string): ApiResult {
  const project = requireProject(key);
  if (isApiResult(project)) return project;
  return withGraphStore(project, (store) => buildSearchPayload(store, query));
}

/** GET /api/projects/:key/nodes/:id — FR-06/FR-07/FR-11. */
export function getNodeDetail(key: string, nodeId: string): ApiResult {
  const project = requireProject(key);
  if (isApiResult(project)) return project;
  const store = openGraphRepo(project.root);
  try {
    const payload = buildNodeDetailPayload(store, nodeId);
    if (!payload) return apiError(404, "NODE_NOT_FOUND", `no node "${nodeId}" in project "${key}"`);
    return ok(payload);
  } finally {
    store.close();
  }
}

/**
 * GET /api/projects/:key/nodes/:id/memories?limit= — FR-06/FR-12.
 * No node-existence check here on purpose: FR-12's contract is an explicit empty state
 * for a node with no anchors, not an error — a node that doesn't exist in the graph
 * anymore (but still has stale anchors, or none) degrades to the same empty/short list.
 */
export function getNodeMemories(key: string, nodeId: string, limit: number): ApiResult {
  const project = requireProject(key);
  if (isApiResult(project)) return project;
  const mem = openMemoryRepo(project.root);
  try {
    return ok(buildNodeMemoriesPayload(mem.store, nodeId, mem.verifyNode, limit));
  } finally {
    mem.close();
  }
}
