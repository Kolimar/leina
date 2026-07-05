// cli/handlers/events.ts — `leina events tail [--json]` command handler.
// Reads events from the local outbox JSONL file and prints them to stdout.
// rest = argv tail after "events", e.g. ["tail"] or ["tail","--json"].

import { openEventStore } from "../wiring.ts";

/**
 * Handle `events tail [--json]`.
 *  --json  → print a JSON array of LeinaEvent objects
 *  (none)  → print one human-readable line per event: <iso-ts> <type> <id>
 *
 * If outbox.jsonl does not exist or is empty, prints an informative message and exits 0.
 */
export function handleEventsTail(rest: string[]): void {
  const wantJson = rest.includes("--json");
  const store = openEventStore();
  const events = store.read();

  if (events.length === 0) {
    console.log("No events in outbox. Run with LEINA_EVENTS_PERSIST=1 to record events.");
    return;
  }

  if (wantJson) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  // Human-readable: one line per event — <iso-ts> <type> <id>
  for (const e of events) {
    const ts = new Date(e.ts).toISOString();
    console.log(`${ts} ${e.type} ${e.id}`);
  }
}
