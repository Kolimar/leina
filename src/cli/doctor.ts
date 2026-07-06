// `leina doctor` — read-only health diagnostics.
//
// Reports, per check, whether the install is healthy (ok), degraded but usable (warn), or broken
// (fail). It NEVER writes and NEVER opens a SQLite DB (no WAL side effects) — it only stats the
// filesystem and parses text/JSON config. The collector (runDoctor) returns a structured
// CheckResult[] so a future `--json` mode is a formatting change, not a rewrite.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fts5Available, FTS5_MIN_NODE_MAJOR } from "../infrastructure/sqlite/schema.ts";
import { MIN_NODE } from "./node-gate.ts";
import { verifyParserAssets } from "../infrastructure/extractors/parser-assets.ts";
import { entryAssetsRoot } from "../infrastructure/install/global.ts";
import { deserializeSelection } from "../application/install/catalog.ts";
import { envFilePath, envFilePermsTooOpen } from "../infrastructure/env/env-file.ts";
import { detectGitBashOnWindows, gitBashAdvisory } from "../infrastructure/install/shell.ts";
import {
  leinaHome,
  globalMemoryPath,
  shareAgentsDir,
  shareRoot,
  shareSelectionFile,
  shareSkillsDir,
  shareVersionFile,
  shareWorkflowsDir,
  type HostId,
} from "../infrastructure/install/share-paths.ts";
import { countWorkflowFiles, inspectHostLinks, isBlanketActive, normalizeHosts } from "../infrastructure/install/global.ts";
import { findOnPath, inspectMcpGlobal } from "../infrastructure/install/mcp-hosts.ts";
import { hasMcpRegistration } from "../application/install/mcp-config.ts";
import { resolveScipIndexer, scipExtensionsFor, WIRED_SCIP_LANGS } from "../infrastructure/extractors/semantic/scip-indexer.ts";
import { isSidecarConfigured } from "../infrastructure/extractors/semantic/sidecar.ts";
import { isSidecarBuilt, missingTools } from "../infrastructure/extractors/semantic/sidecar-build.ts";
import type { SemanticLang } from "../application/graph/detect.ts";
import { isStale } from "../application/graph/manifest.ts";
import { PROTOCOL_START } from "../application/install/protocol.ts";
import { GITIGNORE_START } from "../application/install/gitignore.ts";
import { DEVIN_MANAGED_EVENTS } from "../application/install/devin-hooks.ts";
import { readPackageVersion } from "../version.ts";
import { deriveProjectKey, AmbiguousProjectError } from "../application/project/detect-key.ts";
import { buildRepoIdentity } from "../application/project/identity.ts";
import type { RepoIdentity } from "../domain/project/identity.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  group: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface DoctorReport {
  results: CheckResult[];
  exitCode: number; // 1 if any check failed, else 0
  repoIdentity?: RepoIdentity; // ausente si buildRepoIdentity falla (fail-open)
}

// Minimum supported Node lives in cli/node-gate.ts (the startup gate) so the gate and
// this check can never disagree. Nodes below 24 lack FTS5 and run in LIKE-degraded mode —
// still usable, but memory search quality is reduced (no porter stemming / BM25 ranking).

/** True if the file exists AND contains `marker` as a whole (trimmed) line. */
function hasWholeLineMarker(file: string, marker: string): boolean {
  try {
    return readFileSync(file, "utf8").split("\n").some((l) => l.trim() === marker);
  } catch {
    return false;
  }
}

