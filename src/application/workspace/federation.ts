// application/workspace/federation.ts
// WorkspaceMemoryFederator: presents a virtual MemoryRepository view that
// aggregates search/read across multiple per-member-repo memory scopes within
// the same global memory.db. Writes always go to a single designated "host" repo.
//
// Design: memory.db is a single global store keyed by projectKey.
// A workspace has members each with their own projectKey.
// The Federator holds:
//   - hostRepo:    the MemoryRepository scoped to the workspace project key
//   - memberRepos: MemoryRepository instances scoped to each member's project key
//
// The Federator does NOT close any of the repos it holds — the caller (wiring.ts)
// owns the lifecycle of every repo instance.

import type { MemoryRepository } from "../../domain/memory/ports.ts";
import type {
  Observation,
  ObservationInput,
  ObservationType,
  Scope,
  SearchHit,
  Session,
  TopicKeySuggestion,
  UpdateFields,
} from "../../domain/memory/model.ts";
import type { BatchResult } from "../../domain/shared/batch.ts";

/**
 * WorkspaceMemoryFederator federates memory reads across all member project repos,
 * while directing writes to the workspace-level host repo.
 *
 * @param hostRepo    - the workspace-key scoped MemoryRepository (writes go here)
 * @param memberRepos - per-member MemoryRepository instances (reads federated from all)
 */
export class WorkspaceMemoryFederator implements MemoryRepository {
  private readonly hostRepo: MemoryRepository;
  private readonly allRepos: MemoryRepository[];

  constructor(hostRepo: MemoryRepository, memberRepos: MemoryRepository[]) {
    this.hostRepo = hostRepo;
    // allRepos = hostRepo + deduplicated memberRepos (host may appear in members too)
    const seen = new Set<MemoryRepository>();
    seen.add(hostRepo);
    this.allRepos = [hostRepo];
    for (const mr of memberRepos) {
      if (!seen.has(mr)) {
        seen.add(mr);
        this.allRepos.push(mr);
      }
    }
  }

  get usingLike(): boolean {
    return this.hostRepo.usingLike;
  }

  // ---- Writes → host repo -------------------------------------------------

  save(input: ObservationInput): { observation: Observation; evolved: boolean } {
    return this.hostRepo.save(input);
  }

  // Portable memory routes to the host repo, mirroring save(): a workspace export is the
  // HOST project's memory (member repos export from their own checkouts).
  exportAll(): ReturnType<MemoryRepository["exportAll"]> {
    return this.hostRepo.exportAll();
  }

  importObservations(
    items: Parameters<MemoryRepository["importObservations"]>[0],
  ): ReturnType<MemoryRepository["importObservations"]> {
    return this.hostRepo.importObservations(items);
  }

  saveBatch(
    items: ObservationInput[],
    opts?: { atomic?: boolean },
  ): BatchResult<{ observation: Observation; evolved: boolean }>[] {
    return this.hostRepo.saveBatch(items, opts);
  }

  update(id: string, fields: UpdateFields): Observation {
    return this.hostRepo.update(id, fields);
  }

  updateBatch(
    items: { id: string; fields: UpdateFields }[],
    opts?: { atomic?: boolean },
  ): BatchResult<Observation>[] {
    return this.hostRepo.updateBatch(items, opts);
  }

  // ---- Reads → federated across all repos ---------------------------------

  get(id: string): Observation | undefined {
    // Try host first, then members
    for (const r of this.allRepos) {
      const obs = r.get(id);
      if (obs !== undefined) return obs;
    }
    return undefined;
  }

  getBatch(ids: string[]): BatchResult<Observation>[] {
    // Return results from whichever repo can answer each id
    return ids.map((id) => {
      const obs = this.get(id);
      if (obs !== undefined) return { ok: true, data: obs };
      return { ok: false, error: `not found: ${id}` };
    });
  }

  /**
   * Search across all member repos and the host.
   * Results are merged, de-duped by id, and sorted by score descending.
   */
  search(
    query: string,
    opts?: { scope?: Scope; type?: ObservationType; limit?: number },
  ): SearchHit[] {
    const seen = new Set<string>();
    const merged: SearchHit[] = [];

    for (const r of this.allRepos) {
      const hits = r.search(query, opts);
      for (const h of hits) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        merged.push(h);
      }
    }

    merged.sort((a, b) => b.score - a.score);
    if (opts?.limit !== undefined) return merged.slice(0, opts.limit);
    return merged;
  }

  /**
   * Return merged sessions + observations across all repos.
   * De-duped by id. Most-recent first.
   */
  recentContext(opts?: {
    scope?: Scope;
    limit?: number;
    sessionLimit?: number;
  }): { sessions: Session[]; observations: Observation[] } {
    const seenObs = new Set<string>();
    const seenSess = new Set<string>();
    const observations: Observation[] = [];
    const sessions: Session[] = [];

    for (const r of this.allRepos) {
      const ctx = r.recentContext(opts);
      for (const o of ctx.observations) {
        if (seenObs.has(o.id)) continue;
        seenObs.add(o.id);
        observations.push(o);
      }
      for (const s of ctx.sessions) {
        if (seenSess.has(s.id)) continue;
        seenSess.add(s.id);
        sessions.push(s);
      }
    }

    observations.sort(
      (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
    );
    sessions.sort(
      (a, b) => b.startedAt - a.startedAt,
    );

    const limit = opts?.limit ?? 10;
    const sessionLimit = opts?.sessionLimit ?? 3;
    return {
      observations: observations.slice(0, limit),
      sessions: sessions.slice(0, sessionLimit),
    };
  }

  // ---- Sessions → host repo -----------------------------------------------

  startSession(title?: string, scope?: Scope): Session {
    return this.hostRepo.startSession(title, scope);
  }

  saveSession(
    summary: string,
    opts?: { sessionId?: string; title?: string; scope?: Scope },
  ): Session {
    return this.hostRepo.saveSession(summary, opts);
  }

  // ---- Anchors → delegate to host (anchors stored with host projectKey) ---

  anchorsForNode(nodeId: string): {
    observationId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
  }[] {
    return this.hostRepo.anchorsForNode(nodeId);
  }

  anchorsForObservation(observationId: string): {
    nodeId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
    anchorHash?: string;
  }[] {
    return this.hostRepo.anchorsForObservation(observationId);
  }

  recentAnchoredObservations(nodeId: string, limit: number): {
    observationId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
    updatedAt: number;
  }[] {
    return this.hostRepo.recentAnchoredObservations(nodeId, limit);
  }

  // ---- Topic suggestion → host repo ---------------------------------------

  suggestTopicKeyWithMatches(
    title: string,
    type: string,
    scope?: Scope,
  ): TopicKeySuggestion {
    return this.hostRepo.suggestTopicKeyWithMatches(title, type, scope);
  }

  // ---- Project management → host repo -------------------------------------

  mergeProject(
    from: string,
    to: string,
    opts?: { dryRun?: boolean },
  ): { moved: number; superseded: number } {
    return this.hostRepo.mergeProject(from, to, opts);
  }

  importFromLegacy(
    legacyDbPath: string,
    fromKey: string,
    toKey: string,
  ): { moved: number; skipped: number } {
    return this.hostRepo.importFromLegacy(legacyDbPath, fromKey, toKey);
  }

  // ---- Lifecycle ----------------------------------------------------------

  /**
   * No-op: WorkspaceMemoryFederator does NOT own the lifecycle of the repos it holds.
   * The caller (wiring.ts) is responsible for closing each repo individually.
   */
  close(): void {
    // intentional no-op
  }
}
