// cli/handlers/system.ts — diagnostics, hook bridge, sidecar, capabilities, verify and root help.

import { runDoctor, formatDoctor } from "../doctor.ts";
import { runAgentGate, resolveHookProjectRoot } from "../agent-gate.ts";
import { readPackageVersion } from "../../version.ts";
import { readStdin } from "../io.ts";
import { capabilities } from "../../application/capabilities/registry.ts";
import type { Capability } from "../../domain/capabilities/model.ts";
import { WIRED_SCIP_LANGS } from "../../infrastructure/extractors/semantic/scip-indexer.ts";

export function handleDoctor(rest: string[]): never {
  // Read-only health diagnostics across env, global share, host symlinks and the project.
  // Exits 1 if any check failed, else 0.
  // Supports --json to emit the raw DoctorReport as JSON to stdout.
  const root = rest.find((a) => !a.startsWith("--")) ?? ".";
  const wantJson = rest.includes("--json");
  const report = runDoctor(readPackageVersion(), root);
  if (wantJson) {
    process.stdout.write(JSON.stringify(report));
  } else {
    console.log(formatDoctor(report));
  }
  process.exit(report.exitCode);
}

export function handleAgentHook(rest: string[]): never {
  // Host-neutral agent hooks bridge — invoked as `leina agent-hook <EventName>` (compat
  // alias: `devin-hook`, still emitted by existing `.devin/hooks.v1.json` installs) with the
  // hook's JSON payload on stdin. Advisory-only: emits a stderr nudge when memory hasn't been
  // loaded, never blocks. Fails OPEN on every error path. See src/cli/agent-gate.ts.
  // Supported managed events: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart,
  // PostCompaction (re-injects memory + graph context after compaction),
  // Stop (advisory nudge to persist session memory when session.memory-saved is absent).
  const eventName = rest[0];
  // Resolve the project root from Devin's documented DEVIN_PROJECT_DIR env var (fallback to
  // process.cwd()) — the hook payload itself never carries a cwd. See resolveHookProjectRoot.
  runAgentGate(readStdin(), resolveHookProjectRoot(process.env, process.cwd()), eventName);
  process.exit(0);
}

type SidecarModule = typeof import("../../infrastructure/extractors/semantic/sidecar-build.ts");
type SidecarLang = "csharp" | "java";
const SIDECAR_LANGS: readonly SidecarLang[] = ["csharp", "java"];

function parseSidecarLang(v: string | undefined): SidecarLang[] {
  return v === "csharp" || v === "java" ? [v] : [...SIDECAR_LANGS];
}

function sidecarBuild(m: SidecarModule, arg: string | undefined, force: boolean): void {
  for (const lang of parseSidecarLang(arg && !arg.startsWith("--") ? arg : undefined)) {
    const missing = m.missingTools(lang);
    if (missing.length > 0) {
      console.error(`${lang}: missing build tools on PATH: ${missing.join(", ")} — skipping.`);
      continue;
    }
    console.log(`Building ${lang} sidecar ...`);
    const res = m.buildSidecar(lang, { force });
    console.log(res.ok ? `  ok -> ${res.binPath}` : `  FAILED: ${res.error}`);
  }
}

function sidecarClean(m: SidecarModule, arg: string | undefined): void {
  for (const lang of parseSidecarLang(arg)) m.cleanSidecar(lang);
  console.log("Cleaned sidecar build cache.");
}

function sidecarStatus(m: SidecarModule): void {
  for (const lang of SIDECAR_LANGS) {
    const built = m.isSidecarBuilt(lang);
    const missing = m.missingTools(lang);
    console.log(
      `${lang}: ${built ? `built (${m.builtBinaryPath(lang)})` : "not built"}${ 
        missing.length > 0 ? `  [missing tools: ${missing.join(", ")}]` : "  [toolchain ok]"}`,
    );
  }
}

async function sidecarVerify(arg: string | undefined): Promise<void> {
  const langs = parseSidecarLang(arg && !arg.startsWith("--") ? arg : undefined);
  const { SidecarExtractor } = await import("../../infrastructure/extractors/semantic/sidecar.ts");
  let anyFail = false;
  for (const lang of langs) {
    const ext = new SidecarExtractor(lang, "verify");
    const check = await ext.verify();
    if (check.status === "skip") {
      console.log(`${lang}: skip — ${check.message ?? "toolchain unavailable"}`);
    } else if (check.status === "ok") {
      console.log(`${lang}: ok`);
      if (check.actual) {
        console.log(`  nodes=${check.actual.nodes} edges=${check.actual.edges}`);
      }
    } else {
      console.error(`${lang}: FAIL — ${check.message ?? "verification failed"}`);
      anyFail = true;
    }
  }
  if (anyFail) process.exit(1);
}

