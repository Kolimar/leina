// infrastructure/sqlite/extract-cache.ts — per-file extraction cache (incremental builds).
//
// Rebuilds used to re-parse every file. tree-sitter extraction is per-file and pure
// (content in → nodes/edges/rawCalls/imports out), so its results cache perfectly by
// CONTENT HASH: a rebuild re-parses only files whose bytes changed and rehydrates the
// rest. The global resolve/dedup phases still run over the combined set — they are the
// cheap part and they are what keeps cross-file edges correct.
//
// Scope: the tree-sitter extractor only. ts-morph is project-wide (the type checker's
// whole-program view is exactly what makes it compiler-grade) and sidecars run
// whole-project by design — neither can be per-file cached without losing precision.
//
// The cache lives NEXT to the graph (<root>/.leina/extract-cache.db) but survives
// store.clear(): it is keyed by (path) with (hash, version) validity — a version bump of
// the extractor or cache format invalidates naturally via key mismatch. Failures here
// must NEVER break a build: every method degrades to "cache miss" on error.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Bump to invalidate every cached entry (result shape or extraction semantics change). */
export const EXTRACT_CACHE_FORMAT = 1;

export interface CachedFileResult {
  nodes: unknown[];
  edges: unknown[];
  rawCalls: unknown[];
  imports: unknown[];
}

export function contentHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function extractCachePath(root: string): string {
  return join(root, ".leina", "extract-cache.db");
}

export class ExtractCache {
  private db: DatabaseSync | null;
  private readonly version: string;

  constructor(root: string, extractorVersion: string) {
    this.version = `${extractorVersion}:${EXTRACT_CACHE_FORMAT}`;
    try {
      const p = extractCachePath(root);
      mkdirSync(dirname(p), { recursive: true });
      this.db = new DatabaseSync(p);
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS extract_cache (
           path TEXT PRIMARY KEY, hash TEXT NOT NULL, version TEXT NOT NULL, result TEXT NOT NULL
         )`,
      );
    } catch {
      this.db = null; // cache unavailable (read-only fs, ...) → everything misses
    }
  }

  get(relPath: string, hash: string): CachedFileResult | null {
    if (this.db === null) return null;
    try {
      const row = this.db
        .prepare(`SELECT result FROM extract_cache WHERE path = ? AND hash = ? AND version = ?`)
        .get(relPath, hash, this.version) as unknown as { result: string } | undefined;
      return row === undefined ? null : (JSON.parse(row.result) as CachedFileResult);
    } catch {
      return null;
    }
  }

  put(relPath: string, hash: string, result: CachedFileResult): void {
    if (this.db === null) return;
    try {
      this.db
        .prepare(
          `INSERT INTO extract_cache (path, hash, version, result) VALUES (?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, version=excluded.version, result=excluded.result`,
        )
        .run(relPath, hash, this.version, JSON.stringify(result));
    } catch {
      /* cache write failure is not a build failure */
    }
  }

  /** Drop rows for files that no longer exist in the source set (bounded growth). */
  prune(livePaths: string[]): void {
    if (this.db === null) return;
    try {
      const live = new Set(livePaths);
      const rows = this.db.prepare(`SELECT path FROM extract_cache`).all() as unknown as { path: string }[];
      const del = this.db.prepare(`DELETE FROM extract_cache WHERE path = ?`);
      for (const r of rows) if (!live.has(r.path)) del.run(r.path);
    } catch {
      /* best-effort */
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
