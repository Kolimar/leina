// infrastructure/sqlite/ts-extract-cache.ts — per-file TypeScript extraction cache.
//
// The TypeScript extractor's result for a file depends on more than its bytes: on the
// declarations it reaches through the checker. So each row also records what decides
// whether the result can be reused after other files change (ts-plan.ts): the file's shape,
// whether it is global, and its module specifiers with what each resolved to — the
// dependency graph of the previous build. `ts_aux` holds the content hashes of the
// non-listed project files the checker loaded (a `.js` or `.json` import, a sibling package
// outside the root): those have no row of their own, so any change to one forces a full
// extraction.
//
// Lives next to the tree-sitter cache in <root>/.leina/extract-cache.db, in tables of its own.
// All rows are replaced in one transaction at the end of a successful extraction, and a
// key mismatch (leina version, cache format, compiler options, lockfiles) discards them.
// Failures never break a build: reads degrade to "no cache", writes are dropped.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphEdge, GraphNode } from "../../domain/graph/model.ts";
import { extractCachePath } from "./extract-cache.ts";

/** Bump when the stored row shape or the meaning of a cached result changes. */
export const TS_EXTRACT_CACHE_FORMAT = 1;

/** A module specifier of a file: [text, resolution mode, resolved root-relative path | null]. */
export type TsSpec = [text: string, mode: number | null, resolved: string | null];

export interface TsCachedFile {
  hash: string;
  shape: string;
  global: boolean;
  specs: TsSpec[];
}

export interface TsFileOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TsCacheRow extends TsCachedFile {
  result: TsFileOutput;
}

export interface TsCacheSnapshot {
  files: Map<string, TsCachedFile>;
  aux: Map<string, string>;
}

export interface TsCacheUpdate {
  /** Replace every row (full extraction) instead of upserting `files` and deleting `removed`. */
  replaceAll: boolean;
  files: Map<string, TsCacheRow>;
  removed: string[];
  aux: Map<string, string>;
}

export class TsExtractCache {
  private db: DatabaseSync | null;
  private readonly key: string;

  /** `key` identifies everything a cached result assumes beyond the files themselves. */
  constructor(root: string, key: string) {
    this.key = `${TS_EXTRACT_CACHE_FORMAT}\u0000${key}`;
    try {
      const p = extractCachePath(root);
      mkdirSync(dirname(p), { recursive: true });
      this.db = new DatabaseSync(p);
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ts_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ts_files (
          path TEXT PRIMARY KEY, hash TEXT NOT NULL, shape TEXT NOT NULL, global INTEGER NOT NULL,
          specs TEXT NOT NULL, result TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ts_aux (path TEXT PRIMARY KEY, hash TEXT NOT NULL);
      `);
    } catch {
      this.db = null; // cache unavailable (read-only fs, …): every build extracts in full
    }
  }

  /** The previous build's index, or null when there is none valid for this key. */
  snapshot(): TsCacheSnapshot | null {
    if (this.db === null) return null;
    try {
      const meta = this.db.prepare(`SELECT v FROM ts_meta WHERE k = 'key'`).get() as { v: string } | undefined;
      if (meta?.v !== this.key) return null;
      const files = new Map<string, TsCachedFile>();
      const rows = this.db.prepare(`SELECT path, hash, shape, global, specs FROM ts_files`).all() as unknown as {
        path: string;
        hash: string;
        shape: string;
        global: number;
        specs: string;
      }[];
      for (const r of rows) {
        files.set(r.path, { hash: r.hash, shape: r.shape, global: r.global !== 0, specs: JSON.parse(r.specs) as TsSpec[] });
      }
      const aux = new Map<string, string>();
      for (const r of this.db.prepare(`SELECT path, hash FROM ts_aux`).all() as unknown as { path: string; hash: string }[]) {
        aux.set(r.path, r.hash);
      }
      return { files, aux };
    } catch {
      return null;
    }
  }

  /** Cached results of `paths` (absent paths are left out; null when the cache is unreadable). */
  results(paths: Iterable<string>): Map<string, TsFileOutput> | null {
    if (this.db === null) return null;
    try {
      const get = this.db.prepare(`SELECT result FROM ts_files WHERE path = ?`);
      const out = new Map<string, TsFileOutput>();
      for (const p of paths) {
        const row = get.get(p) as { result: string } | undefined;
        if (row !== undefined) out.set(p, JSON.parse(row.result) as TsFileOutput);
      }
      return out;
    } catch {
      return null;
    }
  }

  /** Apply one extraction's rows atomically. A failed write leaves the previous cache whole. */
  write(update: TsCacheUpdate): void {
    if (this.db === null) return;
    const db = this.db;
    try {
      db.exec("BEGIN");
      try {
        if (update.replaceAll) {
          db.exec("DELETE FROM ts_files; DELETE FROM ts_aux;");
        } else {
          const del = db.prepare(`DELETE FROM ts_files WHERE path = ?`);
          for (const p of update.removed) del.run(p);
        }
        const put = db.prepare(
          `INSERT INTO ts_files (path, hash, shape, global, specs, result) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, shape=excluded.shape,
               global=excluded.global, specs=excluded.specs, result=excluded.result`,
        );
        for (const [p, r] of update.files) {
          put.run(p, r.hash, r.shape, r.global ? 1 : 0, JSON.stringify(r.specs), JSON.stringify(r.result));
        }
        const aux = db.prepare(
          `INSERT INTO ts_aux (path, hash) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash`,
        );
        for (const [p, h] of update.aux) aux.run(p, h);
        db.prepare(`INSERT INTO ts_meta (k, v) VALUES ('key', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(
          this.key,
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } catch {
      /* a cache write failure is not a build failure: the next build extracts more */
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }
}
