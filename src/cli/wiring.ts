// cli/wiring.ts — Composition root for the CLI.
// Creates concrete adapters (GraphStore, SQLiteMemoryRepository) and returns
// them as their port interfaces. This is the ONLY place the CLI constructs
// infrastructure: command handlers depend on the domain ports, never on the
// concrete classes. Dynamic import() of the heavy extractor stack stays in the
// command handlers (build/refresh) so the read path never loads it at startup.

import { existsSync, mkdirSync, statSync } from "node:fs";
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
import { forgetSourceList, withSourceListMemo } from "../application/graph/sources.ts";
import { acquireBuildLock, lockTimeoutMessage, releaseBuildLock } from "./background-build.ts";
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
// Type-only (erased at runtime): build.ts itself stays lazy-imported in buildGraphShared.
import type { BuildReport } from "../application/graph/build.ts";
import { readPackageVersion } from "../version.ts";

export function graphDbPath(root: string): string {
  return join(resolvePath(root), ".leina", "graph.db");
}

/**
 * Why `root` cannot be built, or null when it is an existing directory. A build opens
 * `<root>/.leina/graph.db` with a recursive mkdir, so a typo'd or missing root (`leina build
 * "how is trust checked"`) would otherwise be CREATED, get an empty graph and be registered
 * as a project. Every build entry point checks this first.
 */
export function buildRootProblem(root: string): string | null {
  let isDir: boolean;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    return `no such directory: ${resolvePath(root)}`;
  }
  return isDir ? null : `not a directory: ${resolvePath(root)}`;
}

export function openGraphRepo(root: string, opts?: { readOnly?: boolean }): GraphRepository {
  const p = graphDbPath(root);
  mkdirSync(dirname(p), { recursive: true });
  return new GraphStore(p, opts);
}

// Open the memory store for a project, wired with graph-backed anchor resolution + drift
// verification. Memory is stored in the GLOBAL DB (~/.leina/memory.db), keyed by the
// project key derived from the repo's git remote / root / dir name. The graph store is opened
// lazily (only if anchors/verification are exercised AND a graph.db exists) and closed via the
// returned `close`. CLI processes are short-lived, so a single open/close per command is cheap.
//
// Throws AmbiguousProjectError when the project key cannot be determined — the caller is
// responsible for catching it and reporting a user-friendly message.
export function openMemoryRepo(root: string, opts?: { readOnly?: boolean }): {
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
    // The anchor-resolution/verification graph is read-only too when the caller is
    // read-only (graph serve) — it only ever reads to check drift.
    graph ??= new GraphStore(p, opts);
    return graph;
  };
  const resolveAnchor = makeResolveAnchor({ getStore: getGraph, root });
  const verifyNode = makeVerifyNode({ getStore: getGraph, root });
  // Derive the project key from git remote / root / dir name. May throw AmbiguousProjectError.
  const projectKey = deriveProjectKey(resolvePath(root)).key;
  const store = new SQLiteMemoryRepository(globalMemoryPath(), projectKey, resolveAnchor, opts);
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
  // A build already running in THIS process (a concurrent MCP call) is about to replace
  // the graph — and on a first build the db is empty until it commits. Wait for it, then
  // gate on what it produced.
  await awaitGraphBuild(root);
  const p = graphDbPath(root);
  const missing = !existsSync(p);
  if (missing && !opts.buildIfMissing) {
    throw new Error(`No graph at ${p}. Run: leina build ${root}`);
  }
  const rootProblem = missing ? buildRootProblem(root) : null;
  if (rootProblem) throw new Error(`cannot build the graph: ${rootProblem}`);
  // One source-walk memo for the whole gate+rebuild operation: the staleness
  // check and a stale-triggered rebuild share a single source listing instead of
  // walking the tree twice. The memo lives ONLY for this call's dynamic extent
  // (see sources.ts) — the next gate re-walks, so a long-lived process (MCP
  // server) can never see a stale 'fresh' verdict because of this.
  return withSourceListMemo(async () => {
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
    // Concurrent stale callers in this process share one rebuild (single-flight); across
    // processes the build lock admits one builder, and the others re-check after waiting.
    await rebuildIfStillStale(root, s.reason);
    return openGraphRepo(root);
  });
}

// ---------------------------------------------------------------------------
// In-process single-flight for graph builds. A long-lived process — the MCP server runs
// tool calls concurrently — would otherwise start one full rebuild per call that finds
// the graph stale, and a reader racing a FIRST build would read the empty,
// not-yet-committed db (graph_stats → nodes: 0). Builds are keyed by resolved root:
// concurrent callers share the in-flight promise, and readers can wait for it
// (awaitGraphBuild). Across processes, every build here also holds the project's build lock
// (background-build.ts) — the same lock `leina build`/`refresh` and the detached self-heal
// take — so N concurrent CLI queries against a stale graph run ONE rebuild, not N.
// ---------------------------------------------------------------------------

/** `build` resolves null only when `maySkip` (a read-path rebuild) found the graph already
 *  rebuilt by another process once it got the lock. */
interface InflightBuild {
  build: Promise<BuildReport | null>;
  maySkip: boolean;
}
const inflightBuilds = new Map<string, InflightBuild>();

/**
 * Build the graph for `root` (always — an explicit build, e.g. the MCP graph_build tool), or
 * join the build already running for it in this process. The extractor stack is lazy-imported
 * here, so the read path never loads it.
 */
