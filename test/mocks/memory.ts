// Mock MemoryRepository for use-case unit tests.

import type {
  Observation,
  ObservationInput,
  ObservationType,
  Scope,
  SearchHit,
  Session,
  TopicKeySuggestion,
  UpdateFields,
} from "../../src/domain/memory/model.ts";
import type { MemoryRepository } from "../../src/domain/memory/ports.ts";
import type { BatchResult } from "../../src/domain/shared/batch.ts";

let nextId = 1;

export class MockMemoryRepository implements MemoryRepository {
  observations: Observation[] = [];
  sessions: Session[] = [];
  closed = false;
  readonly usingLike: boolean = false;

  save(input: ObservationInput): { observation: Observation; evolved: boolean } {
    const now = Date.now();
    const obs: Observation = {
      id: `obs-${nextId++}`,
      projectKey: "test-project",
      type: input.type ?? "architecture",
      title: input.title,
      content: input.content,
      scope: input.scope ?? "project",
      topicKey: input.topicKey,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    this.observations.push(obs);
    return { observation: obs, evolved: false };
  }

  saveBatch(
    items: ObservationInput[],
    _opts?: { atomic?: boolean },
  ): BatchResult<{ observation: Observation; evolved: boolean }>[] {
    return items.map((item) => {
      const result = this.save(item);
      return { ok: true as const, data: result };
    });
  }

  update(id: string, fields: UpdateFields): Observation {
    const obs = this.observations.find((o) => o.id === id);
    if (!obs) throw new Error(`Observation ${id} not found`);
    if (fields.title !== undefined) obs.title = fields.title;
    if (fields.content !== undefined) obs.content = fields.content;
    obs.updatedAt = Date.now();
    return obs;
  }

  updateBatch(
    items: { id: string; fields: UpdateFields }[],
    _opts?: { atomic?: boolean },
  ): BatchResult<Observation>[] {
    return items.map((item) => {
      const obs = this.update(item.id, item.fields);
      return { ok: true as const, data: obs };
    });
  }

  get(id: string): Observation | undefined {
    const cleanId = id.startsWith("#") ? id.slice(1) : id;
    return this.observations.find((o) => o.id === cleanId);
  }

  getBatch(ids: string[]): BatchResult<Observation>[] {
    return ids.map((id) => {
      const obs = this.get(id);
      if (obs) return { ok: true as const, data: obs };
      return { ok: false as const, error: `Not found: ${id}` };
    });
  }

  search(
    query: string,
    _opts?: { scope?: Scope; type?: ObservationType; limit?: number },
  ): SearchHit[] {
    const q = query.toLowerCase();
    return this.observations
      .filter((o) => o.title.toLowerCase().includes(q) || o.content.toLowerCase().includes(q))
      .map((o) => ({
        id: o.id,
        title: o.title,
        type: o.type,
        topicKey: o.topicKey,
        snippet: o.content.slice(0, 100),
        score: 1.0,
        updatedAt: o.updatedAt,
        scope: o.scope,
      }));
  }

  recentContext(_opts?: {
    scope?: Scope;
    limit?: number;
    sessionLimit?: number;
  }): { sessions: Session[]; observations: Observation[] } {
    return { sessions: this.sessions, observations: this.observations.slice(-5) };
  }

  startSession(title?: string, scope?: Scope): Session {
    const session: Session = {
      id: `sess-${nextId++}`,
      projectKey: "test-project",
      title: title ?? "Test session",
      scope: scope ?? "project",
      startedAt: Date.now(),
    };
    this.sessions.push(session);
    return session;
  }

  saveSession(
    summary: string,
    opts?: { sessionId?: string; title?: string; scope?: Scope },
  ): Session {
    const session: Session = {
      id: opts?.sessionId ?? `sess-${nextId++}`,
      projectKey: "test-project",
      title: opts?.title ?? "Session summary",
      scope: opts?.scope ?? "project",
      startedAt: Date.now(),
      summary,
    };
    this.sessions.push(session);
    return session;
  }

  anchorsForNode(_nodeId: string): {
    observationId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
  }[] {
    return [];
  }

  anchorsForObservation(_observationId: string): {
    nodeId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
    anchorHash?: string;
  }[] {
    return [];
  }

  recentAnchoredObservations(_nodeId: string, _limit: number): {
    observationId: string;
    role: string;
    anchorLabel?: string;
    anchorFile?: string;
    updatedAt: number;
  }[] {
    return [];
  }

  suggestTopicKeyWithMatches(
    title: string,
    _type: string,
    _scope?: Scope,
  ): TopicKeySuggestion {
    const key = title.toLowerCase().replaceAll(/\s+/g, "-").replaceAll(/[^a-z0-9-]/g, "");
    return { suggestion: key, nearMatches: [] };
  }

  mergeProject(
    _from: string,
    _to: string,
    _opts?: { dryRun?: boolean },
  ): { moved: number; superseded: number } {
    return { moved: 0, superseded: 0 };
  }

  importFromLegacy(
    _legacyDbPath: string,
    _fromKey: string,
    _toKey: string,
  ): { moved: number; skipped: number } {
    return { moved: 0, skipped: 0 };
  }

  exportAll(): import("../../src/domain/memory/model.ts").ExportedObservation[] {
    return [];
  }

  importObservations(): import("../../src/domain/memory/model.ts").ImportReport {
    return { inserted: 0, updated: 0, skippedOlder: 0, topicConflicts: 0 };
  }

  close(): void {
    this.closed = true;
  }
}