export async function handleSidecar(rest: string[]): Promise<void> {
  // Build/inspect the on-demand C#/Java semantic sidecars. Sources ship as
  // inert `.tmpl` templates under assets/sidecars; this materialises + builds
  // them with the local toolchain, caching under ~/.leina/sidecars.
  // sidecar verify [csharp|java] — ejecuta verify() del adaptador sobre un fixture determinista.
  const sub = rest[0];
  const arg = rest[1];

  if (sub === "verify") {
    await sidecarVerify(arg);
    return;
  }

  if (sub === "install") {
    const { installSidecar } = await import("../../infrastructure/extractors/semantic/sidecar-install.ts");
    const langs = parseSidecarLang(arg && !arg.startsWith("--") ? arg : undefined);
    let anyFail = false;
    for (const lang of langs) {
      console.log(`Installing prebuilt ${lang} sidecar ...`);
      const res = await installSidecar(lang, { force: rest.includes("--force") });
      console.log(res.ok ? `  ok -> ${res.binPath}` : `  FAILED: ${res.error}`);
      if (!res.ok) anyFail = true;
    }
    if (anyFail) process.exit(1);
    return;
  }

  const m = await import("../../infrastructure/extractors/semantic/sidecar-build.ts");
  if (sub === "build") sidecarBuild(m, arg, rest.includes("--force"));
  else if (sub === "clean") sidecarClean(m, arg);
  else sidecarStatus(m); // default: status
}

// ---------------------------------------------------------------------------
// `leina scip [status|verify|install] [<lang>]` — detect/verify third-party
// SCIP indexer binaries (deliberately NOT part of `leina sidecar`: those
// build/bundle leina-owned tools; SCIP indexers are third-party binaries the
// user installs themselves — leina only DETECTS and instructs, never
// auto-installs. See sdd/scip-ingestion design "Ubicación hexagonal y
// superficie CLI".
// ---------------------------------------------------------------------------

type ScipLangCli = (typeof WIRED_SCIP_LANGS)[number];
const SCIP_LANGS: readonly ScipLangCli[] = WIRED_SCIP_LANGS;
const SCIP_INSTALL_HINT: Record<ScipLangCli, string> = {
  go: "go install github.com/scip-code/scip-go/cmd/scip-go@latest",
  rust: "rustup component add rust-analyzer",
  python: "npm install -g @sourcegraph/scip-python (also needs `pip` on PATH — e.g. a venv's bin/)",
};

function parseScipLang(v: string | undefined): ScipLangCli[] {
  return SCIP_LANGS.includes(v as ScipLangCli) ? [v as ScipLangCli] : [...SCIP_LANGS];
}

async function scipStatus(): Promise<void> {
  const { resolveScipIndexer } = await import("../../infrastructure/extractors/semantic/scip-indexer.ts");
  for (const lang of SCIP_LANGS) {
    const argv = resolveScipIndexer(lang);
    console.log(
      argv
        ? `${lang}: found (${argv.join(" ")})`
        : `${lang}: not found  [install: ${SCIP_INSTALL_HINT[lang]}]`,
    );
  }
}

async function scipInstall(arg: string | undefined): Promise<void> {
  const { resolveScipIndexer } = await import("../../infrastructure/extractors/semantic/scip-indexer.ts");
  for (const lang of parseScipLang(arg)) {
    const argv = resolveScipIndexer(lang);
    if (argv) {
      console.log(`${lang}: already available (${argv.join(" ")})`);
      continue;
    }
    // Detect + instruct — never auto-install without consent (SCIP indexers are
    // third-party binaries, unlike the leina-owned C#/Java sidecars).
    console.log(`${lang}: not installed. Run:\n  ${SCIP_INSTALL_HINT[lang]}`);
  }
}

async function scipVerify(arg: string | undefined): Promise<void> {
  const langs = parseScipLang(arg);
  const { ScipExtractor } = await import("../../infrastructure/extractors/semantic/scip.ts");
  let anyFail = false;
  for (const lang of langs) {
    const ext = new ScipExtractor(lang, "verify");
    const check = await ext.verify();
    if (check.status === "skip") {
      console.log(`${lang}: skip — ${check.message ?? "indexer unavailable"}`);
    } else if (check.status === "ok") {
      console.log(`${lang}: ok`);
      if (check.actual) {
        console.log(`  nodes=${check.actual.nodes} edges=${check.actual.edges}`);
      }
    } else {
      console.error(`${lang}: FAIL — ${check.message ?? "verification failed"}`);
      anyFail = true;
    }
  }
  if (anyFail) process.exit(1);
}

