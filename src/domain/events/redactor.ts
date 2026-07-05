// domain/events/redactor.ts — Redactor port (costura for PII redaction in etapa-9+).
// ISOLATION RULE: no imports from application/, infrastructure/ or cli/.

import type { LeinaEvent } from "./model.ts";

export interface Redactor {
  redact(event: LeinaEvent): LeinaEvent;
}
