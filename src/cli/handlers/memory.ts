// cli/handlers/memory.ts — `leina memory <sub>` command handler.
// sub-commands: save | update | search | verified | get | context | session |
//               session-start | suggest-topic | current-project | merge-projects | migrate
//
// handleMemory is a thin dispatcher: it resolves <dir> and routes to a per-subcommand
// function (each kept under the Cognitive-Complexity gate) via MEM_HANDLERS.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { formatBatchResults } from "../../domain/shared/batch.ts";
import { getVerifiedContext } from "../../application/memory/query.ts";
import type {
  ExportedObservation,
  ObservationInput,
  ObservationType,
  Scope,
  UpdateFields,
} from "../../domain/memory/model.ts";
import { makeId } from "../../domain/shared/id.ts";
import { AmbiguousProjectError, deriveProjectKey } from "../../application/project/detect-key.ts";
import { memOpenGuarded, openEventSink } from "../wiring.ts";
import { makeLeinaEvent } from "../../domain/events/model.ts";
import { emitEvent } from "../../application/events/emit.ts";
import { fail, readStdin } from "../io.ts";
import { hasFlag, optFlag, parseBatchInput } from "../args.ts";

// MemSubHandler allows async sub-handlers (needed for memSave which calls emitEvent — D3).
type MemSubHandler = (rest: string[], dir: string) => void | Promise<void>;

// Batch items may carry anchors as string[] (canonical) or as the same
// comma-separated string the --anchors flag accepts. Anything else is a hard
// error — a blind cast here once stored single-character anchors in real DBs.
function normalizeAnchors(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw.split(",").map((a) => a.trim()).filter(Boolean);
  if (Array.isArray(raw) && raw.every((a): a is string => typeof a === "string")) {
    return raw.map((a) => a.trim()).filter(Boolean);
  }
  throw new TypeError("anchors must be a string[] or a comma-separated string");
}

async function memSave(rest: string[], dir: string): Promise<void> {
  const { store, close } = memOpenGuarded(dir);
  try {
    if (hasFlag(rest, "--batch")) {
      // stdin: JSON array of { title, content, type?, topicKey?, scope?, anchors? }
      const items = parseBatchInput<ObservationInput>(readStdin(), (raw) => {
        if (typeof raw.title !== "string" || typeof raw.content !== "string") {
          throw new TypeError("each item requires string title and content");
        }
        return {
          title: raw.title,
          content: raw.content,
          type: (raw.type as ObservationType) ?? "manual",
          topicKey: raw.topicKey as string | undefined,
          scope: (raw.scope as Scope) ?? "project",
          anchors: normalizeAnchors(raw.anchors),
        };
      });
      const results = store.saveBatch(items, { atomic: hasFlag(rest, "--atomic") });
      console.log(
        formatBatchResults(results, (d) => {
          const status = d.evolved ? `evolved rev ${d.observation.revision}` : "new";
          return `${d.observation.type} #${d.observation.id} (${status}). topic_key: ${d.observation.topicKey ?? "—"}`;
        }),
      );
      return;
    }
    const titleIdx = rest.indexOf("--title");
    const contentIdx = rest.indexOf("--content");
    const title = titleIdx >= 0 ? (rest[titleIdx + 1] ?? fail("--title requires a value")) : fail("memory save requires --title");
    const content = contentIdx >= 0 ? (rest[contentIdx + 1] ?? fail("--content requires a value")) : fail("memory save requires --content");
    const type = (optFlag(rest, "--type", "manual") ?? "manual") as ObservationType;
    const topicKey = optFlag(rest, "--topic", undefined);
    const scope = (optFlag(rest, "--scope", "project") ?? "project") as Scope;
    const anchorsRaw = optFlag(rest, "--anchors", undefined);
    const anchors = anchorsRaw ? anchorsRaw.split(",").map((a) => a.trim()).filter(Boolean) : undefined;
    const { observation, evolved } = store.save({ title, content, type, topicKey, scope, anchors });
    const status = evolved ? `evolved rev ${observation.revision}` : "new";
    console.log(`Saved ${observation.type} #${observation.id} (${status}). topic_key: ${observation.topicKey ?? "—"}`);
    // Emit memory.created event (rama single, DESPUÉS del console.log — R6, D3, task 3.5).
    await emitEvent(
      openEventSink(),
      makeLeinaEvent("memory.created", {
        id: observation.id,
        type: observation.type,
        topicKey: observation.topicKey,
        evolved,
        revision: observation.revision,
      }),
    );
  } finally {
    close();
  }
}