function countSubdirs(dir: string): number {
  try {
    return readdirSync(dir).filter((e) => {
      try {
        return statSync(join(dir, e)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

function checkEnvironment(out: CheckResult[], version: string): void {
  const g = "environment";
  const [maj, min] = process.versions.node.split(".").map(Number);
  // Node >= 24: ok (FTS5 available, full search quality).
  // Node 22.13–23.x: warn (node:sqlite available but FTS5 absent; LIKE degraded mode).
  // Node < 22.13: fail (node:sqlite itself requires --experimental-sqlite).
  const aboveMin = maj! > MIN_NODE.major || (maj === MIN_NODE.major && min! >= MIN_NODE.minor);
  const hasFts5 = maj! >= FTS5_MIN_NODE_MAJOR;
  const nodeStatus: CheckResult["status"] = !aboveMin ? "fail" : hasFts5 ? "ok" : "warn";
  const nodeDetail = !aboveMin
    ? `${process.versions.node} (requires >= ${MIN_NODE.major}.${MIN_NODE.minor})`
    : hasFts5
      ? `${process.versions.node} (full FTS5 search enabled)`
      : `${process.versions.node} (degraded: no FTS5 on Node 22/23 — upgrade to Node ${FTS5_MIN_NODE_MAJOR}+ for full search)`;
  out.push(
    {
      group: g,
      label: "Node.js",
      status: nodeStatus,
      detail: nodeDetail,
    },
    { group: g, label: "leina version", status: "ok", detail: version },
  );
  checkFts5(out, g);
  checkParserAssets(out, g);
  checkBundledAssets(out, g);
  const home = leinaHome();
  out.push({
    group: g,
    label: "home dir",
    status: existsSync(home) ? "ok" : "warn",
    detail: existsSync(home) ? home : `${home} (not created yet — run leina activate)`,
  });

  checkCliEntry(out, g);
  checkShellInterop(out, g);
  checkEnvStore(out, g);
}

// The leina env store holds service credentials in plain text under an explicit
// 0600 contract — warn when the mode has loosened (POSIX only; stat only, never reads
// the contents).
function checkEnvStore(out: CheckResult[], g: string): void {
  const p = envFilePath();
  if (!existsSync(p)) {
    out.push({ group: g, label: "env store", status: "ok", detail: "none (leina env set <KEY> to create)" });
    return;
  }
  const tooOpen = envFilePermsTooOpen();
  out.push({
    group: g,
    label: "env store",
    status: tooOpen ? "warn" : "ok",
    detail: tooOpen ? `${p} readable by group/others — run: chmod 600 ${p}` : p,
  });
}

// WASM parser assets: web-tree-sitter runtime (node_modules) + one grammar per language
// vendored under assets/wasm/ (see scripts/vendor-wasm.ts), plain files either way. A
// partial/corrupted install (interrupted download, pruning, exotic package-manager
// layout) used to surface as an ENOENT mid-build; here it is a named fail with the
// reinstall remedy. Pure resolve+stat — keeps doctor read-only.
function checkParserAssets(out: CheckResult[], g: string): void {
  const report = verifyParserAssets();
  out.push({
    group: g,
    label: "parser assets (wasm)",
    status: report.ok ? "ok" : "fail",
    detail: report.ok ? report.detail : `${report.detail} — reinstall leina (plain files; no build step involved)`,
  });
}

// Bundled assets anchor: where `activate` will read assets/{skills,agents} from, resolved
// exactly the way the install path resolves it (realpath of the bin entry). This is the
// anchor that differs across npm/pnpm/bun store layouts — a fail here means the package
// layout is broken (or a shim resolved somewhere unexpected), and explains WHY activate
// would fail before the user runs it.
function checkBundledAssets(out: CheckResult[], g: string): void {
  const assetsRoot = entryAssetsRoot();
  const ok = existsSync(join(assetsRoot, "skills")) && existsSync(join(assetsRoot, "agents"));
  out.push({
    group: g,
    label: "bundled assets",
    status: ok ? "ok" : "fail",
    detail: ok
      ? assetsRoot
      : `${assetsRoot} has no skills/agents — package layout broken from this entry (${process.argv[1] ?? "?"}); reinstall leina`,
  });
}

// SQLite FTS5 capability. Memory's full-text search rides FTS5; Node 22/23 bundle SQLite
// without it. Probe an EPHEMERAL :memory: db (no file, no WAL — keeps doctor's
// "never touch a db file" contract intact).
// When FTS5 is absent this is a WARN (not a fail): leina now degrades gracefully
// to LIKE-based search. Users on Node 22/23 are still functional — they just get reduced
// search quality until they upgrade.
function checkFts5(out: CheckResult[], g: string): void {
  let db: DatabaseSync | undefined;
  let ok = false;
  try {
    db = new DatabaseSync(":memory:");
    ok = fts5Available(db);
  } catch {
    ok = false;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
  out.push({
    group: g,
    label: "SQLite FTS5",
    status: ok ? "ok" : "warn",
    detail: ok
      ? "available (memory full-text search enabled)"
      : `missing — Node ${process.versions.node} lacks FTS5; search runs in LIKE-degraded mode. Upgrade to Node >= ${FTS5_MIN_NODE_MAJOR} for full search.`,
  });
}

// Resolve the installed `bin` target (dist/cli/index.js, sibling of this module) and confirm it
// exists. This directly catches the MODULE_NOT_FOUND class of failures, and prints the absolute
// path so users on a broken shim (see checkShellInterop) can `node "<path>"` it verbatim.
function checkCliEntry(out: CheckResult[], g: string): void {
  const entry = resolveCliEntry();
  const ok = existsSync(entry);
  out.push({
    group: g,
    label: "CLI entrypoint",
    status: ok ? "ok" : "fail",
    detail: ok ? entry : `${entry} missing — reinstall the package`,
  });
}

// The installed `bin` target lives next to this module: dist/cli/index.js in a published install,
// or src/cli/index.ts in the dev (.ts) checkout. Prefer whichever actually exists so the resolved
// path is the one a user would `node "<path>"` to bypass a broken shell shim.
function resolveCliEntry(): string {
  const js = fileURLToPath(new URL("./index.js", import.meta.url));
  if (existsSync(js)) return js;
  const ts = fileURLToPath(new URL("./index.ts", import.meta.url));
  return existsSync(ts) ? ts : js;
}

// Windows + Git Bash / MSYS: the npm POSIX shim can mis-resolve the CLI path and fail with
// MODULE_NOT_FOUND. Surface a warn (never a fail — the package is fine) with the exact remedy.
function checkShellInterop(out: CheckResult[], g: string): void {
  const det = detectGitBashOnWindows();
  if (!det.isGitBashOnWindows) {
    out.push({ group: g, label: "shell interop", status: "ok", detail: "no Git Bash/MSYS shim risk" });
    return;
  }
  let entry: string | undefined;
  try {
    entry = fileURLToPath(new URL("./index.js", import.meta.url));
  } catch {
    entry = undefined;
  }
  const msystemPrefix = det.msystem ? `MSYSTEM=${det.msystem}; ` : "";
  out.push({
    group: g,
    label: "shell interop",
    status: "warn",
    detail: `${msystemPrefix}${gitBashAdvisory(entry)}`,
  });
}

function checkShare(out: CheckResult[], version: string): void {
  const g = "share";
  if (!existsSync(shareRoot())) {
    out.push({ group: g, label: "share dir", status: "fail", detail: `${shareRoot()} missing — run leina activate` });
    return;
  }
  out.push({ group: g, label: "share dir", status: "ok", detail: shareRoot() });

  // Version sentinel vs running binary.
  let sentinel: string | null = null;
  try {
    sentinel = readFileSync(shareVersionFile(), "utf8").trim();
  } catch {
    sentinel = null;
  }
  if (sentinel === null) {
    out.push({ group: g, label: "share version", status: "fail", detail: "no .version sentinel — run leina activate" });
  } else if (sentinel === version) {
    out.push({ group: g, label: "share version", status: "ok", detail: sentinel });
  } else {
    out.push({
      group: g,
      label: "share version",
      status: "warn",
      detail: `share is v${sentinel}, binary is v${version} — stale; run leina activate`,
    });
  }

  const skills = countSubdirs(shareSkillsDir());
  const agents = countSubdirs(shareAgentsDir());
  const workflows = countWorkflowFiles(shareWorkflowsDir());
  out.push(
    { group: g, label: "skills", status: skills > 0 ? "ok" : "warn", detail: String(skills) },
    { group: g, label: "agents", status: agents > 0 ? "ok" : "warn", detail: String(agents) },
    { group: g, label: "workflows", status: workflows > 0 ? "ok" : "warn", detail: String(workflows) },
  );

  // Informational: which asset selection produced this share (activate --preset/--skills).
  let selRaw: string | null = null;
  try {
    selRaw = readFileSync(shareSelectionFile(), "utf8");
  } catch {
    selRaw = null;
  }
  const sel = deserializeSelection(selRaw);
  const selDetail =
    sel === null || (sel.skills === null && sel.agents === null)
      ? "full (all bundled assets)"
      : `custom — skills: ${sel.skills === null ? "all" : sel.skills.length}, agents: ${sel.agents === null ? "all" : sel.agents.length}`;
  out.push({ group: g, label: "selection", status: "ok", detail: selDetail });
}

/** The user's currently-selected hosts (persisted by `leina activate`/`init`), same read
 *  pattern as `inspectHostLinks` in global.ts — a host the user never opted into must not
 *  produce doctor noise about that host's files (e.g. `.devin/*` when only Claude Code was
 *  selected). */
function activeHosts(): HostId[] {
  let selRaw: string | null = null;
  try {
    selRaw = readFileSync(shareSelectionFile(), "utf8");
  } catch {
    selRaw = null;
  }
  const sel = deserializeSelection(selRaw);
  return normalizeHosts(sel?.hosts);
}

function checkSymlinks(out: CheckResult[]): void {
  const g = "host links";
  const links = inspectHostLinks();
  if (links.length === 0) {
    out.push({ group: g, label: "devin links", status: "warn", detail: "no share entries to link — run leina activate" });
    return;
  }
  for (const l of links) {
    // copy-fallback (Windows) is healthy; copy-stale (a copy older than the last share
    // populate — it no longer auto-propagates) and missing/broken/wrong-target are problems.
    const status: CheckStatus = l.state === "ok" || l.state === "copy-fallback" ? "ok" : "warn";
    const detail =
      l.state === "copy-stale" ? "copy-stale — predates the current share; run leina repair" : l.state;
    out.push({ group: g, label: `${l.kind}/${l.name}`, status, detail });
  }
}

function checkProject(out: CheckResult[], root: string): void {
  const g = "project";
  if (!existsSync(root)) {
    out.push({ group: g, label: "directory", status: "warn", detail: `${root} not found` });
    return;
  }

  // Graph freshness (reads manifest + stats files; never opens the DB).
  checkGraph(out, g, root);

  // AGENTS.md managed protocol block.
  checkAgentsMd(out, g, root);

  // .gitignore managed block (keeps .leina/ runtime data out of git).
  checkGitignore(out, g, root);

  // .devin/config.json and .devin/hooks.v1.json are Devin-specific — only check them when
  // the user actually selected the devin host (same host-neutral pattern as checkSymlinks
  // via inspectHostLinks). A Claude-Code-only project must not see `.devin/*` warnings.
  if (activeHosts().includes("devin")) {
    // .devin/config.json — CLI-only: warn if a legacy leina MCP server entry is still
    // present (a re-`init` strips it).
    checkLegacyMcp(out, g, join(root, ".devin", "config.json"));

    // .devin/hooks.v1.json managed events.
    checkDevinHooks(out, g, join(root, ".devin", "hooks.v1.json"));
  }

  // Global memory DB presence (no PRAGMA read — would create WAL side effects).
  checkGlobalMemory(out, g);

  // Project key detection (does not open DB — pure FS read + git exec).
  checkProjectKey(out, g, root);

  // Legacy per-repo memory.db nudge: if the old per-repo DB still exists, advise migration.
  checkLegacyMemDb(out, g, root);

  // Injection readiness: signals needed for active additionalContext injection (FS-only, no DB).
  checkInjectionReadiness(out, g, root);
}

// Graph freshness (reads manifest + stats files; never opens the DB).
function checkGraph(out: CheckResult[], g: string, root: string): void {
  const stale = isStale(root);
  if (stale.reason === "no-manifest") {
    out.push({ group: g, label: "graph", status: "fail", detail: "never built — run leina build" });
  } else if (stale.stale) {
    out.push({ group: g, label: "graph", status: "warn", detail: `stale (${stale.reason}) — run refresh` });
  } else {
    out.push({ group: g, label: "graph", status: "ok", detail: "fresh" });
  }
}

// AGENTS.md managed protocol block.
function checkAgentsMd(out: CheckResult[], g: string, root: string): void {
  const agentsMd = join(root, "AGENTS.md");
  let agentsStatus: CheckStatus;
  let agentsDetail: string;
  if (existsSync(agentsMd)) {
    if (hasWholeLineMarker(agentsMd, PROTOCOL_START)) {
      agentsStatus = "ok";
      agentsDetail = "protocol block present";
    } else {
      agentsStatus = "warn";
      agentsDetail = "no protocol block — run init";
    }
  } else {
    agentsStatus = "fail";
    agentsDetail = "missing";
  }
  out.push({ group: g, label: "AGENTS.md", status: agentsStatus, detail: agentsDetail });
}

// .gitignore managed block (keeps .leina/ runtime data out of git).
function checkGitignore(out: CheckResult[], g: string, root: string): void {
  const gitignore = join(root, ".gitignore");
  let gitignoreStatus: CheckStatus;
  let gitignoreDetail: string;
  if (existsSync(gitignore)) {
    if (hasWholeLineMarker(gitignore, GITIGNORE_START)) {
      gitignoreStatus = "ok";
      gitignoreDetail = "ignores .leina/";
    } else {
      gitignoreStatus = "warn";
      gitignoreDetail = "no leina block — run init";
    }
  } else {
    gitignoreStatus = "warn";
    gitignoreDetail = "missing — run init";
  }
  out.push({ group: g, label: ".gitignore", status: gitignoreStatus, detail: gitignoreDetail });
}

// Global memory DB presence (no PRAGMA read — would create WAL side effects).
function checkGlobalMemory(out: CheckResult[], g: string): void {
  const globalMem = globalMemoryPath();
  out.push({
    group: g,
    label: "global memory.db",
    status: existsSync(globalMem) ? "ok" : "warn",
    detail: existsSync(globalMem) ? globalMem : `${globalMem} — not created yet (run any memory command to initialize)`,
  });
}

// Legacy per-repo memory.db nudge: if the old per-repo DB still exists, advise migration.
function checkLegacyMemDb(out: CheckResult[], g: string, root: string): void {
  const legacyMemDb = join(root, ".leina", "memory.db");
  if (existsSync(legacyMemDb)) {
    out.push({
      group: g,
      label: "legacy memory.db",
      status: "warn",
      detail: `per-repo memory.db found at ${legacyMemDb}. Run: leina memory migrate ${root}`,
    });
  }
}

// Injection readiness: verifies the three FS signals required for active additionalContext
// injection at UserPromptSubmit/SessionStart/PostCompaction. FS-only — NEVER opens a SQLite
// connection (invariant: doctor NEVER creates WAL/SHM side effects).
//
// ok   = globalMemoryPath exists + deriveProjectKey resolvable + graph.db present
// warn = globalMemoryPath exists + key ok + graph.db absent (partial injection capability)
// fail = globalMemoryPath absent OR deriveProjectKey throws AmbiguousProjectError
function checkInjectionReadiness(out: CheckResult[], g: string, root: string): void {
  // Signal 1: global memory.db must exist (holds project observations to inject).
  if (!existsSync(globalMemoryPath())) {
    out.push({
      group: g,
      label: "injection readiness",
      status: "fail",
      detail: `global memory.db absent at ${globalMemoryPath()} — run any memory command to initialize`,
    });
    return;
  }

  // Signal 2: project key must be unambiguous (needed to scope the memory query).
  try {
    deriveProjectKey(root);
  } catch (e) {
    if (e instanceof AmbiguousProjectError) {
      out.push({
        group: g,
        label: "injection readiness",
        status: "fail",
        detail: `ambiguous project key — multiple child repos: ${e.candidates.join(", ")}. Lock via leina init --name <name>`,
      });
      return;
    }
    // Other errors (fs failure, etc.) — fall through to warn-level check; injection may still work.
  }

  // Signal 3: graph.db presence (provides structural context for injection).
  const graphDb = join(root, ".leina", "graph.db");
  if (existsSync(graphDb)) {
    out.push({
      group: g,
      label: "injection readiness",
      status: "ok",
      detail: "memory.db present, project key resolvable, graph.db present",
    });
  } else {
    out.push({
      group: g,
      label: "injection readiness",
      status: "warn",
      detail: "graph.db absent — partial injection (memory observations only, no graph stats); run leina refresh to build",
    });
  }
}

function checkProjectKey(out: CheckResult[], g: string, root: string): void {
  try {
    const det = deriveProjectKey(root);
    out.push({
      group: g,
      label: "project key",
      status: "ok",
      detail: `${det.key} (via ${det.method})`,
    });
  } catch (e) {
    if (e instanceof AmbiguousProjectError) {
      out.push({
        group: g,
        label: "project key",
        status: "warn",
        detail: `ambiguous — multiple child repos: ${e.candidates.join(", ")}. Lock via leina init --name <name>`,
      });
      return;
    }
    out.push({
      group: g,
      label: "project key",
      status: "warn",
      detail: `could not detect project key: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

function checkLegacyMcp(out: CheckResult[], g: string, path: string): void {
  // The real MCP server lives behind `leina mcp` and registers in the project-level
  // `.mcp.json` (Claude Code/Cursor convention). A `leina` entry under
  // `.devin/config.json` mcpServers is the OLD, pre-CLI wiring — Devin integration is
  // hooks-based — so it is flagged as stale. Absent (or no file at all) is healthy.
  if (!existsSync(path)) {
    out.push({ group: g, label: ".devin/config.json", status: "ok", detail: "no MCP config (Devin uses hooks)" });
    return;
  }
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
    const stale = !!cfg.mcpServers && "leina" in cfg.mcpServers;
    out.push({
      group: g,
      label: ".devin/config.json",
      status: stale ? "warn" : "ok",
      detail: stale
        ? "stale leina MCP entry in the Devin config — Devin uses hooks; MCP registration belongs in .mcp.json"
        : "no leina MCP server entry (Devin uses hooks)",
    });
  } catch {
    out.push({ group: g, label: ".devin/config.json", status: "fail", detail: "malformed JSON" });
  }
}

function checkDevinHooks(out: CheckResult[], g: string, path: string): void {
  if (!existsSync(path)) {
    // Under blanket mode, init takes the LIGHT path and never writes this file — the
    // hooks live machine-wide in ~/.config/devin/config.json. Absence is expected, not
    // a problem; suggesting "run init" would send the user in a circle.
    if (isBlanketActive()) {
      out.push({
        group: g,
        label: ".devin/hooks.v1.json",
        status: "ok",
        detail: "absent (expected under blanket mode — hooks are user-global)",
      });
    } else {
      out.push({ group: g, label: ".devin/hooks.v1.json", status: "warn", detail: "missing — run init" });
    }
    return;
  }
  try {
    const hooks = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const missing = DEVIN_MANAGED_EVENTS.filter((ev) => !Array.isArray(hooks[ev]));
    out.push({
      group: g,
      label: ".devin/hooks.v1.json",
      status: missing.length === 0 ? "ok" : "warn",
      detail: missing.length === 0 ? "all managed events present" : `missing events: ${missing.join(", ")}`,
    });
  } catch {
    out.push({ group: g, label: ".devin/hooks.v1.json", status: "fail", detail: "malformed JSON" });
  }
}

// ---------------------------------------------------------------------------
// extractors — availability of the third-party/on-demand compiler-grade
// extractors: SCIP indexers (scip-go/rust-analyzer/scip-python today) and the existing C#/Java sidecars
// (Roslyn/JavaParser — no doctor check existed for these before this change).
// Absence of any of these is a WARN, never a fail: tree-sitter always covers
// the same files, just with syntactic (not compiler-proven) precision.
// Pure detection (spawnSync `--version` / fs stat via isSidecarBuilt) — no DB,
// no writes, no invocation of a real build/index.
// ---------------------------------------------------------------------------

function checkScipIndexers(out: CheckResult[]): void {
  const g = "extractors";
  for (const lang of WIRED_SCIP_LANGS) {
    const argv = resolveScipIndexer(lang);
    // `lang` itself isn't necessarily the file extension (e.g. rust -> .rs) —
    // read the real extension(s) from SCIP_CONFIGS via scipExtensionsFor
    // instead of assuming `.${lang}` (that string interpolation happened to
    // be right for "go" only, by coincidence).
    const exts = [...scipExtensionsFor(lang)].join("/");
    out.push({
      group: g,
      label: `scip-${lang}`,
      status: argv ? "ok" : "warn",
      detail: argv
        ? `available (${argv.join(" ")}) — compiler-grade precision for ${exts} files`
        : `not installed — optional; falls back to tree-sitter. Run: leina scip install ${lang}`,
    });
  }
}

function checkSidecars(out: CheckResult[]): void {
  const g = "extractors";
  const langs: SemanticLang[] = ["csharp", "java"];
  for (const lang of langs) {
    const configured = isSidecarConfigured(lang);
    const built = isSidecarBuilt(lang);
    const missing = missingTools(lang);
    out.push({
      group: g,
      label: `sidecar-${lang}`,
      status: configured ? "ok" : "warn",
      detail: configured
        ? `configured${built ? " (built)" : " (env override)"} — compiler-grade precision for ${lang} files`
        : missing.length > 0
          ? `not built — missing toolchain (${missing.join(", ")}); optional, falls back to tree-sitter. Run: leina sidecar build ${lang}`
          : `not built — toolchain ok; optional, falls back to tree-sitter. Run: leina sidecar build ${lang}`,
    });
  }
}

// ---------------------------------------------------------------------------
// mcp — user-global + project MCP registration state. 100% read-only.
// Absence is `ok` (informative): MCP is one transport, not the default — an
// unregistered machine is healthy. The only real failure is a registration that
// points at a `leina` command the host cannot resolve on PATH.
// ---------------------------------------------------------------------------

function checkMcp(out: CheckResult[], root: string): void {
  const g = "mcp";
  let anyRegistered = false;

  for (const s of inspectMcpGlobal()) {
    if (s.state === "registered") anyRegistered = true;
    const detail =
      s.state === "registered" ? `registered (user scope) — ${s.detail}`
      : s.state === "not-installed" ? `not installed (${s.detail})`
      : `not registered (optional — leina mcp register)`;
    out.push({ group: g, label: s.label, status: "ok", detail });
  }

  const projectMcp = join(root, ".mcp.json");
  if (existsSync(projectMcp)) {
    try {
      const registered = hasMcpRegistration(readFileSync(projectMcp, "utf8"));
      if (registered) anyRegistered = true;
      out.push({
        group: g,
        label: ".mcp.json",
        status: "ok",
        detail: registered ? "leina server registered (project scope)" : "present, no leina entry (leina init --mcp adds one)",
      });
    } catch {
      out.push({ group: g, label: ".mcp.json", status: "fail", detail: "unreadable" });
    }
  } else {
    out.push({
      group: g,
      label: ".mcp.json",
      status: "ok",
      detail: "no project registration (user-global covers it, or leina init --mcp)",
    });
  }

  // A registration exists somewhere → the host will try to launch `leina mcp`; that only
  // works if the bare `leina` command resolves on PATH.
  if (anyRegistered) {
    out.push(
      findOnPath("leina") !== null
        ? { group: g, label: "server command", status: "ok", detail: "'leina' resolves on PATH" }
        : {
            group: g,
            label: "server command",
            status: "fail",
            detail: "registered but 'leina' not on PATH — the host cannot launch the server (npm i -g @kolimar/leina, or re-register with an absolute path)",
          },
    );
  }
}

/** Run every diagnostic for the given project root. Pure of side effects: reads only. */
export function runDoctor(version: string = readPackageVersion(), root = "."): DoctorReport {
  const results: CheckResult[] = [];
  checkEnvironment(results, version);
  checkShare(results, version);
  checkSymlinks(results);
  checkProject(results, root);
  checkScipIndexers(results);
  checkSidecars(results);
  checkMcp(results, root);
  const exitCode = results.some((r) => r.status === "fail") ? 1 : 0;

  // repoIdentity: fail-open — si buildRepoIdentity lanza, el campo queda ausente
  // y el resto del report sigue siendo válido.
  const report: DoctorReport = { results, exitCode };
  try {
    report.repoIdentity = buildRepoIdentity(root);
  } catch {
    // fail-open: repoIdentity stays undefined
  }
  return report;
}

const ICON: Record<CheckStatus, string> = { ok: "✔", warn: "!", fail: "✘" };

/** Render a DoctorReport as grouped, human-readable text. */
export function formatDoctor(report: DoctorReport): string {
  const lines: string[] = ["leina doctor\n"];
  let lastGroup = "";
  for (const r of report.results) {
    if (r.group !== lastGroup) {
      lines.push(`\n${r.group}:`);
      lastGroup = r.group;
    }
    const detailSuffix = r.detail ? `: ${r.detail}` : "";
    lines.push(`  ${ICON[r.status]} ${r.label}${detailSuffix}`);
  }
  const fails = report.results.filter((r) => r.status === "fail").length;
  const warns = report.results.filter((r) => r.status === "warn").length;
  lines.push(`\n${fails} fail, ${warns} warn, ${report.results.length} checks total.`);
  return lines.join("\n");
}
