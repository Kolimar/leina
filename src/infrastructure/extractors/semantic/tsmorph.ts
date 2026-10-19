// Semantic TypeScript extractor using ts-morph (the TS compiler API).
//
// Unlike the tree-sitter path (syntactic, heuristic name matching), this uses
// the real type checker: every call/reference is resolved to its EXACT
// declaration via the checker's symbols. That means edges are compiler-proven
// (EXTRACTED), with no AMBIGUOUS guessing — overloads, imports, re-exports and
// generics all resolve correctly.
//
// Runs in-process (ts-morph bundles TypeScript), so no external toolchain. ts-morph
// builds the Program (tsconfig, lib files, module resolution); the walk itself runs
// on the raw compiler API, one file at a time (ts-file-extract.ts), against ids
// computed from each file's syntax alone (ts-defs.ts).
//
// Incremental: a file's result depends only on what the checker sees from it, so results
// are cached per file (ts-extract-cache.ts) and a rebuild re-extracts only the files an edit
// can reach (ts-plan.ts), with a Program rooted at those files alone. The output is the
// same as a full extraction's, in the same order.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Project, ts } from "ts-morph";
import type { GraphEdge, GraphNode } from "../../../domain/graph/model.ts";
import {
  TsExtractCache,
  type TsCacheRow,
  type TsCacheSnapshot,
  type TsFileOutput,
  type TsSpec,
} from "../../sqlite/ts-extract-cache.ts";
import { collectDefs, type FileDefs } from "./ts-defs.ts";
import { fileFacts, moduleSpecifiers } from "./ts-facts.ts";
import { extractTsFile, type TsFileResult, type TsProgramEnv } from "./ts-file-extract.ts";
import { planTsExtraction } from "./ts-plan.ts";

export function isTsMorphAvailable(): boolean {
  return true; // bundled dependency
}

const toPosix = (p: string): string => p.split(sep).join("/");
const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

function createProject(root: string): Project {
  const tsconfig = join(root, "tsconfig.json");
  return existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ compilerOptions: { allowJs: true, skipLibCheck: true } });
}

/**
 * The checker view shared by every per-file extraction of one run. `listed` is the set of
 * files that get graph nodes (absolute POSIX paths); declarations anywhere else (lib,
 * node_modules, unlisted project files) are never edge targets.
 */
function programEnv(project: Project, root: string, listed: ReadonlySet<string>): TsProgramEnv {
  const program = project.getProgram().compilerObject;
  const checker = program.getTypeChecker();
  const defsCache = new Map<ts.SourceFile, FileDefs | undefined>();
  return {
    program,
    checker,
    defsOf(sf: ts.SourceFile): FileDefs | undefined {
      if (defsCache.has(sf)) return defsCache.get(sf);
      const defs = listed.has(sf.fileName) ? collectDefs(sf, toPosix(relative(root, sf.fileName))) : undefined;
      defsCache.set(sf, defs);
      return defs;
    },
  };
}

/**
 * Extract `files` with one Program rooted at `roots` (the files plus, on the incremental path,
 * the global ones). `listed` are all the files that get nodes. Results keyed by input path.
 */
function extractWithProgram(
  project: Project,
  root: string,
  listedFiles: readonly string[],
  roots: readonly string[],
  files: readonly string[],
): { env: TsProgramEnv; results: Map<string, TsFileResult> } {
  for (const f of roots) project.addSourceFileAtPath(f);
  const listed = new Set(listedFiles.map((f) => toPosix(resolve(f))));
  const env = programEnv(project, root, listed);
  const results = new Map<string, TsFileResult>();
  for (const f of files) {
    const sf = env.program.getSourceFile(toPosix(resolve(f)));
    if (sf === undefined) continue;
    results.set(f, extractTsFile(env, sf));
  }
  return { env, results };
}

