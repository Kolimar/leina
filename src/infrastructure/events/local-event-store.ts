// infrastructure/events/local-event-store.ts — JSONL-based local outbox adapter.
// Implements EventStore (append/read) and EventSink (emit → append).
// NOT parameter-properties: field declared explicitly (--experimental-strip-types compat).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventSink } from "../../domain/events/sink.ts";
import type { EventStore } from "../../domain/events/store.ts";
import type { LeinaEvent } from "../../domain/events/model.ts";

export class LocalEventStore implements EventStore, EventSink {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(event: LeinaEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)  }\n`, "utf8");
  }

  read(): LeinaEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LeinaEvent);
  }

  async emit(event: LeinaEvent): Promise<void> {
    this.append(event);
  }
}
