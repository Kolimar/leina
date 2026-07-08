// Graph storage on top of Node 22's built-in node:sqlite (DatabaseSync).
// No native deps, no compilation — portable across machines.

import { DatabaseSync } from "node:sqlite";
import { normalizeLabel } from "../../domain/shared/id.ts";
import type {
  Confidence,
  EdgeContext,
  GraphEdge,
  GraphNode,
  NodeLinkGraph,
  Signature,
} from "../../domain/graph/model.ts";
import { KNOWN_NODE_KINDS, KNOWN_RELATIONS } from "../../domain/graph/model.ts";
import type { GraphRepository } from "../../domain/graph/ports.ts";

interface NodeRow {
  id: string;
  label: string;
  file_type: string;
  kind: string | null;
  source_file: string;
  source_location: string | null;
  community: number | null;
  signature: string | null;
  repo: string | null;
}

interface EdgeRow {
  source: string;
  target: string;
  relation: string;
  confidence: string;
  context: string;
  source_file: string;
  source_location: string | null;
  weight: number;
  repo: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  file_type TEXT NOT NULL,
  kind TEXT,
  source_file TEXT NOT NULL,
  source_location TEXT,
  community INTEGER,
  signature TEXT,
  repo TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL,
  source_location TEXT,
  weight REAL NOT NULL DEFAULT 1.0,
  repo TEXT,
  PRIMARY KEY (source, target, relation, context)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
CREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
`;

function rowToNode(r: NodeRow): GraphNode {
  const node: GraphNode = {
    id: r.id,
    label: r.label,
    fileType: r.file_type,
    sourceFile: r.source_file,
  };
  if (r.kind) node.kind = r.kind;
  if (r.source_location) node.sourceLocation = r.source_location;
  if (r.community !== null) node.community = r.community;
  if (r.signature) {
    try {
      node.signature = JSON.parse(r.signature) as Signature;
    } catch {
      // Corrupted JSON in an old row — skip gracefully rather than fail the read.
    }
  }
  if (r.repo) node.repo = r.repo;
  return node;
}

function rowToEdge(r: EdgeRow): GraphEdge {
  const edge: GraphEdge = {
    source: r.source,
    target: r.target,
    relation: r.relation,
    confidence: r.confidence as Confidence,
    sourceFile: r.source_file,
    weight: r.weight,
  };
  if (r.context) edge.context = r.context as EdgeContext;
  if (r.source_location) edge.sourceLocation = r.source_location;
  if (r.repo) edge.repo = r.repo;
  return edge;
}

const GRAPH_SCHEMA_VERSION = 4;

// v1 -> v2: add `signature TEXT` column to `nodes` for structured function
// signatures. Idempotent: skips if the column already exists (handles
// double-instantiation and the case where SCHEMA's CREATE TABLE IF NOT EXISTS
// already produced the v2 shape on a fresh DB stamped as v1 by mistake).
function migrateV1toV2(db: DatabaseSync): void {
  const cols = db
    .prepare("PRAGMA table_info(nodes)")
    .all() as unknown as { name: string }[];
  if (cols.some((c) => c.name === "signature")) return;
  db.exec("ALTER TABLE nodes ADD COLUMN signature TEXT");
}

// v2 -> v3: add `repo TEXT` (nullable) to `nodes` and `edges` for workspace
// multi-repo support. Single-repo rows keep repo=NULL — transparent migration.
// Idempotent: guarded by PRAGMA table_info check, same pattern as migrateV1toV2.
export function migrateV2toV3(db: DatabaseSync): void {
  const nodeCols = db
    .prepare("PRAGMA table_info(nodes)")
    .all() as unknown as { name: string }[];
  if (!nodeCols.some((c) => c.name === "repo")) {
    db.exec("ALTER TABLE nodes ADD COLUMN repo TEXT");
  }
  const edgeCols = db
    .prepare("PRAGMA table_info(edges)")
    .all() as unknown as { name: string }[];
  if (!edgeCols.some((c) => c.name === "repo")) {
    db.exec("ALTER TABLE edges ADD COLUMN repo TEXT");
  }
}

// v3 -> v4: add index on nodes(kind) for faster infra-node queries.
// Pure DDL addition — no column changes (kind column already TEXT since v1).
// Idempotent: CREATE INDEX IF NOT EXISTS is a no-op on an existing index.
export function migrateV3toV4(db: DatabaseSync): void {
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind)");
  db.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
}

// Reject a graph.db written by a newer binary BEFORE any schema work runs (its rows may
// reference columns this binary doesn't know). Closes the handle before throwing so a
// rejected open never leaks it. Returns the on-disk schema version so the caller can
// decide whether migrations are still owed.
function assertGraphReadable(db: DatabaseSync): number {
  const v = (db.prepare("PRAGMA user_version").get() as unknown as { user_version: number }).user_version;
  if (v > GRAPH_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `graph.db was written by a newer version of leina (db version ${v}, binary supports up to ${GRAPH_SCHEMA_VERSION}). Upgrade leina.`,
    );
  }
  return v;
}

export class GraphStore implements GraphRepository {
  private readonly db: DatabaseSync;

  constructor(path: string, opts?: { readOnly?: boolean }) {
    this.db = new DatabaseSync(path);
    // Another process (background build, MCP server, a second CLI) may hold the write
    // lock; without a busy_timeout every statement below fails immediately with
    // SQLITE_BUSY instead of waiting its turn.
    this.db.exec("PRAGMA busy_timeout = 5000;");

    // Read-only hardening for `graph serve` (defense in depth). The physical file is
    // still opened R/W so a WAL database reads without needing write access to its -shm
    // sidecar, but the connection is flipped to `query_only` — so ANY write (a logic bug
    // in a GET handler) fails in-band with SQLITE_READONLY instead of silently mutating
    // the graph. No WAL switch and no DDL/migrations: both are writes, and a served DB is
    // always post-freshness-gate (current schema, already built). The newer-binary guard
    // still applies.
    if (opts?.readOnly) {
      assertGraphReadable(this.db);
      this.db.exec("PRAGMA query_only = ON;");
      return;
    }

    this.db.exec("PRAGMA journal_mode = WAL;");

    // Schema versioning — reject DBs written by a newer binary BEFORE running
    // SCHEMA (which may reference columns absent in an unknown future schema).
    const v = assertGraphReadable(this.db);

    // Fast path: the version stamp is written only AFTER SCHEMA + migrations complete,
    // so a db already at the current version is guaranteed to have the full current
    // shape. Skipping the DDL re-execution keeps concurrent opens (build in one
    // process, queries in others) free of write locks on the hot path.
    if (v === GRAPH_SCHEMA_VERSION) return;

    this.db.exec(SCHEMA);
    // Run the additive migrations for EVERY below-current version, including 0. They
    // are idempotent (guarded by PRAGMA table_info / IF NOT EXISTS), so on a fresh DB
    // they are no-ops (SCHEMA already produced the latest shape). Crucially this also
    // repairs a *legacy pre-versioning* DB, which reports user_version=0 while its
    // tables still have the old shape: since CREATE TABLE IF NOT EXISTS never upgrades
    // an existing table, a plain "v===0 → stamp latest" path would leave the
    // `signature`/`repo` columns missing and the next INSERT would fail with a SQL
    // logic error. (Only the fast path above — an exact current-version stamp — may
    // skip this, and that stamp is written strictly after these migrations ran.)
    migrateV1toV2(this.db);
    migrateV2toV3(this.db);
    migrateV3toV4(this.db);
    this.db.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  clear(): void {
    this.db.exec("DELETE FROM edges; DELETE FROM nodes;");
  }

  // Insert nodes, upserting on id collision. Assumes a transaction is ALREADY open —
  // no BEGIN/COMMIT/ROLLBACK here. Shared by addNodes() (its own BEGIN/COMMIT) and
  // replaceGraph() (single outer BEGIN/COMMIT spanning nodes + edges).
  #insertNodesTx(nodes: GraphNode[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO nodes (id, label, file_type, kind, source_file, source_location, community, signature, repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label=excluded.label, file_type=excluded.file_type, kind=excluded.kind,
         source_file=excluded.source_file, source_location=excluded.source_location,
         signature=excluded.signature, repo=excluded.repo`,
    );
    // Advisory dedup set — emit each unknown kind at most once per call.
    const advisedKinds = new Set<string>();
    for (const n of nodes) {
      // PERMISSIVE advisory: unknown kind → warn on stderr, still insert.
      if (n.kind && !KNOWN_NODE_KINDS.has(n.kind) && !advisedKinds.has(n.kind)) {
        advisedKinds.add(n.kind);
        process.stderr.write(
          `[leina] advisory: unknown node kind "${n.kind}" — inserting anyway. ` +
            `Add it to KNOWN_NODE_KINDS in model.ts to suppress this warning.\n`,
        );
      }
      stmt.run(
        n.id,
        n.label,
        n.fileType,
        n.kind ?? null,
        n.sourceFile,
        n.sourceLocation ?? null,
        n.community ?? null,
        n.signature ? JSON.stringify(n.signature) : null,
        n.repo ?? null,
      );
    }
  }

  // Insert edges, upserting/accumulating weight on collision. Assumes a transaction is
  // ALREADY open — see #insertNodesTx for the shared-transaction rationale.
  #insertEdgesTx(edges: GraphEdge[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO edges (source, target, relation, confidence, context, source_file, source_location, weight, repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, target, relation, context) DO UPDATE SET
         confidence=excluded.confidence, weight=edges.weight + excluded.weight, repo=excluded.repo`,
    );
    // Advisory dedup set — emit each unknown relation at most once per call.
    const advisedRelations = new Set<string>();
    for (const e of edges) {
      // PERMISSIVE advisory: unknown relation → warn on stderr, still insert.
      if (!KNOWN_RELATIONS.has(e.relation) && !advisedRelations.has(e.relation)) {
        advisedRelations.add(e.relation);
        process.stderr.write(
          `[leina] advisory: unknown edge relation "${e.relation}" — inserting anyway. ` +
            `Add it to KNOWN_RELATIONS in model.ts to suppress this warning.\n`,
        );
      }
      stmt.run(
        e.source,
        e.target,
        e.relation,
        e.confidence,
        e.context ?? "",
        e.sourceFile,
        e.sourceLocation ?? null,
        e.weight,
        e.repo ?? null,
      );
    }
  }

  addNodes(nodes: GraphNode[]): void {
    this.db.exec("BEGIN");
    try {
      this.#insertNodesTx(nodes);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  addEdges(edges: GraphEdge[]): void {
    this.db.exec("BEGIN");
    try {
      this.#insertEdgesTx(edges);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Atomically swap the entire graph contents: DELETE all rows, then insert the given
   * nodes/edges — all inside a SINGLE transaction. Unlike calling clear()+addNodes()+
   * addEdges() separately (each opening/closing its own transaction), this never leaves
   * a window where a concurrent reader observes an empty graph: with WAL, readers keep
   * seeing the previous committed snapshot until this transaction's COMMIT lands
   * atomically. On any failure between DELETE and the final INSERT, ROLLBACK restores
   * the previous graph untouched.
   */
  replaceGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM edges; DELETE FROM nodes;");
      this.#insertNodesTx(nodes);
      this.#insertEdgesTx(edges);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getNode(id: string): GraphNode | undefined {
    const r = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as unknown as
      | NodeRow
      | undefined;
    return r ? rowToNode(r) : undefined;
  }

  // label lookup. Order of preference:
  //   1. exact label match (case-insensitive)
  //   2. functional-exact: normalized label equals normalized query
  //   3. substring, shortest label first (most specific)
  findByLabel(query: string): GraphNode[] {
    const exact = this.db
      .prepare("SELECT * FROM nodes WHERE label = ? COLLATE NOCASE")
      .all(query) as unknown as NodeRow[];
    if (exact.length > 0) return exact.map(rowToNode);

    const like = (
      this.db
        .prepare(
          "SELECT * FROM nodes WHERE label LIKE ? COLLATE NOCASE ORDER BY length(label) ASC LIMIT 50",
        )
        .all(`%${query}%`) as unknown as NodeRow[]
    ).map(rowToNode);

    const nq = normalizeLabel(query);
    const functionalExact = like.filter((n) => normalizeLabel(n.label) === nq);
    return functionalExact.length > 0 ? functionalExact : like;
  }

  allNodes(): GraphNode[] {
    return (
      this.db.prepare("SELECT * FROM nodes").all() as unknown as NodeRow[]
    ).map(rowToNode);
  }

  allEdges(): GraphEdge[] {
    return (
      this.db.prepare("SELECT * FROM edges").all() as unknown as EdgeRow[]
    ).map(rowToEdge);
  }

  outEdges(id: string): GraphEdge[] {
    return (
      this.db.prepare("SELECT * FROM edges WHERE source = ?").all(id) as
        unknown as EdgeRow[]
    ).map(rowToEdge);
  }

  inEdges(id: string): GraphEdge[] {
    return (
      this.db.prepare("SELECT * FROM edges WHERE target = ?").all(id) as
        unknown as EdgeRow[]
    ).map(rowToEdge);
  }

  degree(id: string): number {
    const out = this.db
      .prepare("SELECT COUNT(*) c FROM edges WHERE source = ?")
      .get(id) as unknown as { c: number };
    const inc = this.db
      .prepare("SELECT COUNT(*) c FROM edges WHERE target = ?")
      .get(id) as unknown as { c: number };
    return out.c + inc.c;
  }

  stats(): {
    nodes: number;
    edges: number;
    byConfidence: Record<string, number>;
  } {
    const nodes = (
      this.db.prepare("SELECT COUNT(*) c FROM nodes").get() as unknown as {
        c: number;
      }
    ).c;
    const edges = (
      this.db.prepare("SELECT COUNT(*) c FROM edges").get() as unknown as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare("SELECT confidence, COUNT(*) c FROM edges GROUP BY confidence")
      .all() as unknown as { confidence: string; c: number }[];
    const byConfidence: Record<string, number> = {};
    for (const r of rows) byConfidence[r.confidence] = r.c;
    return { nodes, edges, byConfidence };
  }

  // Node counts grouped by `kind` (function/class/service/...). Nodes without a kind
  // (kind is nullable) are bucketed under "unknown" rather than dropped, so the totals
  // in statsByKind() + missing-kind count still add up to stats().nodes.
  statsByKind(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT kind, COUNT(*) c FROM nodes GROUP BY kind")
      .all() as unknown as { kind: string | null; c: number }[];
    const byKind: Record<string, number> = {};
    for (const r of rows) byKind[r.kind ?? "unknown"] = r.c;
    return byKind;
  }

  // Edge counts grouped by `relation` (calls/imports/inherits/...). relation is NOT NULL
  // on the edges table, so unlike statsByKind() there is no "unknown" bucket here.
  statsByRelation(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT relation, COUNT(*) c FROM edges GROUP BY relation")
      .all() as unknown as { relation: string; c: number }[];
    const byRelation: Record<string, number> = {};
    for (const r of rows) byRelation[r.relation] = r.c;
    return byRelation;
  }

  updateCommunities(assignments: { id: string; community: number }[]): void {
    const stmt = this.db.prepare("UPDATE nodes SET community=? WHERE id=?");
    this.db.exec("BEGIN");
    try {
      for (const { id, community } of assignments) {
        stmt.run(community, id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  toNodeLink(directed = true): NodeLinkGraph {
    return {
      directed,
      multigraph: false,
      graph: {},
      nodes: this.allNodes(),
      links: this.allEdges(),
    };
  }
}
