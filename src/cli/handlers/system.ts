// cli/handlers/system.ts — diagnostics, hook bridge, sidecar, capabilities and verify.

import { runDoctor, formatDoctor } from "../doctor.ts";
import { parseAgentHookArgs, runAgentGate, runHarnessAgentGate, resolveHookRoots, shouldDeferInvocation } from "../agent-gate.ts";
import { readPackageVersion } from "../../version.ts";
import { readStdin, usageError } from "../io.ts";
import { dirOnly } from "../project-args.ts";
import { capabilities } from "../../application/capabilities/registry.ts";
import type { Capability } from "../../domain/capabilities/model.ts";
import { WIRED_SCIP_LANGS } from "../../infrastructure/extractors/semantic/scip-indexer.ts";

export function handleDoctor(rest: string[]): never {
  // Read-only health diagnostics across env, global share, host symlinks and the project.
  // Exits 1 if any check failed, else 0.
  // Supports --json to emit the raw DoctorReport as JSON to stdout.
  const root = dirOnly("doctor", rest);
  const wantJson = rest.includes("--json");
  const report = runDoctor(readPackageVersion(), root);
  if (wantJson) {
    process.stdout.write(JSON.stringify(report));
  } else {
    console.log(formatDoctor(report, { color: useColor() }));
  }
  process.exit(report.exitCode);
}

/** Colour only when stdout is a real terminal and the user hasn't opted out (NO_COLOR,
 * https://no-color.org). Piped/redirected output and CI capture stay plain, which keeps
 * the golden CLI tests stable and avoids escape-code noise in logs. */
function useColor(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

export async function handleAgentHook(rest: string[]): Promise<never> {
  // Host-neutral agent hooks bridge — invoked as `leina agent-hook <EventName>` (compat
  // alias: `devin-hook`, still emitted by existing `.devin/hooks.v1.json` installs) with the
  // hook's JSON payload on stdin. Advisory-only by default: emits a stderr nudge when memory
  // hasn't been loaded, never blocks. Fails OPEN on every error path. See src/cli/agent-gate.ts.
  // Supported managed events: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart,
  // PostCompaction (re-injects memory + graph context after compaction),
  // Stop (advisory nudge to persist session memory when session.memory-saved is absent).
  //
  // HARNESS ENFORCEMENT BRANCH (product invariant — see runHarnessAgentGate): only in a
  // trusted workspace (`leina init` → out-of-repo trust record). There, writes to the
  // harness rules/config are always refused, and with an ACTIVE harness contract
  // (.harness/state/current/contract.json) or strictness "strict", PreToolUse edit/bash and
  // Stop may BLOCK (exit 2 / decision:block). Guided mode without a contract leaves the
  // advisory behaviour below untouched, byte for byte, except for that integrity seal.
  const invocation = parseAgentHookArgs(rest, process.env);
  const { event: eventName, host } = invocation;
  // Resolve the roots from the host's documented CLAUDE_PROJECT_DIR / DEVIN_PROJECT_DIR env
  // var (fallback to process.cwd()) — the hook payload itself never carries a cwd — walking
  // up from subdirectories and worktrees. See resolveHookRoots.
  const rawStdin = readStdin();
  const { start, root, harnessRoot } = resolveHookRoots(process.env, process.cwd());
  // One answer per event: a lower-priority copy of the wiring (typically the user-global
  // one, when the project wires this host itself) stands down. See shouldDeferInvocation.
  if (shouldDeferInvocation(invocation, start, process.env)) process.exit(0);
  const harness = await runHarnessAgentGate(rawStdin, harnessRoot, eventName, host);
  if (harness.handled) process.exit(harness.exitCode);
  runAgentGate(rawStdin, root, eventName, {
    ...(harness.sessionContext !== undefined ? { harnessSessionContext: harness.sessionContext } : {}),
    host,
  });
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

/** Serialisable projection of a Capability's metadata (schemas + transports). */
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
  // The dispatcher only routes `capabilities list` here; anything else is a usage error.
  if (rest[0] !== "list") usageError(`unknown sub-command '${rest[0] ?? ""}'`, "capabilities");
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
  const root = dirOnly("verify", rest);
  const wantJson = rest.includes("--json");
  const report = runDoctor(readPackageVersion(), root);

  if (wantJson) {
    console.log(JSON.stringify(report));
  } else {
    console.log(formatDoctor(report, { color: useColor() }));
  }
  process.exit(report.exitCode);
}