function memUpdate(rest: string[], dir: string): void {
  const { store, close } = memOpenGuarded(dir);
  try {
    if (hasFlag(rest, "--batch")) {
      // stdin: JSON array of { id, title?, content?, type?, anchors? }
      const items = parseBatchInput<{ id: string; fields: UpdateFields }>(readStdin(), (raw) => {
        if (typeof raw.id !== "string") throw new Error("each item requires a string id");
        const fields: UpdateFields = {};
        if (typeof raw.title === "string") fields.title = raw.title;
        if (typeof raw.content === "string") fields.content = raw.content;
        if (typeof raw.type === "string") fields.type = raw.type as ObservationType;
        const anchors = normalizeAnchors(raw.anchors);
        if (anchors !== undefined) fields.anchors = anchors;
        return { id: raw.id, fields };
      });
      const results = store.updateBatch(items, { atomic: hasFlag(rest, "--atomic") });
      console.log(formatBatchResults(results, (o) => `#${o.id} (rev ${o.revision})`));
      return;
    }
    const id = rest[2] && !rest[2].startsWith("--") ? rest[2] : fail("usage: memory update <dir> <id> [--title ..] [--content ..] [--type ..]");
    const fields: UpdateFields = {};
    const title = optFlag(rest, "--title", undefined);
    const content = optFlag(rest, "--content", undefined);
    const type = optFlag(rest, "--type", undefined);
    const anchorsRaw = optFlag(rest, "--anchors", undefined);
    if (title !== undefined) fields.title = title;
    if (content !== undefined) fields.content = content;
    if (type !== undefined) fields.type = type as ObservationType;
    if (anchorsRaw !== undefined) fields.anchors = anchorsRaw.split(",").map((a) => a.trim()).filter(Boolean);
    const obs = store.update(id, fields);
    console.log(`Updated #${obs.id} (rev ${obs.revision}).`);
  } finally {
    close();
  }
}

function memSearch(rest: string[], dir: string): void {
  const query = rest.slice(2).filter((a) => !a.startsWith("--")).join(" ") || fail("memory search requires a query");
  const type = optFlag(rest, "--type", undefined) as ObservationType | undefined;
  const scope = (optFlag(rest, "--scope", "project") ?? "project") as Scope;
  const limit = Number(optFlag(rest, "--limit", "10"));
  const { store, close } = memOpenGuarded(dir);
  const hits = store.search(query, { type, scope, limit });
  close();
  if (hits.length === 0) {
    console.log(`No results for "${query}"`);
    return;
  }
  for (const h of hits) {
    const tk = h.topicKey ? ` [${h.topicKey}]` : "";
    console.log(`#${h.id} [${h.type}]${tk} ${h.title}`);
    console.log(`  ${h.snippet}`);
  }
}

function memVerified(rest: string[], dir: string): void {
  // Search + classify each hit against the live graph (drift detection).
  const query = rest.slice(2).filter((a) => !a.startsWith("--")).join(" ") || fail("memory verified requires a query");
  const type = optFlag(rest, "--type", undefined) as ObservationType | undefined;
  const scope = (optFlag(rest, "--scope", "project") ?? "project") as Scope;
  const limit = Number(optFlag(rest, "--limit", "10"));
  const { store, verifyNode, close } = memOpenGuarded(dir);
  const ctx = getVerifiedContext(store, query, verifyNode, { type, scope, limit });
  close();
  if (ctx.graphError) console.log(`(graph unavailable: ${ctx.graphError} — verdicts degraded to unverified)\n`);
  const section = (label: string, items: typeof ctx.usable) => {
    console.log(`${label} (${items.length}):`);
    for (const it of items) {
      const tk = it.topicKey ? ` [${it.topicKey}]` : "";
      const flag = it.checkViolation ? "  ⚠ check-violation" : "";
      console.log(`  #${it.id} [${it.type}/${it.state}]${tk} ${it.title}${flag}`);
      console.log(`    ${it.reason}`);
    }
  };
  section("USABLE", ctx.usable);
  section("WARNING", ctx.warning);
  section("DO NOT USE", ctx.doNotUse);
}