export function buildGraphShared(root: string): Promise<BuildReport> {
  const running = inflightBuilds.get(resolvePath(root));
  if (running && !running.maySkip) return running.build as Promise<BuildReport>;
  // A joined read-path rebuild may be skipped (another process had just rebuilt): then force one.
  if (running) return running.build.then((report) => report ?? buildGraphShared(root));
  return startBuild(root, { skipIfFresh: false }) as Promise<BuildReport>;
}

/**
 * The read path's rebuild of a graph it found stale: like buildGraphShared, but when another
 * process held the build lock first, staleness is re-checked once the lock is ours and the
 * build is skipped (null) if that process already brought the graph up to date. With
 * `staleReason` (the gate's isStale reason) it narrates on stderr: exactly one
 * "…; rebuilding ..." line per build actually started, a "waiting" line otherwise.
 */
export function rebuildIfStillStale(root: string, staleReason?: string): Promise<BuildReport | null> {
  const running = inflightBuilds.get(resolvePath(root));
  if (running) {
    if (staleReason) process.stderr.write(`leina: graph stale (${staleReason}); waiting for the in-flight rebuild ...\n`);
    return running.build;
  }
  return startBuild(root, { skipIfFresh: true, staleReason });
}

function startBuild(
  root: string,
  opts: { skipIfFresh: boolean; staleReason?: string },
): Promise<BuildReport | null> {
  const key = resolvePath(root);
  const rootProblem = buildRootProblem(root);
  if (rootProblem) return Promise.reject(new Error(`cannot build the graph: ${rootProblem}`));
  const said = opts.staleReason ? `graph stale (${opts.staleReason}); ` : "";
  const build = (async () => {
    const lock = await acquireBuildLock(root, {
      onWait: (holder) =>
        process.stderr.write(
          `leina: ${said}another leina process (${holder.pid > 0 ? `pid ${holder.pid}` : "pid unknown"}) ` +
            `is rebuilding it; waiting ...\n`,
        ),
    });
    if ("timeout" in lock) throw new Error(lockTimeoutMessage(root, lock.holderPid, lock.holderStartedAt));
    try {
      let line = opts.staleReason ? `leina: graph stale (${opts.staleReason}); rebuilding ...` : null;
      if (lock.waited && opts.skipIfFresh) {
        // Judge what is on disk NOW, not the source listing taken before the wait.
        forgetSourceList(root);
        const again = isStale(root);
        if (!again.stale) return null;
        if (line) line = `leina: graph still stale (${again.reason}); rebuilding ...`;
      }
      if (line) process.stderr.write(`${line}\n`);
      const { buildGraph } = await import("../application/graph/build.ts");
      const registry = await buildDefaultRegistry();
      const w = openGraphRepo(root);
      try {
        // quiet: a read-path auto-rebuild or an MCP build — nobody asked to watch it, so no
        // per-build diagnostics or nudges on stderr (the report still carries `degraded`).
        return await buildGraph(root, w, registry, { quiet: true });
      } finally {
        w.close();
      }
    } finally {
      releaseBuildLock(root);
    }
  })().finally(() => inflightBuilds.delete(key));
  inflightBuilds.set(key, { build, maySkip: opts.skipIfFresh });
  return build;
}

/** Resolve once no build of `root` is running in this process (its outcome is the builder's to report). */
export async function awaitGraphBuild(root: string): Promise<void> {
  await inflightBuilds.get(resolvePath(root))?.build.catch(() => undefined);
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

/** Tail of the workspace merges queued per resolved workspace root (in-process FIFO). */
const workspaceMerges = new Map<string, Promise<unknown>>();

function mergeInProcess<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (workspaceMerges.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  workspaceMerges.set(key, next);
  const forget = (): void => {
    if (workspaceMerges.get(key) === next) workspaceMerges.delete(key);
  };
  next.then(forget, forget);
  return next;
}

/**
 * Open a guaranteed-fresh merged GraphRepository for a workspace.
 * Detects workspace members, orchestrates per-repo builds (reuse-or-rebuild),
 * and returns the merged store (workspace graph.db v3 at <wsRoot>/.leina/).
 *
 * Throws (never process.exit): it also serves the MCP graph_visualize executor, so
 * the single-mode fallback uses the throwing gate; CLI callers wrap it in fail().
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
    return openFreshStoreOrThrow(resolved);
  }

  const mergedDbPath = graphDbPath(wsRoot); // reuse same path helper for the workspace root
  mkdirSync(dirname(mergedDbPath), { recursive: true });

  const { buildWorkspace } = await import("../application/workspace/build.ts");
  const registry = await buildDefaultRegistry();
  // The merge clears and re-imports the merged graph.db: it runs one at a time per workspace,
  // in this process (mergeInProcess) and across processes (the workspace root's build lock),
  // so concurrent workspace reads never interleave their merges. Each stale member is rebuilt
  // under its OWN lock (rebuildIfStillStale), shared with that repo's single-repo readers and
  // builders. Same intra-operation walk memo as openFreshStoreOrThrow.
  const { mergedStore, report } = await mergeInProcess(resolved, async () => {
    const lock = await acquireBuildLock(resolved);
    if ("timeout" in lock) throw new Error(lockTimeoutMessage(resolved, lock.holderPid, lock.holderStartedAt));
    const store = openGraphRepo(wsRoot);
    try {
      const built = await withSourceListMemo(() =>
        buildWorkspace(resolved, detection.members, store, registry, {
          buildMember: async (dir) => (await rebuildIfStillStale(dir)) !== null,
        }),
      );
      return { mergedStore: store, report: built };
    } catch (err) {
      store.close();
      throw err;
    } finally {
      releaseBuildLock(resolved);
    }
  });

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
