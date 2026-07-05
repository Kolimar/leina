// domain/events/store.ts — EventStore port (read/append JSONL outbox).
// ISOLATION RULE: no imports from application/, infrastructure/ or cli/.

import type { LeinaEvent } from "./model.ts";

export interface EventStore {
  append(event: LeinaEvent): void;
  read(): LeinaEvent[];
}