function memGet(rest: string[], dir: string): void {
  const { store, close } = memOpenGuarded(dir);
  try {
    if (hasFlag(rest, "--batch")) {
      // stdin: JSON array of id strings
      const ids = parseBatchInput<string>(readStdin(), (raw) => {
        // parseBatchInput passes objects; for a bare-string array we accept {0:..} too.
        throw new Error(`expected an array of id strings: ${JSON.stringify(raw)}`);
      }, true);
      const results = store.getBatch(ids);
      console.log(formatBatchResults(results, (o) => `#${o.id} [${o.type}] ${o.title}`));
      return;
    }
    const id = rest[2] ?? fail("memory get requires an id");
    const obs = store.get(id);
    if (obs) {
      const tk = obs.topicKey ? `\ntopic_key: ${obs.topicKey}` : "";
      console.log(`title: ${obs.title}\ntype: ${obs.type}${tk}`);
      console.log(`created: ${new Date(obs.createdAt).toISOString()}  updated: ${new Date(obs.updatedAt).toISOString()}  revision: ${obs.revision}`);
      console.log(`\n${obs.content}`);
    } else {
      console.log(`No observation found with id "${id}"`);
    }
  } finally {
    close();
  }
}

function memContext(rest: string[], dir: string): void {
  const limit = Number(optFlag(rest, "--limit", "10"));
  const { store, close } = memOpenGuarded(dir);
  const { sessions, observations } = store.recentContext({ limit });
  close();
  console.log("RECENT SESSIONS:");
  if (sessions.length === 0) console.log("  (none)");
  for (const s of sessions) {
    const ended = s.endedAt ? ` → ${new Date(s.endedAt).toISOString()}` : " (open)";
    console.log(`  #${s.id} ${s.title ?? "(untitled)"} ${new Date(s.startedAt).toISOString()}${ended}`);
    if (s.summary) console.log(`    ${s.summary.slice(0, 120)}`);
  }
  console.log("\nRECENT OBSERVATIONS:");
  if (observations.length === 0) console.log("  (none)");
  for (const o of observations) {
    const tk = o.topicKey ? ` [${o.topicKey}]` : "";
    console.log(`  #${o.id} [${o.type}]${tk} ${o.title}`);
  }
}

function memSession(rest: string[], dir: string): void {
  // leina memory session <dir> --content "summary text" [--title "..."]
  const content = optFlag(rest, "--content", undefined) ?? fail("memory session requires --content");
  const title = optFlag(rest, "--title", undefined);
  const { store, close } = memOpenGuarded(dir);
  const session = store.saveSession(content, { title });
  close();
  console.log(`Session summary saved: #${session.id}`);
}

function memSessionStart(rest: string[], dir: string): void {
  // Open a fresh session and print its id (for callers that want to group observations).
  const title = optFlag(rest, "--title", undefined);
  const { store, close } = memOpenGuarded(dir);
  const session = store.startSession(title);
  close();
  console.log(`Session started: #${session.id}`);
}

function memSuggestTopic(rest: string[], dir: string): void {
  const title = optFlag(rest, "--title", undefined) ?? fail("memory suggest-topic requires --title");
  const type = optFlag(rest, "--type", "manual") ?? "manual";
  const { store, close } = memOpenGuarded(dir);
  const s = store.suggestTopicKeyWithMatches(title, type);
  close();
  console.log(`suggestion: ${s.suggestion}`);
  if (s.nearMatches.length > 0) console.log(`near matches: ${s.nearMatches.join(", ")}`);
}

function memCurrentProject(_rest: string[], dir: string): void {
  // memory current-project <dir> — print derived project key + method (no DB needed)
  const cpDir = resolvePath(dir);
  if (!existsSync(cpDir)) fail(`directory not found: ${cpDir}`);
  let det: ReturnType<typeof deriveProjectKey>;
  try {
    det = deriveProjectKey(cpDir);
  } catch (e) {
    if (e instanceof AmbiguousProjectError) {
      console.error(
        `Ambiguous project — found multiple git repos: ${e.candidates.join(", ")}.\n` +
          `Resolve by creating .leina/config.json with {"project_name":"<name>"}.`,
      );
      process.exit(1);
    }
    throw e;
  }
  console.log(`project_key: ${det.key}`);
  console.log(`method: ${det.method}`);
  if (det.rawName) console.log(`raw_name: ${det.rawName}`);
}

