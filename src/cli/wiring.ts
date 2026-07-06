// cli/wiring.ts — Composition root for the CLI.
// Creates concrete adapters (GraphStore, SQLiteMemoryRepository) and returns
// them as their port interfaces. This is the ONLY place the CLI constructs
// infrastructure: command handlers depend on the domain ports, never on the
// concrete classes. Dynamic import() of the heavy extractor stack stays in the
// command handlers (build/refresh) so the read path never loads it at startup.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { GraphStore } from "../infrastructure/sqlite/graph-store.ts";
import { SQLiteMemoryRepository } from "../infrastructure/sqlite/memory-repository.ts";
import type { AnchorResolver } from "../infrastructure/sqlite/memory-repository.ts";
import { FTS5_MIN_NODE_MAJOR } from "../infrastructure/sqlite/schema.ts";
import { detectNodeVersionAdvice, buildLikeModeWarning } from "../infrastructure/node-version-advice.ts";
import { makeResolveAnchor, makeVerifyNode } from "../application/memory/anchor-verify.ts";
import { AmbiguousProjectError, deriveProjectKey, deriveWorkspaceRootKey, detectWorkspaceMode } from "../application/project/detect-key.ts";
import { globalMemoryPath, leinaHome } from "../infrastructure/install/share-paths.ts";
import { isStale } from "../application/graph/manifest.ts";
import { loadFreshnessConfig } from "../infrastructure/config/freshness.ts";
import { WorkspaceMemoryFederator } from "../application/workspace/federation.ts";
import { LocalEventStore } from "../infrastructure/events/local-event-store.ts";
import { DebugEventSink } from "../infrastructure/events/debug-event-sink.ts";
import { fail } from "./io.ts";
import type { GraphRepository } from "../domain/graph/ports.ts";
import type { MemoryRepository } from "../domain/memory/ports.ts";
import type { NodeVerifier } from "../application/memory/query.ts";
import type { EventSink } from "../domain/events/sink.ts";
import type { EventStore } from "../domain/events/store.ts";
import type { GraphExtractor } from "../domain/graph/extractor.ts";
import { readPackageVersion } from "../version.ts";

export function graphDbPath(root: string): string {
  return join(resolvePath(root), ".leina", "graph.db");
}

export function openGraphRepo(root: string): GraphRepository {
  const p = graphDbPath(root);
  mkdirSync(dirname(p), { recursive: true });
  return new GraphStore(p);
}

// Open the memory store for a project, wired with graph-backed anchor resolution + drift
// verification. Memory is stored in the GLOBAL DB (~/.leina/memory.db), keyed by the
// project key derived from the repo's git remote / root / dir name. The graph store is opened
// lazily (only if anchors/verification are exercised AND a graph.db exists) and closed via the
// returned `close`. CLI processes are short-lived, so a single open/close per command is cheap.
//
// Throws AmbiguousProjectError when the project key cannot be determined — the caller is
// responsible for catching it and reporting a user-friendly message.
export function openMemoryRepo(root: string): {
  store: MemoryRepository;
  verifyNode: NodeVerifier;
  resolveAnchor: AnchorResolver;
  close: () => void;
} {
  let graph: GraphStore | null = null;
  const getGraph = (): GraphStore => {
    const p = graphDbPath(root);
    // No graph yet → throw so makeResolveAnchor/makeVerifyNode treat anchors as unresolved
    // rather than us creating an empty graph.db as a side effect.
    if (!existsSync(p)) throw new Error(`no graph at ${p}`);
    graph ??= new GraphStore(p);
    return graph;
  };
  const resolveAnchor = makeResolveAnchor({ getStore: getGraph, root });
  const verifyNode = makeVerifyNode({ getStore: getGraph, root });
  // Derive the project key from git remote / root / dir name. May throw AmbiguousProjectError.
  const projectKey = deriveProjectKey(resolvePath(root)).key;
  const store = new SQLiteMemoryRepository(globalMemoryPath(), projectKey, resolveAnchor);
  return {
    store,
    verifyNode,
    // Exposed (not just baked into the store's save-time label resolution) so
    // application/memory/reanchor.ts can re-resolve labels extracted from EXISTING
    // observation text against the same live-graph-backed resolver.
    resolveAnchor,
    close: () => {
      store.close();
      if (graph) graph.close();
    },
  };
}

// openMemoryRepo wrapper: catch AmbiguousProjectError and fail with a helpful message.
// When the store opens in LIKE-degraded mode (FTS5 unavailable), a warning is emitted
// to stderr so the user/agent knows to upgrade Node for full search quality.
/** Throw-based twin of memOpenGuarded, for long-lived transports (MCP/TUI). */
export function memOpenOrThrow(dir: string): ReturnType<typeof openMemoryRepo> {
  try {
    return openMemoryRepo(dir);
  } catch (e) {
    if (e instanceof AmbiguousProjectError) {
      throw new Error(
        `Ambiguous project — found multiple git repos: ${e.candidates.join(", ")}. ` +
          `Resolve by creating .leina/config.json with {"project_name":"<name>"}.`,
      );
    }
    throw e;
  }
}

