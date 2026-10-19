// test/helpers/memory-v5-db.ts — an OLD-schema memory db fixture for migration tests.
//
// The DDL below is the memory schema exactly as v5 (2.x) shipped it, frozen here: the live
// DDL keeps growing columns, so building a fixture from it would no longer be "old".

import { DatabaseSync } from "node:sqlite";
import { fts5Available } from "../../src/infrastructure/sqlite/schema.ts";

const V5_DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
  title TEXT, summary TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE observations (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
  type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  topic_key TEXT, session_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT
);
CREATE UNIQUE INDEX uq_obs_topic ON observations(project_key, scope, topic_key)
  WHERE topic_key IS NOT NULL AND superseded_by IS NULL;
CREATE TABLE memory_anchors (
  observation_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'about',
  anchor_label TEXT, anchor_file TEXT, anchor_hash TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (observation_id, node_id, role)
);
`;
// The v5 FTS5 index + sync triggers (only on Node builds that have FTS5).
const V5_FTS_DDL = `
CREATE VIRTUAL TABLE obs_fts USING fts5(
  title, content, content='observations', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER obs_ai AFTER INSERT ON observations WHEN new.superseded_by IS NULL
BEGIN INSERT INTO obs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
CREATE TRIGGER obs_ad AFTER DELETE ON observations WHEN old.superseded_by IS NULL
BEGIN INSERT INTO obs_fts(obs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); END;
CREATE TRIGGER obs_au AFTER UPDATE ON observations WHEN old.superseded_by IS NULL AND new.superseded_by IS NULL
BEGIN
  INSERT INTO obs_fts(obs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO obs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
`;

/**
 * A v5 (2.x) memory db holding the given rows, all under project key `legacy`. Rows may
 * carry values the old unvalidated CLI could write (free-form types / scopes).
 */
export function makeV5MemoryDb(dbPath: string, rows: { id: string; type: string; scope?: string; topic?: string; supersededBy?: string; title?: string; content?: string }[]): void {
  const db = new DatabaseSync(dbPath);
  db.exec(V5_DDL);
  if (fts5Available(db)) db.exec(V5_FTS_DDL);
  const ins = db.prepare(
    `INSERT INTO observations (id, project_key, scope, type, title, content, topic_key, created_at, updated_at, revision, superseded_by)
     VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  let ts = 1_700_000_000_000;
  for (const r of rows) {
    ts += 1000;
    ins.run(r.id, r.scope ?? "project", r.type, r.title ?? `title ${r.id}`, r.content ?? `content ${r.id}`, r.topic ?? null, ts, ts, r.supersededBy ?? null);
  }
  db.exec("PRAGMA user_version = 5");
  db.close();
}

