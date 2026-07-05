// test/events.test.ts — R1–R8, R10: event outbox + CLI integration.
// node --no-warnings --experimental-strip-types --test test/events.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// R10: Aislamiento de tests — setup/teardown global con LEINA_HOME temporal
// ---------------------------------------------------------------------------

let tmpDir: string;
let savedEnvHome: string | undefined;
let savedEnvPersist: string | undefined;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "leina-events-test-"));
  savedEnvHome = process.env.LEINA_HOME;
  savedEnvPersist = process.env.LEINA_EVENTS_PERSIST;
  process.env.LEINA_HOME = tmpDir;
  // Default: sink off (DebugEventSink)
  delete process.env.LEINA_EVENTS_PERSIST;
});

after(() => {
  // Restore original env
  if (savedEnvHome !== undefined) {
    process.env.LEINA_HOME = savedEnvHome;
  } else {
    delete process.env.LEINA_HOME;
  }
  if (savedEnvPersist !== undefined) {
    process.env.LEINA_EVENTS_PERSIST = savedEnvPersist;
  } else {
    delete process.env.LEINA_EVENTS_PERSIST;
  }
  // Remove tmp dir — does NOT affect ~/.leina
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers — import AFTER env is set so wiring uses the tmp home
// ---------------------------------------------------------------------------

import { makeLeinaEvent } from "../src/domain/events/model.ts";
import { LocalEventStore } from "../src/infrastructure/events/local-event-store.ts";
import { DebugEventSink } from "../src/infrastructure/events/debug-event-sink.ts";
import { emitEvent } from "../src/application/events/emit.ts";
import { eventsOutboxPath, openEventSink, openEventStore } from "../src/cli/wiring.ts";
import { handleEventsTail } from "../src/cli/handlers/events.ts";
import { handleMemory } from "../src/cli/handlers/memory.ts";
import type { LeinaEvent } from "../src/domain/events/model.ts";

// Spy helper — intercepts process.stdout.write and returns captured chunks.
function spyStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, _enc?: unknown, _cb?: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  return {
    chunks,
    restore: () => { process.stdout.write = orig; },
  };
}

function makeTestEvent(): LeinaEvent {
  return makeLeinaEvent(
    "graph.built",
    { root: "/tmp/proj", nodes: 10, edges: 5, filesScanned: 3, filesExtracted: 3 },
    () => "test-id-fixed",
  );
}

// ---------------------------------------------------------------------------
// R1: Aislamiento de dominio — domain/events/* no importa fuera de domain/
// ---------------------------------------------------------------------------

test("(R1-S1.1) domain/events: ningún archivo importa application/, infrastructure/ o cli/", () => {
  // fileURLToPath, NOT URL.pathname — pathname yields "/D:/…" on Windows (ENOENT).
  const domainDir = fileURLToPath(new URL("../src/domain/events", import.meta.url));
  const files = ["model.ts", "store.ts", "sink.ts", "redactor.ts"];
  const forbidden = /application\/|infrastructure\/|cli\//;
  for (const file of files) {
    const content = readFileSync(join(domainDir, file), "utf8");
    const importLines = content.split("\n").filter((l) => l.startsWith("import"));
    for (const line of importLines) {
      assert.ok(
        !forbidden.test(line),
        `domain/events/${file} contiene import prohibido: ${line}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// R2: LocalEventStore — append + read round-trip; formato JSONL exacto
// ---------------------------------------------------------------------------

test("(R2-S2.1) LocalEventStore append+read round-trip", () => {
  const outbox = join(tmpDir, "r2-test", "outbox.jsonl");
  const store = new LocalEventStore(outbox);
  const event = makeTestEvent();

  store.append(event);
  const events = store.read();

  assert.equal(events.length, 1);
  assert.deepStrictEqual(events[0], event);
});

test("(R2-S2.2) LocalEventStore línea JSONL = JSON.stringify(event)+'\\n'", () => {
  const outbox = join(tmpDir, "r2-format", "outbox.jsonl");
  const store = new LocalEventStore(outbox);
  const event = makeTestEvent();

  store.append(event);

  const raw = readFileSync(outbox, "utf8");
  const expectedLine = `${JSON.stringify(event)  }\n`;
  assert.strictEqual(raw, expectedLine);
});

test("(R2) LocalEventStore múltiples eventos → múltiples líneas", () => {
  const outbox = join(tmpDir, "r2-multi", "outbox.jsonl");
  const store = new LocalEventStore(outbox);
  const e1 = makeLeinaEvent("graph.built", { root: "/a", nodes: 1, edges: 0, filesScanned: 1, filesExtracted: 1 }, () => "id1");
  const e2 = makeLeinaEvent("memory.created", { id: "obs1", type: "manual", evolved: false, revision: 1 }, () => "id2");

  store.append(e1);
  store.append(e2);

  const events = store.read();
  assert.equal(events.length, 2);
  assert.strictEqual(events[0]?.id, "id1");
  assert.strictEqual(events[1]?.id, "id2");
});

test("(R2) LocalEventStore.read() con archivo inexistente → array vacío", () => {
  const outbox = join(tmpDir, "r2-empty", "nonexistent.jsonl");
  const store = new LocalEventStore(outbox);
  assert.deepStrictEqual(store.read(), []);
});

// ---------------------------------------------------------------------------
// R3: DebugEventSink — no-op puro (cero stdout/stderr)
// ---------------------------------------------------------------------------

test("(R3-S3.1) DebugEventSink.emit no escribe a stdout ni stderr", async () => {
  const stderrChunks: string[] = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  });

  const spy = spyStdout();
  try {
    const sink = new DebugEventSink();
    await sink.emit(makeTestEvent());
  } finally {
    spy.restore();
    process.stderr.write = origStderr;
  }

  assert.equal(spy.chunks.length, 0, "DebugEventSink should not write to stdout");
  assert.equal(stderrChunks.length, 0, "DebugEventSink should not write to stderr");
});

test("(R3) DebugEventSink.emit no crea archivos (no afecta tmpDir/events/)", () => {
  const outboxPath = join(tmpDir, "events", "outbox.jsonl");
  const existedBefore = existsSync(outboxPath);

  // (If it already exists from a previous test, skip this check)
  if (!existedBefore) {
    void new DebugEventSink().emit(makeTestEvent());
    assert.ok(!existsSync(outboxPath), "DebugEventSink should not create outbox file");
  }
});

// ---------------------------------------------------------------------------
// R4: emitEvent — fail-open
// ---------------------------------------------------------------------------

test("(R4-S4.1) emitEvent no lanza aunque sink rechace con Promise reject", async () => {
  const throwingSink = {
    emit: async (_e: unknown): Promise<void> => { throw new Error("kaboom"); },
  };
  // Should not throw
  await assert.doesNotReject(
    () => emitEvent(throwingSink, makeTestEvent()),
    "emitEvent debe ser fail-open",
  );
});

test("(R4) emitEvent con sink sincrónico que lanza → no lanza", async () => {
  const throwingSink = {
    emit: (_e: unknown): Promise<void> => { throw new Error("sync kaboom"); },
  };
  await assert.doesNotReject(() => emitEvent(throwingSink, makeTestEvent()));
});

// ---------------------------------------------------------------------------
// R5: openEventSink — factory en wiring.ts
// ---------------------------------------------------------------------------

test("(R5-S5.1) openEventSink sin PERSIST → DebugEventSink", () => {
  delete process.env.LEINA_EVENTS_PERSIST;
  const sink = openEventSink();
  assert.ok(sink instanceof DebugEventSink, `expected DebugEventSink, got ${sink.constructor.name}`);
});

test("(R5-S5.2) openEventSink con PERSIST=1 → LocalEventStore con path correcto", () => {
  process.env.LEINA_EVENTS_PERSIST = "1";
  try {
    const sink = openEventSink();
    assert.ok(
      sink instanceof LocalEventStore,
      `expected LocalEventStore, got ${sink.constructor.name}`,
    );
    // Verify path: should be tmpDir/events/outbox.jsonl
    const expectedPath = join(tmpDir, "events", "outbox.jsonl");
    assert.strictEqual(eventsOutboxPath(), expectedPath);
  } finally {
    delete process.env.LEINA_EVENTS_PERSIST;
  }
});

test("(R5) openEventSink con PERSIST=0 → DebugEventSink", () => {
  process.env.LEINA_EVENTS_PERSIST = "0";
  try {
    const sink = openEventSink();
    assert.ok(sink instanceof DebugEventSink);
  } finally {
    delete process.env.LEINA_EVENTS_PERSIST;
  }
});

// ---------------------------------------------------------------------------
// R6/S6.1: emisión en handlers — PERSIST=1 → outbox tiene evento correcto
// ---------------------------------------------------------------------------

test("(R6-S6.1) handleMemory save con PERSIST=1 → outbox contiene memory.created", async () => {
  process.env.LEINA_EVENTS_PERSIST = "1";
  const memDir = join(tmpDir, "mem-r6");
  try {
    await handleMemory([
      "save",
      memDir,
      "--title", "test-r6",
      "--content", "content for r6 test",
      "--type", "architecture",
    ]);

    const store = openEventStore();
    const events = store.read();
    const memEvents = events.filter((e) => e.type === "memory.created");
    assert.ok(memEvents.length >= 1, "should have at least one memory.created event");
    const ev = memEvents[memEvents.length - 1];
    assert.ok(ev !== undefined, "last memory.created event must exist");
    assert.strictEqual(ev.schemaVersion, 1);
    assert.strictEqual(ev.type, "memory.created");
    const payload = ev.payload;
    assert.strictEqual(payload.type, "architecture");
    assert.ok(typeof payload.id === "string");
    assert.strictEqual(typeof payload.evolved, "boolean");
    assert.strictEqual(typeof payload.revision, "number");
  } finally {
    delete process.env.LEINA_EVENTS_PERSIST;
  }
});

// ---------------------------------------------------------------------------
// R6/S6.2: stdout idéntico con sink off
// ---------------------------------------------------------------------------

test("(R6-S6.2) handleMemory save con sink off → stdout solo tiene la línea 'Saved'", async () => {
  delete process.env.LEINA_EVENTS_PERSIST;
  const memDir = join(tmpDir, "mem-s62");

  const spy = spyStdout();
  try {
    await handleMemory([
      "save",
      memDir,
      "--title", "golden-s62",
      "--content", "content s62",
      "--type", "manual",
    ]);
  } finally {
    spy.restore();
  }

  const output = spy.chunks.join("");
  const lines = output.trim().split("\n").filter(Boolean);

  // Exactly 1 line of output
  assert.equal(lines.length, 1, `expected 1 line, got ${lines.length}: ${JSON.stringify(output)}`);
  // Line format: "Saved manual #<id> ..."
  const firstLine = lines[0] ?? "";
  assert.ok(firstLine.startsWith("Saved manual #"), `line should start with 'Saved manual #', got: ${firstLine}`);
  // No event-related text leaked to stdout
  assert.ok(!output.includes("graph.built"), "no event type in stdout");
  assert.ok(!output.includes("memory.created"), "no event type in stdout");
  assert.ok(!output.includes("schemaVersion"), "no event envelope in stdout");
});

// ---------------------------------------------------------------------------
// R7: schemaVersion siempre es 1
// ---------------------------------------------------------------------------

test("(R7-S7.1) makeLeinaEvent type graph.built → schemaVersion === 1", () => {
  const e = makeLeinaEvent("graph.built", { root: "/x", nodes: 1, edges: 0, filesScanned: 1, filesExtracted: 1 });
  assert.strictEqual(e.schemaVersion, 1);
});

test("(R7-S7.1) makeLeinaEvent type memory.created → schemaVersion === 1", () => {
  const e = makeLeinaEvent("memory.created", { id: "obs1", type: "manual", evolved: false, revision: 1 });
  assert.strictEqual(e.schemaVersion, 1);
});

test("(R7-S7.1) makeLeinaEvent type audit.completed → schemaVersion === 1", () => {
  const e = makeLeinaEvent("audit.completed", { pathsFound: 0, prunedPaths: 0, findingsCount: 0, reposInvolved: [], packVersion: 3 });
  assert.strictEqual(e.schemaVersion, 1);
  assert.strictEqual((e.payload).packVersion, 3);
});

// ---------------------------------------------------------------------------
// R8: events tail [--json]
// ---------------------------------------------------------------------------

test("(R8-S8.1) handleEventsTail --json con outbox de N eventos → JSON array", () => {
  // Pre-populate outbox with known events
  const outbox = eventsOutboxPath();
  const store = new LocalEventStore(outbox);
  const e1 = makeLeinaEvent("graph.built", { root: "/a", nodes: 1, edges: 0, filesScanned: 1, filesExtracted: 1 }, () => "r8-id-1");
  const e2 = makeLeinaEvent("audit.completed", { pathsFound: 0, prunedPaths: 0, findingsCount: 0, reposInvolved: [], packVersion: 3 }, () => "r8-id-2");
  store.append(e1);
  store.append(e2);

  const spy = spyStdout();
  try {
    handleEventsTail(["tail", "--json"]);
  } finally {
    spy.restore();
  }

  const output = spy.chunks.join("");
  let parsed: unknown[];
  try {
    parsed = JSON.parse(output) as unknown[];
  } catch {
    assert.fail(`stdout should be valid JSON array, got: ${output}`);
  }
  assert.ok(Array.isArray(parsed), "should be an array");
  // Contains at least our 2 events (may have more from other tests)
  assert.ok(parsed.length >= 2, `expected at least 2 events, got ${parsed.length}`);
  const ids = parsed.map((e) => (e as Record<string, unknown>).id);
  assert.ok(ids.includes("r8-id-1"), "should contain r8-id-1 event");
  assert.ok(ids.includes("r8-id-2"), "should contain r8-id-2 event");
});

test("(R8-S8.2) handleEventsTail sin --json → N líneas legibles", () => {
  const outbox = eventsOutboxPath();
  // Read existing events (from S8.1 test above)
  const store = new LocalEventStore(outbox);
  const existingCount = store.read().length;

  const spy = spyStdout();
  try {
    handleEventsTail(["tail"]);
  } finally {
    spy.restore();
  }

  const output = spy.chunks.join("");
  const lines = output.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, existingCount, `expected ${existingCount} lines, got ${lines.length}`);
  // Each line should have format: <iso-ts> <type> <id>
  for (const line of lines) {
    const parts = line.split(" ");
    assert.ok(parts.length >= 3, `line should have ≥3 parts: "${line}"`);
    // First part should be ISO timestamp
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(parts[0] ?? ""), `first part should be ISO ts: "${parts[0]}"`);
  }
});

test("(R8-S8.3) handleEventsTail con outbox inexistente → no lanza + mensaje informativo", () => {
  // Use a fresh home where no events exist
  const freshHome = mkdtempSync(join(tmpdir(), "leina-r8-empty-"));
  const savedHome = process.env.LEINA_HOME;
  process.env.LEINA_HOME = freshHome;

  const spy = spyStdout();
  try {
    assert.doesNotThrow(() => handleEventsTail(["tail"]), "should not throw");
    const output = spy.chunks.join("");
    // Should print an informative message (not a stack trace)
    assert.ok(output.length > 0, "should print something");
    assert.ok(!output.includes("Error"), "should not print stack trace");
    assert.ok(!output.toLowerCase().includes("at "), "should not print stack trace frames");
  } finally {
    spy.restore();
    process.env.LEINA_HOME = savedHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});