export function memOpenGuarded(dir: string): ReturnType<typeof openMemoryRepo> {
  let result: ReturnType<typeof openMemoryRepo>;
  try {
    result = openMemoryRepo(dir);
  } catch (e) {
    if (e instanceof AmbiguousProjectError) {
      fail(
        `Ambiguous project — found multiple git repos: ${e.candidates.join(", ")}.\n` +
          `Resolve by creating .leina/config.json with {"project_name":"<name>"}.`,
      );
    }
    throw e;
  }
  if (result.store.usingLike) {
    const advice = detectNodeVersionAdvice(dir, FTS5_MIN_NODE_MAJOR);
    process.stderr.write(`${buildLikeModeWarning(process.version, advice)  }\n`);
  }
  return result;
}

// Open a guaranteed-fresh graph reader for the read/query path. Mirrors the freshness gate:
// fresh → open as-is; stale + posture "auto" → rebuild then open; stale + "refuse" → instruct.
// buildGraph is lazy-imported so the common (fresh) path never loads the extractor stack.
/**
 * Throw-based core of the freshness gate. Long-lived transports (MCP server, TUI) need
 * errors as exceptions — a fail() here would process.exit the whole server on the first
 * tool call against an unbuilt repo. `buildIfMissing` extends the gate's "auto" posture
 * to the ABSENT case (build on first query), which is what a self-sufficient MCP tool
 * wants; the CLI keeps its explicit "run leina build" guidance instead.
 */
export async function openFreshStoreOrThrow(
  root: string,
  opts: { buildIfMissing?: boolean } = {},
): Promise<GraphRepository> {
  const p = graphDbPath(root);
  const missing = !existsSync(p);
  if (missing && !opts.buildIfMissing) {
    throw new Error(`No graph at ${p}. Run: leina build ${root}`);
  }
  const s = missing ? { stale: true, reason: "no graph yet" } : isStale(root);
  if (!s.stale) return openGraphRepo(root);
  const posture = loadFreshnessConfig(root);
  if (!missing && posture === "refuse") {
    throw new Error(
      `Graph is stale (${s.reason}) but freshness posture is "refuse". ` +
        `Run: leina refresh ${root}`,
    );
  }
  // auto: rebuild then serve. Writer and reader never coexist (build, close, reopen).
  process.stderr.write(`leina: graph stale (${s.reason}); rebuilding ...\n`);
  const { buildGraph } = await import("../application/graph/build.ts");
  const registry = await buildDefaultRegistry();
  const w = openGraphRepo(root);
  try {
    await buildGraph(root, w, registry);
  } finally {
    w.close();
  }
  return openGraphRepo(root);
}

