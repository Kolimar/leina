// infrastructure/events/stub-redactor.ts — Pass-through redactor (costura for etapa-9).
// redact() returns the event unchanged — no field modification, same object reference.

import type { Redactor } from "../../domain/events/redactor.ts";
import type { LeinaEvent } from "../../domain/events/model.ts";

export class StubRedactor implements Redactor {
  redact(event: LeinaEvent): LeinaEvent {
    return event;
  }
}