function memMergeProjects(rest: string[], dir: string): void {
  // memory merge-projects <dir> --from <src-key> --to <dst-key> [--dry-run]
  const fromKey = optFlag(rest, "--from", undefined);
  const toKey = optFlag(rest, "--to", undefined);
  if (!fromKey || !toKey) {
    fail("usage: memory merge-projects <dir> --from <src-key> --to <dst-key> [--dry-run]");
  }
  if (fromKey === toKey) fail("--from and --to must differ");
  const dryRun = hasFlag(rest, "--dry-run");
  const { store, close } = memOpenGuarded(dir);
  try {
    const r = store.mergeProject(fromKey, toKey, { dryRun });
    const prefix = dryRun ? "[dry-run] would move" : "moved";
    const supersededNote = r.superseded > 0 ? `; ${r.superseded} row(s) superseded (topic collision)` : "";
    console.log(`${prefix} ${r.moved} row(s) from ${fromKey} => ${toKey}${supersededNote}`);
  } finally {
    close();
  }
}

function memMigrate(_rest: string[], dir: string): void {
  // memory migrate <dir> — fold legacy per-repo memory.db into global memory
  const migrateDir = resolvePath(dir);
  const legacyDbPath = join(migrateDir, ".leina", "memory.db");
  if (!existsSync(legacyDbPath)) {
    console.log(`no legacy memory.db at ${legacyDbPath}; nothing to migrate`);
    return;
  }
  const fromKey = makeId(legacyDbPath.replaceAll("\\", "/").split("/").at(-3) ?? "unknown");
  let toKey: string;
  try {
    toKey = deriveProjectKey(migrateDir).key;
  } catch (e) {
    if (e instanceof AmbiguousProjectError) {
      fail(
        `Ambiguous project — cannot determine target key. Candidates: ${e.candidates.join(", ")}.\n` +
          `Create .leina/config.json with {"project_name":"<name>"} then re-run.`,
      );
    }
    throw e;
  }
  const { store, close } = memOpenGuarded(migrateDir);
  try {
    const r = store.importFromLegacy(legacyDbPath, fromKey, toKey);
    console.log(`migrated: ${r.moved} inserted, ${r.skipped} skipped as duplicates`);
    console.log(`key mapping: ${fromKey} => ${toKey}`);
    console.log(`the original file was not modified.`);
  } finally {
    close();
  }
}

function memHelp(): void {
  console.log(
    `leina memory <dir> <sub-command>\n\n` +
      `  save <dir> --title "..." --content "..." [--type decision|bugfix|...] [--topic key]\n` +
      `             [--scope project|personal|workspace|path|skill|process|technology|security|infra]\n` +
      `             [--anchors a,b]\n` +
      `  save <dir> --batch [--atomic]      (stdin: JSON array of {title,content,type?,topicKey?,scope?,anchors?})\n` +
      `  update <dir> <id> [--title ..] [--content ..] [--type ..] [--anchors a,b]\n` +
      `  update <dir> --batch [--atomic]    (stdin: JSON array of {id,title?,content?,type?,anchors?})\n` +
      `  search <dir> <query> [--type ..]\n` +
      `         [--scope project|personal|workspace|path|skill|process|technology|security|infra]\n` +
      `         [--limit N]\n` +
      `  verified <dir> <query> [--type ..]\n` +
      `           [--scope project|personal|workspace|path|skill|process|technology|security|infra]\n` +
      `           [--limit N]   (drift-checked context)\n` +
      `  get <dir> <id>\n` +
      `  get <dir> --batch                  (stdin: JSON array of id strings)\n` +
      `  context <dir> [--limit N]\n` +
      `  session <dir> --content "summary" [--title "..."]\n` +
      `  session-start <dir> [--title "..."]\n` +
      `  suggest-topic <dir> --title "..." [--type ..]\n` +
      `  current-project <dir>              (show derived project key + detection method)\n` +
      `  merge-projects <dir> --from <key> --to <key> [--dry-run]  (rename/merge project keys)\n` +
      `  migrate <dir>                      (fold legacy per-repo memory.db into global memory)\n` +
      `  export <dir> [--out file.jsonl]    (dump this project's observations+anchors as JSONL)\n` +
      `  import <dir> [--in file.jsonl]     (merge an export from stdin/file; newer revision wins)\n` +
      `  sync <dir>                         (two-way merge with committable .leina/memory-export.jsonl)\n`,
  );
}