export async function handleScip(rest: string[]): Promise<void> {
  // Detect/verify/instruct-install for third-party SCIP indexer binaries
  // (scip-go/rust-analyzer/scip-python today; scip-ruby is backlog — see
  // backlog/scip-ruby-deferred).
  // scip verify [<lang>] — runs ScipExtractor.verify() over a deterministic fixture.
  // scip install [<lang>] — detect+instruct only, never downloads/builds.
  const sub = rest[0];
  const arg = rest[1];

  if (sub === "verify") {
    await scipVerify(arg && !arg.startsWith("--") ? arg : undefined);
    return;
  }
  if (sub === "install") {
    await scipInstall(arg && !arg.startsWith("--") ? arg : undefined);
    return;
  }
  // default (no sub, or explicit "status"): status — lists every wired SCIP indexer.
  await scipStatus();
}

// ---------------------------------------------------------------------------
// `leina capabilities list [--json]` (REQ-CR-5)
// ---------------------------------------------------------------------------

/** Serialisable projection of a Capability — fn is explicitly omitted (D4). */
function serializeCapability(c: Capability) {
  return {
    id: c.id,
    description: c.description,
    inputSchema: c.inputSchema,
    outputSchema: c.outputSchema,
    transports: c.transports,
    schemaVersion: c.schemaVersion,
  };
}

export function handleCapabilities(rest: string[]): void {
  const sub = rest[0];
  if (sub !== "list") {
    // Unknown sub-command or missing sub: print usage and exit 1.
    process.stderr.write("Usage: leina capabilities list [--json]\n");
    process.exit(1);
  }
  const wantJson = rest.includes("--json");
  const caps = capabilities.map((cc) => cc.capability);

  if (wantJson) {
    console.log(JSON.stringify(caps.map(serializeCapability), null, 2));
  } else {
    console.log("leina capabilities:\n");
    for (const c of caps) {
      console.log(`  ${c.id}`);
      console.log(`    ${c.description}`);
    }
  }
}

// ---------------------------------------------------------------------------
// `leina verify [--json]` (REQ-VC-1 / REQ-VC-3)
// ---------------------------------------------------------------------------

export function handleVerify(rest: string[]): never {
  // Reuses runDoctor()/formatDoctor() without modifying doctor.ts (REQ-VC-2).
  // exit 1 ONLY when at least one check has status "fail"; "warn" alone → exit 0.
  const root = rest.find((a) => !a.startsWith("--")) ?? ".";
  const wantJson = rest.includes("--json");
  const report = runDoctor(readPackageVersion(), root);

  if (wantJson) {
    console.log(JSON.stringify(report));
  } else {
    console.log(formatDoctor(report));
  }
  process.exit(report.exitCode);
}

