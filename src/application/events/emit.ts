// application/events/emit.ts — Fail-open event emission use case.
// emitEvent NEVER throws; any sink error is swallowed (R4, S4.1).
// Imports only domain ports (arch-rules: application may import domain, never infra/cli).

import type { EventSink } from "../../domain/events/sink.ts";
import type { LeinaEvent } from "../../domain/events/model.ts";

/**
 * Emit an event through the given sink.
 * Fail-open: if sink.emit() throws or rejects, the error is silently swallowed.
 * The caller's exit code and stdout are never affected by a sink failure.
 */
export async function emitEvent(sink: EventSink, event: LeinaEvent): Promise<void> {
  try {
    await sink.emit(event);
  } catch {
    /* fail-open: swallow all errors — event emission must never break the command */
  }
}