export function extractTsProject(root: string, tsFiles: string[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { results } = extractWithProgram(createProject(root), root, tsFiles, tsFiles, tsFiles);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const f of tsFiles) {
    const r = results.get(f);
    if (r === undefined) continue;
    nodes.push(...r.nodes);
    edges.push(...r.edges);
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Incremental extraction
// ---------------------------------------------------------------------------

/** Files whose content changes what node_modules / lib declarations the checker sees. */
const ENV_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

/** Everything a cached result assumes besides the project files: a mismatch drops the cache. */
function cacheKey(root: string, version: string, options: ts.CompilerOptions): string {
  const h = createHash("sha256");
  h.update(`${version}\u0000${root}\u0000`);
  const opts: Record<string, unknown> = {};
  for (const k of Object.keys(options).sort()) {
    if (k !== "configFile") opts[k] = options[k];
  }
  h.update(JSON.stringify(opts));
  for (const f of ENV_FILES) {
    const p = join(root, f);
    h.update(`\u0000${f}\u0000`);
    if (existsSync(p)) h.update(readFileSync(p));
  }
  return h.digest("hex");
}

export interface TsCachedExtraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Files whose cached result was reused. */
  reused: number;
  /** Files extracted by this run. */
  extracted: number;
  /** Why everything was extracted, or null on the incremental path. */
  full: string | null;
}

export interface TsCachedOptions {
  /** The extractor version (cache key). */
  version: string;
  /** Extract everything, ignoring cached results; the reason is reported back. */
  fullExtraction?: string | null;
}

interface PartialRun {
  dirty: Set<string>;
  globals: string[];
  cached: Map<string, TsFileOutput>;
  removed: string[];
}

class TsIncremental {
  private readonly root: string;
  private readonly tsFiles: string[];
  private readonly relOf = new Map<string, string>();
  private readonly project: Project;
  private readonly options: ts.CompilerOptions;
  private readonly resolutionCache: ts.ModuleResolutionCache;

  constructor(root: string, tsFiles: string[]) {
    this.root = resolve(root);
    this.tsFiles = tsFiles;
    for (const f of tsFiles) this.relOf.set(f, toPosix(relative(this.root, resolve(f))));
    this.project = createProject(this.root);
    this.options = this.project.getCompilerOptions();
    const fold = (s: string): string => (ts.sys.useCaseSensitiveFileNames ? s : s.toLowerCase());
    this.resolutionCache = ts.createModuleResolutionCache(this.root, fold, this.options);
  }

  private rel(f: string): string {
    return this.relOf.get(f)!;
  }

  private abs(rel: string): string {
    return toPosix(join(this.root, rel));
  }

  private resolveSpec(rel: string, text: string, mode: number | null): string | null {
    const r = ts.resolveModuleName(
      text,
      this.abs(rel),
      this.options,
      ts.sys,
      this.resolutionCache,
      undefined,
      mode ?? undefined,
    );
    const f = r.resolvedModule?.resolvedFileName;
    return f === undefined ? null : toPosix(relative(this.root, f));
  }

  run(opts: TsCachedOptions): TsCachedExtraction {
    const cache = new TsExtractCache(this.root, cacheKey(this.root, opts.version, this.options));
    try {
      return this.runWith(cache, opts);
    } finally {
      cache.close();
    }
  }

  private runWith(cache: TsExtractCache, opts: TsCachedOptions): TsCachedExtraction {
    const texts = new Map<string, string>();
    const current = new Map<string, string>();
    for (const f of this.tsFiles) {
      let text = "";
      try {
        text = readFileSync(f, "utf8");
      } catch {
        /* unreadable: hashed as empty, extracted (or not) like a full build would */
      }
      texts.set(this.rel(f), text);
      current.set(this.rel(f), sha256(text));
    }

    const forced = opts.fullExtraction ?? (process.env.LEINA_TS_FULL_EXTRACT ? "LEINA_TS_FULL_EXTRACT is set" : null);
    const snap = forced === null ? cache.snapshot() : null;
    let reason = forced ?? (snap === null ? "no cached extraction" : this.auxChange(snap, current));
    let dirty: Set<string> | null = null;
    if (reason === null && snap !== null) {
      const plan = planTsExtraction({
        current,
        cached: snap.files,
        factsOf: (rel) => {
          const sf = ts.createSourceFile(this.abs(rel), texts.get(rel) ?? "", ts.ScriptTarget.Latest, true);
          return fileFacts(sf, rel);
        },
        resolve: (rel, spec) => this.resolveSpec(rel, spec[0], spec[1]),
      });
      if (plan.kind === "full") reason = plan.reason;
      else dirty = plan.dirty;
    }
    texts.clear();

    if (dirty === null || snap === null) return this.extract(cache, null, current, reason ?? "no cached extraction");
    return this.incremental(cache, snap, current, dirty);
  }

  /** A non-listed project file the checker loaded last time (a `.js`/`.json` import) changed. */
  private auxChange(snap: TsCacheSnapshot, current: Map<string, string>): string | null {
    for (const [rel, sum] of snap.aux) {
      if (current.has(rel)) continue; // listed now: tracked (and planned) as a file of its own
      let now: string | null = null;
      try {
        now = sha256(readFileSync(join(this.root, rel)));
      } catch {
        /* gone */
      }
      if (now !== sum) return `dependency changed: ${rel}`;
    }
    return null;
  }

  private incremental(
    cache: TsExtractCache,
    snap: TsCacheSnapshot,
    current: Map<string, string>,
    dirty: Set<string>,
  ): TsCachedExtraction {
    const reusedRels = [...current.keys()].filter((rel) => !dirty.has(rel));
    const cached = cache.results(reusedRels);
    if (cached?.size !== reusedRels.length) {
      return this.extract(cache, null, current, "cached results unreadable");
    }
    if (dirty.size === 0) {
      const out = this.assemble(new Map<string, TsFileOutput>(), cached);
      return { ...out, reused: reusedRels.length, extracted: 0, full: null };
    }
    // Global files reach every file without an import: they root the partial Program too.
    const globals = [...snap.files].filter(([rel, c]) => c.global && current.get(rel) === c.hash).map(([rel]) => rel);
    const removed = [...snap.files.keys()].filter((rel) => !current.has(rel));
    return this.extract(cache, { dirty, globals, cached, removed }, current, null);
  }

  /** Extract everything (`partial` null) or the dirty files, then store their rows. */
  private extract(
    cache: TsExtractCache,
    partial: PartialRun | null,
    current: Map<string, string>,
    reason: string | null,
  ): TsCachedExtraction {
    const files = partial === null ? this.tsFiles : this.tsFiles.filter((f) => partial.dirty.has(this.rel(f)));
    const roots = partial === null ? files : [...files, ...partial.globals.map((rel) => join(this.root, rel))];
    const { env, results } = extractWithProgram(this.project, this.root, this.tsFiles, roots, files);

    const rows = new Map<string, TsCacheRow>();
    const fresh = new Map<string, TsFileOutput>();
    for (const f of files) {
      const r = results.get(f);
      const sf = env.program.getSourceFile(toPosix(resolve(f)));
      if (r === undefined || sf === undefined) continue;
      const rel = this.rel(f);
      fresh.set(rel, r);
      rows.set(rel, { hash: current.get(rel)!, ...fileFacts(sf, rel), specs: this.specsOf(env.program, sf, rel), result: r });
    }
    cache.write({
      replaceAll: partial === null,
      files: rows,
      removed: partial?.removed ?? [],
      aux: this.auxOf(env.program),
    });
    const out = this.assemble(fresh, partial?.cached ?? new Map<string, TsFileOutput>());
    return { ...out, reused: partial?.cached.size ?? 0, extracted: fresh.size, full: reason };
  }

  private specsOf(program: ts.Program, sf: ts.SourceFile, rel: string): TsSpec[] {
    const seen = new Set<string>();
    const specs: TsSpec[] = [];
    for (const lit of moduleSpecifiers(sf)) {
      const mode = (program.getModeForUsageLocation(sf, lit)) ?? null;
      const key = `${lit.text}\u0000${String(mode)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      specs.push([lit.text, mode, this.resolveSpec(rel, lit.text, mode)]);
    }
    return specs;
  }

  /** Content hashes of the project files the checker loaded that have no row of their own. */
  private auxOf(program: ts.Program): Map<string, string> {
    const listed = new Set(this.tsFiles.map((f) => toPosix(resolve(f))));
    const aux = new Map<string, string>();
    for (const sf of program.getSourceFiles()) {
      if (listed.has(sf.fileName) || program.isSourceFileDefaultLibrary(sf)) continue;
      if (sf.fileName.includes("/node_modules/")) continue; // covered by the lockfiles (cache key)
      aux.set(toPosix(relative(this.root, sf.fileName)), sha256(sf.text));
    }
    return aux;
  }

  /** Results in tsFiles order — the order a full extraction emits. */
  private assemble(fresh: Map<string, TsFileOutput>, cached: Map<string, TsFileOutput>): TsFileOutput {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const f of this.tsFiles) {
      const rel = this.rel(f);
      const r = fresh.get(rel) ?? cached.get(rel);
      if (r === undefined) continue;
      nodes.push(...r.nodes);
      edges.push(...r.edges);
    }
    return { nodes, edges };
  }
}

/** extractTsProject with the per-file cache in <root>/.leina/extract-cache.db. */
export function extractTsProjectCached(root: string, tsFiles: string[], opts: TsCachedOptions): TsCachedExtraction {
  return new TsIncremental(root, tsFiles).run(opts);
}

// ---------------------------------------------------------------------------
// GraphExtractor adapter — wraps the extraction in the domain port.
// ---------------------------------------------------------------------------

import { detectLang } from "../../../application/graph/detect.ts";
import type { ExtractOptions, GraphExtractor, GraphExtractionResult } from "../../../domain/graph/extractor.ts";

export class TsmorphExtractor implements GraphExtractor {
  readonly id = "tsmorph" as const;
  readonly version: string;

  constructor(version: string) {
    this.version = version;
  }

  supports(filePath: string): boolean {
    const l = detectLang(filePath);
    return l === "typescript" || l === "tsx";
  }

  async extract(root: string, files: string[], opts: ExtractOptions = {}): Promise<GraphExtractionResult> {
    const base = {
      schemaVersion: 1 as const,
      extractor: { id: this.id, version: this.version },
    };

    // Deshabilitado por variable de entorno → señal D4 (errors no vacío → no handled)
    if (process.env.LEINA_NO_TSMORPH) {
      return { ...base, nodes: [], edges: [], diagnostics: [], durationMs: 0, errors: ["disabled by LEINA_NO_TSMORPH"] };
    }

    const tsFiles = files.filter((f) => {
      const l = detectLang(f);
      return l === "typescript" || l === "tsx";
    });
    if (tsFiles.length === 0) {
      return { ...base, nodes: [], edges: [], diagnostics: [], durationMs: 0, errors: ["no typescript files in candidate list"] };
    }

    const start = Date.now();
    try {
      const res = extractTsProjectCached(root, tsFiles, { version: this.version, fullExtraction: opts.fullExtraction });
      const diagnostics =
        res.full === null ? [`ts extract cache: ${res.reused} reused, ${res.extracted} re-extracted`] : [];
      return {
        ...base,
        nodes: res.nodes,
        edges: res.edges,
        diagnostics,
        durationMs: Date.now() - start,
        errors: [],
      };
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`  ! ts-morph failed, using tree-sitter for TS: ${msg}`);
      return {
        ...base,
        nodes: [],
        edges: [],
        diagnostics: [`ts-morph failed → tree-sitter: ${msg}`],
        durationMs: Date.now() - start,
        errors: [msg],
      };
    }
  }
}