// Top-level help, shared by the `help`/`--help`/`-h` commands and the unknown-command default.
export function printRootHelp(): void {
  console.log(
    `leina — code knowledge graph + project memory (CLI-only)\n\n` +
      `  setup [--no-user-hooks] [--preset ...] [--skills ...] [--agents ...] [--hosts devin,claude]\n` +
      `        [--mcp]\n` +
      `                          machine-wide: activate (share + symlinks + user-global grant/hooks)\n` +
      `                          + turn blanket ON; subsequent 'init' takes LIGHT path. Idempotent.\n` +
      `                          First run auto-detects hosts (~/.claude present → claude too).\n` +
      `                          --mcp also registers the MCP server user-globally\n` +
      `  disable                 machine-wide: remove managed symlinks + revoke user-global grant/hooks\n` +
      `                          + turn blanket OFF. Idempotent when already disabled.\n` +
      `  activate [--no-user-hooks] [--preset minimal|sdd|full] [--skills a,b|all|none]\n` +
      `           [--agents a,b|all|none] [--hosts devin,claude] [--mcp]\n` +
      `                          populate ~/.leina/share + symlink skills/agents into\n` +
      `                          Devin's global dirs; merge user-global Devin hooks (default ON).\n` +
      `                          Selection flags choose WHICH bundled assets install (see\n` +
      `                          assets/catalog.json); omit them to keep the previous choice\n` +
      `  deactivate              global teardown: remove managed symlinks + revoke user-global\n` +
      `                          grant + hooks. Does NOT touch blanket sentinel. Idempotent.\n` +
      `  install-global          [deprecated — use 'activate'] alias for activate\n` +
      `  init [dir] [--hosts h1,h2] [--profile devin|windsurf] [--freshness auto|refuse]\n` +
      `       [--build] [--name <n>] [--mcp]\n` +
      `                          per-repo opt-in: consent=enabled + .gitignore; standalone (no\n` +
      `                          blanket) also AGENTS.md protocol + per-host wiring (devin →\n` +
      `                          .devin/*, claude → .claude/settings.json hooks). --hosts overrides\n` +
      `                          the persisted/detected host selection; --build builds the graph\n` +
      `                          now; --name locks the project key; --mcp registers the server in\n` +
      `                          the project .mcp.json (committable, for teams)\n` +
      `  deinit [--project <path>]\n` +
      `                          per-repo teardown (inverse of init): strip managed blocks +\n` +
      `                          set consent=disabled + remove .devin/hooks.v1.json. Idempotent.\n` +
      `  build <dir> [--json]    build the graph\n` +
      `  refresh <dir>           rebuild the graph now\n` +
      `  sidecar [build|install|status|clean|verify] [csharp|java] [--force]\n` +
      `                          manage on-demand C#/Java compiler sidecars\n` +
      `                          verify: exit 0 (skip/ok), exit 1 (fail)\n` +
      `  scip [status|verify|install] [go|rust|python]\n` +
      `                          detect/verify third-party SCIP indexer binaries\n` +
      `                          (compiler-grade precision, ahead of tree-sitter);\n` +
      `                          install: detect+instruct only, never auto-installs;\n` +
      `                          verify: exit 0 (skip/ok), exit 1 (fail)\n` +
      `  doctor [dir] [--json]   diagnose install + project health\n` +
      `  repair [dir] [--no-user-hooks]\n` +
      `                          re-run the idempotent install writers for whatever doctor\n` +
      `                          finds broken (share/symlinks/config + repo wiring); scoped\n` +
      `                          to prior installs, respects deinit, never touches DBs\n` +
      `  verify [dir] [--json]   re-run doctor with actionable exit code (exit 1 on fail)\n` +
      `  capabilities list [--json]\n` +
      `                          list the system capabilities + schemas (json omits fn field)\n` +
      `  status <dir>            freshness vs current sources + posture + last build\n` +
      `  stats <dir>             node/edge counts + confidence breakdown\n` +
      `  affected <dir> <symbol|file>  blast radius (who depends on it; a file\n` +
      `                          expands to its members)\n` +
      `  path <dir> <a> <b>      shortest path between two symbols\n` +
      `  query <dir> <question>  term-scored subgraph\n` +
      `  impact analyze [<dir>] <symbol> [--json]\n` +
      `                          bidirectional impact BFS (files/tests/services/configs)\n` +
      `  visualize <dir> [--out <path>] [--drilldown]\n` +
      `                          export an interactive offline HTML graph viewer; on a\n` +
      `                          workspace root renders constellation (or --drilldown) mode\n` +
      `  graph serve [dir] [--port <n>] [--host <h>]\n` +
      `                          foreground read-only HTTP server: stats/tree/search/node\n` +
      `                          detail + anchored memories over the graph; JSON API only,\n` +
      `                          loopback-bound (127.0.0.1/::1/localhost), Ctrl+C to stop\n` +
      `  workspace <build|status|detect|memory|visualize> [dir]\n` +
      `                          multi-repo workspace: merged graph, per-member freshness,\n` +
      `                          federated memory (context|search), constellation viz\n` +
      `  audit [dir] [--format md|json|html] [--from <id,...>]\n` +
      `                          source->sink candidate paths + findings[] (evidence for\n` +
      `                          triage); subs: catalog | reachability | pack | visualize\n` +
      `  events tail [dir] [--json]\n` +
      `                          print the local event outbox (off unless\n` +
      `                          LEINA_EVENTS_PERSIST=1)\n` +
      `  memory <dir> <sub>      local memory (save|update|search|verified|get|context|session|\n` +
      `                          session-start|suggest-topic|current-project|merge-projects|migrate)\n` +
      `  mcp                     MCP server over stdio (tools = the capability registry);\n` +
      `                          register with your host: command "leina", args ["mcp"]\n` +
      `  mcp <register|unregister|status> [--hosts claude,cursor,windsurf]\n` +
      `                          user-global registration: one server entry per host covers\n` +
      `                          every project (tools take root; default = workspace cwd)\n` +
      `  tui [dir]               interactive console: install/update (asset groups), init/deinit,\n` +
      `                          status, repair, env vars, uninstall — same logic as the commands\n` +
      `  env <sub>               variables for skills that call services (names-not-values:\n` +
      `                          set KEY [hidden prompt/stdin] | list [masked] | get KEY [--reveal]\n` +
      `                          | unset KEY | exec [--only K1,K2] -- <cmd...> [injects values])\n` +
      `  agent-hook <Event>      host-neutral agent hook gate (stdin = payload JSON;\n` +
      `                          alias: devin-hook)\n` +
      `  version | --version     print the leina version\n`,
  );
}
