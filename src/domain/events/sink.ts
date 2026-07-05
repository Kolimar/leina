// domain/events/sink.ts — EventSink port (async emit; costura for remote sinks).
// ISOLATION RULE: no imports from application/, infrastructure/ or cli/.

import type { LeinaEvent } from "./model.ts";

export interface EventSink {
  emit(event: LeinaEvent): Promise<void>;
}