export async function openFreshStore(root: string): Promise<GraphRepository> {
  try {
    return await openFreshStoreOrThrow(root);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Workspace composition root (new — NFR-02: single-repo functions above untouched)
// ---------------------------------------------------------------------------

/**
 * Open a guaranteed-fresh merged GraphRepository for a workspace.
 * Detects workspace members, orchestrates per-repo builds (reuse-or-rebuild),
 * and returns the merged store (workspace graph.db v3 at <wsRoot>/.leina/).
 *
 * The caller is responsible for calling `.close()` on the returned store.
 */
export async function openWorkspaceFreshStore(
  wsRoot: string,
  flags: { single?: boolean; workspace?: boolean } = {},
): Promise<GraphRepository> {
  const resolved = resolvePath(wsRoot);
  const detection = detectWorkspaceMode(resolved, flags);

  if (detection.mode === "single") {
    // Fall back to single-repo path (covers --single override)
    return openFreshStore(resolved);
  }

  const mergedDbPath = graphDbPath(wsRoot); // reuse same path helper for the workspace root
  mkdirSync(dirname(mergedDbPath), { recursive: true });

  const mergedStore = openGraphRepo(wsRoot);

  const { buildWorkspace } = await import("../application/workspace/build.ts");
  const registry = await buildDefaultRegistry();
  const report = await buildWorkspace(resolved, detection.members, mergedStore, registry);

  if (Object.keys(report.errors).length > 0) {
    process.stderr.write(
      `leina workspace: ${Object.keys(report.errors).length} member(s) failed to build.\n`,
    );
  }

  process.stderr.write(
    `leina workspace: ${report.membersRebuilt} rebuilt, ${report.membersReused} reused ` +
      `(${report.membersTotal} total members), ${report.crossEdges} cross-repo edge(s)\n`,
  );

  return mergedStore;
}

// ---------------------------------------------------------------------------
// Workspace memory composition root (new — NFR-02: openMemoryRepo untouched)
// ---------------------------------------------------------------------------

/**
 * Open a WorkspaceMemoryFederator for a workspace root.
 * In single-repo mode (no workspace detected), returns the standard openMemoryRepo result.
 * The caller is responsible for calling `.close()` on the returned result.
 *
 * NOTE: WorkspaceMemoryFederator.close() is intentionally a no-op — the underlying repo
 * is owned by the returned `close` callback. Always call result.close() when done.
 */
export function openWorkspaceMemoryRepo(
  wsRoot: string,
  flags: { single?: boolean; workspace?: boolean } = {},
): ReturnType<typeof openMemoryRepo> {
  const resolved = resolvePath(wsRoot);
  const detection = detectWorkspaceMode(resolved, flags);

  if (detection.mode === "single") {
    return openMemoryRepo(resolved);
  }

  // Workspace mode: derive the workspace project key safely.
  // MUST NOT use deriveProjectKey(resolved) here — that runs child-git-auto (step 3)
  // which throws AmbiguousProjectError when ≥2 child repos exist, i.e. in every real
  // workspace.  deriveWorkspaceRootKey skips that step: config-lock → git-remote →
  // git-root-basename → dir-basename.  It never throws.
  const wsProjectKey = deriveWorkspaceRootKey(resolved);
  let graph: GraphStore | null = null;
  const getGraph = (): GraphStore => {
    const p = graphDbPath(resolved);
    if (!existsSync(p)) throw new Error(`no graph at ${p}`);
    graph ??= new GraphStore(p);
    return graph;
  };
  const resolveAnchor = makeResolveAnchor({ getStore: getGraph, root: resolved });
  const verifyNode = makeVerifyNode({ getStore: getGraph, root: resolved });
  const baseRepo = new SQLiteMemoryRepository(globalMemoryPath(), wsProjectKey, resolveAnchor);

  // Create per-member repos (all backed by same global db, different projectKeys)
  const memberRepos = detection.members.map(
    (m) => new SQLiteMemoryRepository(globalMemoryPath(), m.repoKey),
  );
  const federator = new WorkspaceMemoryFederator(baseRepo, memberRepos);

  return {
    store: federator,
    verifyNode,
    resolveAnchor,
    close: () => {
      // federator.close() is a no-op; we own all repos here
      for (const mr of memberRepos) mr.close();
      baseRepo.close();
      if (graph) graph.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Events composition root (etapa-8-events-cloud)
// ---------------------------------------------------------------------------

/** Canonical path for the local event outbox JSONL file. */
export function eventsOutboxPath(): string {
  return join(leinaHome(), "events", "outbox.jsonl");
}

/**
 * Return the active EventSink for this process.
 * Default: DebugEventSink (no-op, no stdout/stderr/fs effects).
 * With LEINA_EVENTS_PERSIST=1: LocalEventStore writing to eventsOutboxPath().
 */
export function openEventSink(): EventSink {
  if (process.env.LEINA_EVENTS_PERSIST === "1") {
    return new LocalEventStore(eventsOutboxPath());
  }
  return new DebugEventSink();
}

/** Return a LocalEventStore for reading the outbox (events tail command). */
export function openEventStore(): EventStore {
  return new LocalEventStore(eventsOutboxPath());
}

// ---------------------------------------------------------------------------
// Registry composition root — crea los 7 adaptadores en orden canónico.
// Importa los adaptadores concretos (infra) de forma lazy para no cargar el
// stack pesado en rutas que no necesitan extracción.
// ---------------------------------------------------------------------------

/**
 * Instancia los 7 extractores en el orden canónico:
 *   tsmorph → scip-go → scip-rust → scip-python → sidecar-csharp → sidecar-java → treesitter (fallback)
 *
 * Usa dynamic imports para no cargar los módulos pesados (ts-morph, web-tree-sitter)
 * en el startup de comandos que no necesitan extracción (query, memory, etc.).
 * `ScipExtractor` en sí es liviano (parser protobuf hand-rolled, cero deps nuevas)
 * pero se importa de forma lazy igual que el resto, por consistencia.
 *
 * Debe llamarse con `await` desde los handlers de build/refresh/workspace.
 */
export async function buildDefaultRegistry(): Promise<GraphExtractor[]> {
  const [
    { TsmorphExtractor },
    { ScipExtractor },
    { SidecarExtractor },
    { TreesitterExtractor },
    { YamlInfraExtractor },
  ] = await Promise.all([
    import("../infrastructure/extractors/semantic/tsmorph.ts"),
    import("../infrastructure/extractors/semantic/scip.ts"),
    import("../infrastructure/extractors/semantic/sidecar.ts"),
    import("../infrastructure/extractors/treesitter.ts"),
    import("../infrastructure/extractors/yaml.ts"),
  ]);
  const version = readPackageVersion();
  // EXTRACTOR_ORDER: tsmorph → scip-go → scip-rust → scip-python → sidecar-csharp → sidecar-java → treesitter → yaml-infra (LAST)
  return [
    new TsmorphExtractor(version),
    new ScipExtractor("go", version),
    new ScipExtractor("rust", version),
    new ScipExtractor("python", version),
    new SidecarExtractor("csharp", version),
    new SidecarExtractor("java", version),
    new TreesitterExtractor(version),
    new YamlInfraExtractor(version),
  ];
}
