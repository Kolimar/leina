// infrastructure/events/debug-event-sink.ts — No-op event sink (default).
// emit() is a pure no-op: zero stdout/stderr/fs side effects (R3, S3.1).

import type { EventSink } from "../../domain/events/sink.ts";
import type { LeinaEvent } from "../../domain/events/model.ts";

export class DebugEventSink implements EventSink {
   
  async emit(_event: LeinaEvent): Promise<void> {
    /* no-op: intentional — default sink produces zero observable effects */
  }
}