// ---------------------------------------------------------------------------
// Portable memory: export / import / sync
// ---------------------------------------------------------------------------

const SNAPSHOT_REL = ".leina/memory-export.jsonl";

function toJsonl(items: ExportedObservation[]): string {
  return items.map((o) => JSON.stringify(o)).join("\n") + (items.length > 0 ? "\n" : "");
}

function parseJsonl(text: string): ExportedObservation[] {
  const out: ExportedObservation[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    const t = line.trim();
    if (t === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      fail(`memory import: line ${i + 1} is not valid JSON`);
    }
    const o = obj as ExportedObservation;
    if (typeof o.id !== "string" || typeof o.title !== "string" || typeof o.revision !== "number") {
      fail(`memory import: line ${i + 1} is not an exported observation (id/title/revision required)`);
    }
    out.push({ ...o, anchors: Array.isArray(o.anchors) ? o.anchors : [] });
  }
  return out;
}

// memory export <dir> [--out <file>] — JSONL to stdout (or a file), deterministic order.
function memExport(rest: string[], dir: string): void {
  const outFile = optFlag(rest, "--out", undefined);
  const repo = memOpenGuarded(dir);
  try {
    const items = repo.store.exportAll();
    const jsonl = toJsonl(items);
    if (outFile !== undefined) {
      writeFileSync(resolvePath(outFile), jsonl);
      console.log(`exported ${items.length} observation(s) to ${resolvePath(outFile)}`);
    } else {
      process.stdout.write(jsonl);
    }
  } finally {
    repo.close();
  }
}

// memory import <dir> [--in <file>] — JSONL from stdin (or a file); deterministic merge.
function memImport(rest: string[], dir: string): void {
  const inFile = optFlag(rest, "--in", undefined);
  const text = inFile !== undefined ? readFileSync(resolvePath(inFile), "utf8") : readStdin();
  const items = parseJsonl(text);
  const repo = memOpenGuarded(dir);
  try {
    const r = repo.store.importObservations(items);
    console.log(
      `imported: ${r.inserted} new, ${r.updated} updated, ${r.skippedOlder} skipped (older), ` +
        `${r.topicConflicts} topic conflict(s) resolved`,
    );
  } finally {
    repo.close();
  }
}

// memory sync <dir> — two-way merge with the committable snapshot at .leina/memory-export.jsonl:
// absorb the file first (teammates' entries), then rewrite it from the merged DB. Commit the
// file and project memory travels with the repo — no server involved.
function memSync(_rest: string[], dir: string): void {
  const snapPath = join(resolvePath(dir), SNAPSHOT_REL);
  const repo = memOpenGuarded(dir);
  try {
    if (existsSync(snapPath)) {
      const r = repo.store.importObservations(parseJsonl(readFileSync(snapPath, "utf8")));
      console.log(
        `absorbed snapshot: ${r.inserted} new, ${r.updated} updated, ${r.skippedOlder} skipped, ` +
          `${r.topicConflicts} topic conflict(s)`,
      );
    }
    const items = repo.store.exportAll();
    mkdirSync(join(resolvePath(dir), ".leina"), { recursive: true });
    writeFileSync(snapPath, toJsonl(items));
    console.log(`snapshot written: ${snapPath} (${items.length} observation(s)) — commit it to share`);
  } finally {
    repo.close();
  }
}

const MEM_HANDLERS: Record<string, MemSubHandler> = {
  save: memSave,
  export: memExport,
  import: memImport,
  sync: memSync,
  update: memUpdate,
  search: memSearch,
  verified: memVerified,
  get: memGet,
  context: memContext,
  session: memSession,
  "session-start": memSessionStart,
  "suggest-topic": memSuggestTopic,
  "current-project": memCurrentProject,
  "merge-projects": memMergeProjects,
  migrate: memMigrate,
};

export async function handleMemory(rest: string[]): Promise<void> {
  const sub = rest[0];
  const dir = rest[1] && !rest[1].startsWith("--") ? rest[1] : ".";
  const handler: MemSubHandler = (sub !== undefined ? MEM_HANDLERS[sub] : undefined) ?? memHelp;
  await handler(rest, dir);
}
