// cli/handlers/install.ts — install/activation command handlers: activate, install-global,
//   init, setup, disable, deactivate, deinit.
//
// handleInit is decomposed into one helper per artifact it writes (each kept under the
// Cognitive-Complexity gate); the helpers accumulate human-readable lines into the shared
// `written` / `removed` arrays that the final report prints.
//
// PR2 changes:
//  - handleInit is now ADAPTIVE: branches on isBlanketActive().
//      LIGHT (blanket=on)  → writeConsentFlag("enabled") + ensure .gitignore only.
//      FULL  (blanket=off) → AGENTS.md + .devin/hooks.v1.json + local Exec grant +
//                            .gitignore + writeConsentFlag("enabled").
//  - Removed: maybeActivateInline (--activate flag), writeUserGlobal (init never mutates
//    ~/.config/devin/config.json), migrateLegacyRegistry, spawnDetachedBuild (no auto-build).
//  - writeDevinConfig: MCP-server strip removed; only grantCliExecPermission remains.
//  - Added: --build flag → synchronous foreground graph build (dynamic import of graph.ts).
//  - --no-global-skills / --activate / --write-user-config: silently ignored (back-compat).
//
// PR4 changes:
//  - handleDisable: refactored to delegate global teardown to runDeactivate() (avoids
//    duplicated logic); then removes blanket sentinel. disable = runDeactivate + blanket-off.
//  - handleDeactivate: global teardown only (runDeactivate), does NOT touch blanket.
//  - handleDeinit: per-repo inverse of init — strips managed blocks, sets consent=disabled,
//    removes .devin/hooks.v1.json (FULL) and local Exec grant. Idempotent; "nothing to revert"
//    when no changes are needed (OQ-2). [T1, T3, D3]

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { deriveCliCommand } from "../../application/install/command.ts";
import { mergeAgentsMd, removeAgentsMdBlock } from "../../application/install/agents.ts";
import {
  DEVIN_PROFILE,
  WINDSURF_PROFILE,
  mergeCapabilitiesSection,
} from "../../application/install/agent-instructions.ts";
import { capabilities } from "../../application/capabilities/registry.ts";
import type { AgentProfile } from "../../domain/install/agent.ts";
import { mergeGitignore, removeGitignoreBlock } from "../../application/install/gitignore.ts";
import { devinHooksJson } from "../../application/install/devin-hooks.ts";
import { grantCliExecPermission, grantMcpPermission, revokeCliExecPermission, revokeMcpPermission } from "../../application/install/permissions.ts";
import { readConsentFlag, writeConsentFlag } from "../../application/install/consent.ts";
import { runActivate, runDeactivate } from "../../application/activate.ts";
import {
  deriveProjectKey,
  readProjectConfig,
  writeProjectConfig,
} from "../../application/project/detect-key.ts";
import {
  detectInstalledHosts,
  entryAssetsRoot,
  isGlobalActivated,
  isBlanketActive,
} from "../../infrastructure/install/global.ts";
import { blanketFile, HOSTS, hostSpec, MCP_HOSTS, shareSelectionFile, userHome, type HostId, type McpHostId } from "../../infrastructure/install/share-paths.ts";
import { mergeShellWrapper, shellInteropAdvisory } from "../../infrastructure/install/shell.ts";
import { readPackageVersion } from "../../version.ts";
import { fail, readIfExists } from "../io.ts";
import { hasFlag, optFlag } from "../args.ts";
import { runDoctor } from "../doctor.ts";
import { deserializeSelection, parseCatalog, resolveSelection, type Selection } from "../../application/install/catalog.ts";
import { addMcpRegistration, removeMcpRegistration } from "../../application/install/mcp-config.ts";
import { registerMcpGlobal, unregisterMcpGlobal } from "../../infrastructure/install/mcp-hosts.ts";
import { printMcpResults } from "./mcp-admin.ts";
import { AGENT_HOOK_MARK, claudeHooksJson, removeClaudeHooks } from "../../application/install/claude-hooks.ts";

type CliBase = ReturnType<typeof deriveCliCommand>;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The bundled assets anchor (entryAssetsRoot) lives in infrastructure/install/global.ts —
// shared with doctor's resolution-anchor check without creating an import cycle
// (this module imports doctor.ts for `repair`).

// Runtime replacement for the removed npm postinstall advisory: pnpm and bun skip
// dependency lifecycle scripts by default (and --ignore-scripts is common), so the
// Git Bash interop warning is delivered at the install moments leina controls —
// setup/activate/init — where it always runs, whatever the package manager.
function maybeShellInteropAdvisory(): void {
  const advisory = shellInteropAdvisory(
    process.env,
    process.platform,
    resolvePath(process.argv[1] ?? "."),
  );
  if (advisory) process.stderr.write(`\n[leina] ${advisory}\n\n`);
}

/**
 * Resolve the activation inputs from argv and run `runActivate`, failing with a labelled error.
 * Shared by the `activate` and (deprecated) `install-global` commands — both derive identical
 * assets/version/cli context and only differ in the error label.
 */
// Parse the asset-selection flags (--preset / --skills / --agents) against the bundled
// catalog. Returns undefined when no flag was given — installGlobal then keeps the
// persisted selection (or everything). Validation problems are hard failures: a typo'd
// skill name must not silently install the wrong set.
function knownHostIds(): string {
  return HOSTS.map((x) => x.id).join(", ");
}

// Parse & validate a --hosts CSV; hard-fail on empty or unknown host ids.
function parseHostsFlag(hostsFlag: string): HostId[] {
  const hosts = hostsFlag.split(",").map((h) => h.trim()).filter((h) => h.length > 0);
  if (hosts.length === 0) fail(`--hosts must name at least one host (known: ${knownHostIds()})`);
  for (const h of hosts) {
    if (!hostSpec(h)) fail(`unknown host "${h}" (known: ${knownHostIds()})`);
  }
  return hosts as HostId[];
}

// Raw persisted host selection from share/.selection.json, WITHOUT the internal
// DEFAULT_HOSTS fallback deserializeSelection applies — so the CLI can tell whether the
// user ever EXPLICITLY chose hosts (a prior activate/tui) versus inheriting a silent
// default. undefined = never chosen.
function persistedHostsRaw(): HostId[] | undefined {
  const raw = readIfExists(shareSelectionFile());
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { hosts?: unknown };
    if (!Array.isArray(parsed.hosts)) return undefined;
    const hosts = parsed.hosts.filter((h): h is HostId => typeof h === "string" && hostSpec(h) !== undefined);
    return hosts.length > 0 ? hosts : undefined;
  } catch {
    return undefined;
  }
}

// Vendor-neutral host resolution for the CLI: leina NEVER picks an AI host on its own.
// --hosts flag > a prior EXPLICIT persisted choice > hard error that SUGGESTS (but never
// chooses) what's installed. This is what stops setup/activate/init from silently wiring a
// default vendor (historically Devin) the user never asked for. Returns the resolved hosts
// so callers can also use them as a gate (ignore the value) or a value.
function requireHosts(label: string, hostsFlag: string | undefined): HostId[] {
  if (hostsFlag !== undefined) return parseHostsFlag(hostsFlag);
  const persisted = persistedHostsRaw();
  if (persisted !== undefined) return persisted;
  const detected = detectInstalledHosts();
  const hint = detected.length > 0 ? `detected on this machine: ${detected.join(", ")}` : "none detected on this machine";
  return fail(
    `${label}: --hosts is required — leina will not choose an AI host for you.\n` +
      `  Known hosts: ${knownHostIds()} (${hint}).\n` +
      `  Re-run with e.g.: leina ${label} --hosts ${detected[0] ?? HOSTS[0]!.id}`,
  );
}

function selectionFromArgs(label: string, args: string[], assetsRoot: string): Selection | undefined {
  const preset = optFlag(args, "--preset", undefined);
  const skillsFlag = optFlag(args, "--skills", undefined);
  const agentsFlag = optFlag(args, "--agents", undefined);
  const hostsFlag = optFlag(args, "--hosts", undefined);
  if (preset === undefined && skillsFlag === undefined && agentsFlag === undefined && hostsFlag === undefined) {
    return undefined;
  }

  const csv = (v: string | undefined): string[] | undefined =>
    v === undefined ? undefined : v.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  try {
    const hosts = csv(hostsFlag);
    for (const h of hosts ?? []) {
      if (!hostSpec(h)) {
        throw new Error(`unknown host "${h}" (known: ${HOSTS.map((x) => x.id).join(", ")})`);
      }
    }
    const persisted = deserializeSelection(readIfExists(shareSelectionFile()));

    // --hosts alone changes WHERE without touching WHAT: keep the persisted asset choice.
    if (preset === undefined && skillsFlag === undefined && agentsFlag === undefined) {
      return { skills: persisted?.skills ?? null, agents: persisted?.agents ?? null, hosts };
    }

    const catalogPath = join(assetsRoot, "catalog.json");
    const raw = readIfExists(catalogPath);
    if (raw === null) throw new Error(`bundled catalog missing at ${catalogPath}`);
    const resolved = resolveSelection(parseCatalog(raw), {
      preset,
      skills: csv(skillsFlag),
      agents: csv(agentsFlag),
    });
    for (const a of resolved.autoAdded) {
      process.stderr.write(`[leina] auto-included (required/dependency): ${a}\n`);
    }
    // Asset flags without --hosts keep the previously selected hosts.
    return { ...resolved.selection, hosts: hosts ?? persisted?.hosts };
  } catch (err) {
    fail(`${label}: ${errMsg(err)}`);
  }
}

// --mcp on activate/setup: user-global MCP registration (one server entry per host covers
// every project — tools resolve `root` at call time). Vendor-neutral: --mcp never registers
// to a host on its own. MCP hosts (claude/cursor/windsurf) are a DIFFERENT set from the
// install --hosts (devin/claude), so --mcp requires its own explicit --mcp-hosts list.
function maybeRegisterMcpGlobal(label: string, args: string[]): void {
  if (!hasFlag(args, "--mcp")) return;
  const raw = optFlag(args, "--mcp-hosts", undefined);
  const knownMcp = MCP_HOSTS.map((h) => h.id).join(", ");
  if (raw === undefined) {
    fail(
      `${label} --mcp requires --mcp-hosts — name which MCP hosts to register the server on.\n` +
        `  Known MCP hosts: ${knownMcp} (a separate set from the install --hosts).\n` +
        `  Example: leina ${label} ... --mcp --mcp-hosts claude,cursor`,
    );
  }
  const ids = raw.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  if (ids.length === 0) fail(`--mcp-hosts must name at least one MCP host (known: ${knownMcp})`);
  for (const id of ids) {
    if (!MCP_HOSTS.some((h) => h.id === id)) fail(`unknown MCP host "${id}" (known: ${knownMcp})`);
  }
  console.log(`\n${label} --mcp — user-global MCP registration:`);
  printMcpResults(registerMcpGlobal(ids as McpHostId[]));
}

function activateFromArgs(label: string, args: string[]): boolean {
  maybeShellInteropAdvisory();
  const assetsRoot = entryAssetsRoot();
  const version = readPackageVersion();
  // Vendor-neutral gate: leina never picks an AI host on its own. Fail BEFORE any writes
  // unless the user passed --hosts or already made an explicit choice we can inherit (the
  // actual host values then flow through selectionFromArgs / the persisted selection).
  requireHosts(label, optFlag(args, "--hosts", undefined));
  const selection = selectionFromArgs(label, args, assetsRoot);
  const cliBase = deriveCliCommand({
    cliEntry: resolvePath(process.argv[1] ?? "."),
    execPath: process.execPath,
  });
  try {
    const report = runActivate({ assetsRoot, version, cliBase, userHooks: !hasFlag(args, "--no-user-hooks"), selection });
    // Partial failure (e.g. malformed user config): the steps that could run did run
    // (best-effort — all writers are idempotent, re-run repairs), but the exit code and a
    // stderr block must say so instead of a silent success.
    if (!report.ok) {
      for (const p of report.problems) process.stderr.write(`✖ ${label}: ${p}\n`);
      process.exitCode = 1;
    }
    return report.ok;
  } catch (err) {
    // installGlobal threw: the share itself could not be populated — nothing downstream
    // (symlinks, config) ran, so this stays a hard labelled failure.
    fail(`${label}: ${errMsg(err)}`);
  }
}

export function handleActivate(rest: string[]): void {
  // Populate the global share (~/.leina/share/{skills,agents,workflows}) from this
  // package's bundled assets, symlink it into Devin's global skills/agents dirs, and
  // write the user-global Devin config (Exec grant + optional hooks). Idempotent.
  // --no-user-hooks  skip merging the user-global Devin hooks (default: hooks ON)
  // --mcp            also register the MCP server user-globally (claude/cursor/windsurf)
  activateFromArgs("activate", rest);
  maybeRegisterMcpGlobal("activate", rest);
}

export function handleInstallGlobal(rest: string[]): void {
  // Deprecated alias for `activate`. Kept for back-compat with scripts/CI.
  process.stderr.write(`[leina] 'install-global' is deprecated; use 'leina activate'.\n`);
  activateFromArgs("install-global", rest);
}

// UNIFORM ERROR CONTRACT for init steps: every writer below is best-effort — a failing
// step records into `failures` and init keeps going, attempts every remaining artifact,
// prints ✖ lines in the final report and exits 1. No step may abort the sequence
// (a half-written init used to depend on WHICH step broke) and no step may downgrade a
// failure to a console "Notice" (a missing grant used to pass silently). Re-running init
// repairs: every writer is idempotent.

// --name: lock project name in .leina/config.json (committable). This is idempotent:
// re-running init with the same --name overwrites with identical content.
//
// Without --name the key currently derived is pinned AUTOMATICALLY (unless one is
// already locked). The key is otherwise re-derived on every invocation, so adding a
// git remote after init used to silently re-home the project under a new key and
// orphan its memories in the global DB. Pinning at init freezes the identity at the
// moment the user opted in. Ambiguous/failed derivation → skip (previous behavior).
function lockProjectName(
  project: string,
  nameArg: string | undefined,
  written: string[],
  failures: string[],
): void {
  let name = nameArg?.trim();
  if (name === undefined) {
    if (readProjectConfig(project) !== null) return; // already locked — respect it
    try {
      name = deriveProjectKey(project).key;
    } catch {
      return; // AmbiguousProjectError etc. — no pin, same as before
    }
  }
  try {
    writeProjectConfig(project, name);
    written.push(`.leina/config.json (project name locked: ${name})`);
  } catch (err) {
    failures.push(`.leina/config.json: ${errMsg(err)}`);
  }
}

// AGENTS.md — soft-enforcement surface read by every host that respects the AGENTS.md
// convention (Devin included). mergeAgentsMd refuses a malformed managed section.
// When profile is Windsurf, mergeCapabilitiesSection is applied after the protocol merge.
// Used only in FULL init (blanket=off).
function writeAgentsMd(
  project: string,
  profile: AgentProfile,
  written: string[],
  failures: string[],
): void {
  const agentsPath = join(project, "AGENTS.md");
  try {
    mkdirSync(project, { recursive: true });
    const existing = readIfExists(agentsPath);
    let content = mergeAgentsMd(existing);
    if (profile.id === "windsurf") {
      content = mergeCapabilitiesSection(content, capabilities);
    }
    writeFileSync(agentsPath, content);
    written.push("AGENTS.md");
  } catch (err) {
    failures.push(`AGENTS.md: ${errMsg(err)}`);
  }
}

// .gitignore — keep .leina/ runtime data (graph.db + memory.db) out of version control.
// Also covers .leina/consent (C2). Used in both LIGHT and FULL init.
function writeGitignoreStep(project: string, written: string[], failures: string[]): void {
  const gitignorePath = join(project, ".gitignore");
  try {
    writeFileSync(gitignorePath, mergeGitignore(readIfExists(gitignorePath)));
    written.push(".gitignore");
  } catch (err) {
    failures.push(`.gitignore: ${errMsg(err)}`);
  }
}

// .devin/config.json — pre-authorize `Exec(leina)` in permissions.allow so the agent
// never gets a permission prompt for `leina query/affected/memory ...`. Lives in the
// committable project config (not the machine-global one) so it travels with the repo.
// NOTE: MCP-server strip removed in PR2 — init no longer performs MCP migration in the local
// project config. If you need to strip dead MCP entries, run `leina doctor`.
// Used only in FULL init (blanket=off).
function writeDevinConfig(project: string, written: string[], failures: string[]): void {
  const devinCfgPath = join(project, ".devin", "config.json");
  try {
    mkdirSync(dirname(devinCfgPath), { recursive: true });
    const existing = readIfExists(devinCfgPath);
    const granted = grantCliExecPermission(existing);
    if (granted !== null) {
      writeFileSync(devinCfgPath, granted);
      written.push(".devin/config.json (pre-authorized Exec(leina))");
    }
  } catch (err) {
    failures.push(`.devin/config.json: ${errMsg(err)} — Exec(leina) grant NOT written (the agent will hit permission prompts)`);
  }
}

// Devin project hooks file. Merge the managed block into any existing file.
// MCP-matcher stripping removed (M1): init no longer performs MCP migration. To clean
// dead MCP entries from a pre-existing config, run `leina doctor`.
// Used only in FULL init (blanket=off).
function writeDevinHooks(
  project: string,
  cliBase: CliBase,
  written: string[],
  failures: string[],
): void {
  const devinHooksPath = join(project, ".devin", "hooks.v1.json");
  try {
    mkdirSync(dirname(devinHooksPath), { recursive: true });
    const current = readIfExists(devinHooksPath);
    const art = devinHooksJson(cliBase, project, current);
    writeFileSync(devinHooksPath, art.content);
    written.push(art.path);
  } catch (err) {
    failures.push(`.devin/hooks.v1.json: ${errMsg(err)}`);
  }
}

// .mcp.json — project-level MCP registration (Claude Code/Cursor convention): the
// "leina" entry pointing at `leina mcp`. Only written on --mcp (MCP is one transport,
// not the default; the CLI protocol needs no registration). Merge-safe: other servers
// and unknown keys are preserved; malformed JSON is never clobbered.
function writeMcpRegistrationStep(project: string, written: string[], failures: string[]): void {
  const mcpPath = join(project, ".mcp.json");
  try {
    const merged = addMcpRegistration(readIfExists(mcpPath));
    if (merged !== null) {
      writeFileSync(mcpPath, merged);
      written.push(".mcp.json (leina MCP server registered)");
    }
  } catch (err) {
    failures.push(`.mcp.json: ${errMsg(err)}`);
  }
  // Server-level tool grant ("mcp__leina", all tools in one entry) in the committable
  // project settings — saves the per-tool permission prompt in Claude Code.
  const settingsPath = join(project, ".claude", "settings.json");
  try {
    const granted = grantMcpPermission(readIfExists(settingsPath));
    if (granted !== null) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, granted);
      written.push(".claude/settings.json (mcp__leina permission grant)");
    }
  } catch (err) {
    failures.push(`.claude/settings.json: ${errMsg(err)}`);
  }
}

// .claude/settings.json — Claude Code project hooks calling the host-neutral gate
// (`leina agent-hook <Event>`). Opt-in via --claude-hooks: the same advisory/injection
// behaviour Devin gets, for repos driven by Claude Code. Merge-safe by AGENT_HOOK_MARK.
function writeClaudeHooksStep(project: string, cliBase: CliBase, written: string[], failures: string[]): void {
  const settingsPath = join(project, ".claude", "settings.json");
  try {
    const merged = claudeHooksJson(cliBase, readIfExists(settingsPath));
    if (merged !== null) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, merged);
      written.push(".claude/settings.json (agent-hook entries for Claude Code)");
    }
  } catch (err) {
    failures.push(`.claude/settings.json: ${errMsg(err)}`);
  }
}

// .leina/consent — the tri-state per-repo flag. A failure here means init did not
// actually enable the repo, so it is recorded like any other step.
function writeConsentStep(project: string, written: string[], failures: string[]): void {
  try {
    writeConsentFlag(project, "enabled");
    written.push(".leina/consent (enabled)");
  } catch (err) {
    failures.push(`.leina/consent: ${errMsg(err)}`);
  }
}

// Advisory nudge when global activation has never been run AND blanket is not active.
// Shown in both LIGHT and FULL, but only when activation is genuinely absent (not when
// blanket covers it — under blanket, setup already ran activate). Never blocks; advisory only.
function maybeActivationNudge(): void {
  if (!isBlanketActive() && !isGlobalActivated()) {
    process.stderr.write(
      `[leina] global activation not detected — run 'leina activate' to enable skills/agents globally.\n`,
    );
  }
}

function printInitReport(
  project: string,
  written: string[],
  removed: string[],
  failures: string[],
  mode: "light" | "full",
  buildRan: boolean,
  hosts: HostId[],
): void {
  const modeLabel = mode === "light" ? "LIGHT (blanket mode)" : `FULL (standalone, hosts: ${hosts.join(", ")})`;
  console.log(`leina init [${modeLabel}] — wrote into ${project}:`);
  for (const w of written) console.log(`  + ${w}`);
  for (const r of removed) console.log(`  - ${r}`);
  for (const f of failures) console.log(`  ✖ ${f}`);
  if (failures.length > 0) {
    console.log(
      `\ninit finished with ${failures.length} error(s) — the ✖ steps above were NOT applied.` +
        `\nFix the cause and re-run 'leina init' (every step is idempotent; the + steps stay as-is).`,
    );
  }
  if (buildRan) {
    console.log(`\nGraph built.`);
    console.log(
      `Query it:  leina query ${project} "<question>"  /  leina affected ${project} <symbol>`,
    );
  } else {
    console.log(
      `\nBuild the graph with:  leina build ${project}\n` +
        `Then query it:  leina query ${project} "<question>"  /  leina affected ${project} <symbol>`,
    );
  }
}

// Resolve the agent profile from --agent (back-compat alias) and --profile flags.
// --profile wins over the --agent alias; default is devin. Invalid values `fail()`.
function resolveInitProfile(
  agentFlag: string | undefined,
  profileFlag: string | undefined,
): AgentProfile | undefined {
  // --agent windsurf is removed; fail with a migration message.
  if (agentFlag === "windsurf") {
    fail(`--agent windsurf is no longer supported. Use --profile windsurf instead.`);
  }
  // --agent devin is a back-compat alias for --profile devin (no-op beyond that).
  // Any other --agent value is rejected.
  if (agentFlag !== undefined && agentFlag !== "devin") {
    fail(`unknown --agent "${agentFlag}" (only "devin" is supported as a back-compat alias; use --profile instead)`);
  }

  // --profile wins over the --agent devin back-compat alias. NO silent default: a full init
  // must name its AGENTS.md profile explicitly (required in writeInitArtifacts). undefined
  // here means "not specified" — leina will not assume a vendor profile.
  const rawProfile = profileFlag ?? (agentFlag === "devin" ? "devin" : undefined);
  if (rawProfile === undefined) return undefined;
  if (rawProfile === "devin") return DEVIN_PROFILE;
  if (rawProfile === "windsurf") return WINDSURF_PROFILE;
  return fail(`unknown --profile "${rawProfile}" (expected: devin | windsurf)`);
}

// Which hosts init should wire — same vendor-neutral resolution as activate/setup:
// --hosts flag (validated) > a prior EXPLICIT persisted choice (activate/tui) > hard error.
// leina never auto-detects a host into a write; a host the user never selected must not get
// its project files written (the same host-neutral rule doctor applies when reading them).
function resolveInitHosts(hostsFlag: string | undefined): HostId[] {
  return requireHosts("init", hostsFlag);
}

// Project-level hook wiring evidence, for ANY host: Devin's managed hooks file, or a
// .claude/settings.json carrying our agent-hook entries. Shared by repair's evidence
// gate and the TUI's "(wired)" badge.
export function hasHookWiring(project: string): boolean {
  if (existsSync(join(project, ".devin", "hooks.v1.json"))) return true;
  const claude = readIfExists(join(project, ".claude", "settings.json"));
  return claude?.includes(AGENT_HOOK_MARK) ?? false;
}

// Write the per-repo init artifacts, branching on blanket mode. Returns the mode label.
// Best-effort: every step is attempted regardless of earlier failures (see the uniform
// error contract above the writers).
function writeInitArtifacts(
  project: string,
  profile: AgentProfile | undefined,
  cliBase: CliBase,
  hosts: HostId[],
  written: string[],
  failures: string[],
): "light" | "full" {
  if (isBlanketActive()) {
    // ── LIGHT: blanket is active ─────────────────────────────────────────────
    // The machine-wide share (skills/agents/grant/hooks) is already in place from `setup`.
    // init only records per-repo consent and ensures the gitignore block. No AGENTS.md, so
    // no profile is needed here.
    writeConsentStep(project, written, failures);
    writeGitignoreStep(project, written, failures);
    return "light";
  }
  // A full init writes AGENTS.md, which needs a profile. Vendor-neutral: require it
  // explicitly (--profile devin|windsurf, or the --agent devin alias) rather than assume a
  // default. This fail() also narrows `profile` to AgentProfile for writeAgentsMd below.
  if (profile === undefined) {
    fail(
      `init: --profile is required for a full init (it writes AGENTS.md) — expected: devin | windsurf.\n` +
        `  (A LIGHT init under 'leina setup' blanket mode doesn't need one.)`,
    );
  }
  // ── FULL: standalone (no blanket) ────────────────────────────────────────
  // Host-neutral artifacts always; host-specific wiring only for the selected hosts.
  // ~/.config/devin/config.json is NEVER touched (I3).
  writeAgentsMd(project, profile, written, failures);
  writeGitignoreStep(project, written, failures);
  if (hosts.includes("devin")) {
    writeDevinConfig(project, written, failures);
    writeDevinHooks(project, cliBase, written, failures);
  }
  if (hosts.includes("claude")) {
    writeClaudeHooksStep(project, cliBase, written, failures);
  }
  writeConsentStep(project, written, failures);
  return "full";
}

export async function handleInit(rest: string[]): Promise<void> {
  // leina init [<dir> | --project <dir>]
  //   [--hosts devin,claude]           (which hosts to wire; default: persisted selection
  //                                     from activate/tui, else auto-detection)
  //   [--profile devin|windsurf]       (agent profile; default: devin)
  //   [--agent devin]                  (back-compat alias for --profile devin; exit 0)
  //   [--agent windsurf]               (removed — fails with migration message)
  //   [--freshness auto|refuse]
  //   [--build]                        (opt-in: build graph synchronously in foreground)
  //   [--mcp]                          (opt-in: register `leina mcp` in the project .mcp.json)
  //   [--claude-hooks]                 (force Claude Code hooks even when the claude host
  //                                     is not selected; automatic when it is)
  //
  // ADAPTIVE init — branches on isBlanketActive():
  //   LIGHT (blanket=on):  writeConsentFlag("enabled") + ensure .gitignore block.
  //                        Does NOT write AGENTS.md, host hooks, or Exec grant.
  //   FULL  (blanket=off): AGENTS.md protocol block + .gitignore + writeConsentFlag, plus
  //                        per selected host: devin → .devin/hooks.v1.json + LOCAL Exec
  //                        grant in .devin/config.json; claude → .claude/settings.json hooks.
  //
  // Neither branch touches ~/.config/devin/config.json (I3).
  // No auto-build in either branch; use --build for an on-demand foreground build (I2).
  //
  // Back-compat: --activate, --no-global-skills, --write-user-config are silently ignored.
  const positional = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  const project = resolvePath(optFlag(rest, "--project", undefined) ?? positional ?? ".");

  const agentFlag   = optFlag(rest, "--agent", undefined);
  const profileFlag = optFlag(rest, "--profile", undefined);
  const freshness   = optFlag(rest, "--freshness", "auto");
  const nameArg     = optFlag(rest, "--name", undefined);
  const doBuild     = hasFlag(rest, "--build");
  const doMcp       = hasFlag(rest, "--mcp");
  const doClaudeHooks = hasFlag(rest, "--claude-hooks");

  const profile = resolveInitProfile(agentFlag, profileFlag);
  const hosts = resolveInitHosts(optFlag(rest, "--hosts", undefined));

  if (freshness !== "auto" && freshness !== "refuse") {
    fail(`unknown --freshness "${freshness}" (expected: auto | refuse)`);
  }
  if (nameArg?.trim().length === 0) {
    fail(`--name must not be empty`);
  }

  // The hooks call back into THIS CLI on disk (absolute node + cli entry), so they work
  // regardless of PATH. This is the only launch form we emit now — there is no MCP server.
  const cliBase = deriveCliCommand({
    cliEntry: resolvePath(process.argv[1] ?? "."),
    execPath: process.execPath,
  });

  maybeShellInteropAdvisory();

  const written: string[] = [];
  const removed: string[] = [];
  const failures: string[] = [];

  lockProjectName(project, nameArg, written, failures);

  const mode = writeInitArtifacts(project, profile, cliBase, hosts, written, failures);

  if (doMcp) writeMcpRegistrationStep(project, written, failures);
  // --claude-hooks forces the Claude wiring when the claude host was not selected
  // (idempotent: a no-op when the FULL branch above already wrote it).
  if (doClaudeHooks) writeClaudeHooksStep(project, cliBase, written, failures);

  maybeActivationNudge();

  // --build: optional synchronous foreground graph build (I2, OQ-3).
  // Dynamic import keeps the heavy extractor stack out of the install startup path.
  // Still runs after partial failures — the graph does not depend on the wiring artifacts.
  if (doBuild) {
    const { handleBuild } = await import("./graph.ts");
    await handleBuild([project]);
  }

  printInitReport(project, written, removed, failures, mode, doBuild, hosts);
  if (failures.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// PR3: setup + disable (machine-level blanket commands)
// ---------------------------------------------------------------------------

/**
 * `leina setup [--no-user-hooks]`
 *
 * Machine-wide idempotent activation:
 *   1. `runActivate` — populate share + symlink into host dirs + write user-global grant + hooks.
 *   2. Write the blanket sentinel (`$LEINA_HOME/.blanket`) so subsequent `init` runs
 *      take the LIGHT path (consent + .gitignore only; no per-repo AGENTS.md / hooks / grant).
 *
 * Idempotent: re-running produces the same on-disk state (activate is already idempotent;
 * `writeFileSync` on an existing file is a content-equal overwrite). [B2, D1]
 */
export function handleSetup(rest: string[]): void {
  const activateOk = activateFromArgs("setup", rest);
  maybeRegisterMcpGlobal("setup", rest);
  writeFileSync(blanketFile(), "");
  console.log(`\nleina setup — blanket mode ON.`);
  console.log(`  Sentinel: ${blanketFile()}`);
  console.log(`  Run 'leina init' in any project to wire it up (LIGHT mode).`);
  if (!activateOk) {
    console.log(
      `  WARNING: activation reported errors above — blanket mode is ON but incomplete.` +
        ` Fix the cause and re-run 'leina setup'.`,
    );
  }
}

/**
 * `leina disable`
 *
 * Machine-wide inverse of `setup`. Idempotent.
 *   1. `runDeactivate` — remove managed symlinks + revoke user-global Exec grant + hooks. [T1, D3]
 *      (delegates to activate.ts to avoid duplicated teardown logic)
 *   2. `rmSync(blanketFile(), {force:true})` — delete the blanket sentinel (no-op when absent). [B3, D1]
 *
 * When already disabled: all steps are no-ops → exit 0, minimal stdout. [B3-2]
 */
export function handleDisable(_rest: string[]): void {
  // Delegate global teardown to runDeactivate (shared with handleDeactivate).
  deactivateFromArgs("disable");
  // Remove blanket sentinel (force: no-op when absent). [B3, D1]
  rmSync(blanketFile(), { force: true });
  console.log(`leina disable — blanket mode OFF.`);
  console.log(`  Run 'leina setup' to re-enable blanket mode.`);
}

// ---------------------------------------------------------------------------
// repair — re-run the idempotent install writers for whatever doctor finds broken
// ---------------------------------------------------------------------------

// 5. .mcp.json: remove the leina MCP registration (if any); other servers preserved.
//    Also revokes the mcp__leina grant from the project .claude/settings.json.
function deinitMcpRegistration(project: string, removed: string[]): void {
  const mcpPath = join(project, ".mcp.json");
  const stripped = removeMcpRegistration(readIfExists(mcpPath));
  if (stripped !== null) {
    writeFileSync(mcpPath, stripped);
    removed.push(".mcp.json (leina MCP server unregistered)");
  }
  const settingsPath = join(project, ".claude", "settings.json");
  const revoked = revokeMcpPermission(readIfExists(settingsPath));
  if (revoked !== null) {
    writeFileSync(settingsPath, revoked);
    removed.push(".claude/settings.json (mcp__leina grant revoked)");
  }
}

// 6. .claude/settings.json: strip managed agent-hook entries (other hooks preserved).
function deinitClaudeHooks(project: string, removed: string[]): void {
  const settingsPath = join(project, ".claude", "settings.json");
  const stripped = removeClaudeHooks(readIfExists(settingsPath));
  if (stripped !== null) {
    writeFileSync(settingsPath, stripped);
    removed.push(".claude/settings.json (agent-hook entries removed)");
  }
}

// Evidence that this repo was ever initialized. repair must never install something the
// user never asked for, so wiring is only re-written when at least one trace of a previous
// init exists: the consent flag, hook wiring for any host, or the AGENTS.md protocol block.
function hasInitEvidence(project: string): boolean {
  if (existsSync(join(project, ".leina", "consent"))) return true;
  if (hasHookWiring(project)) return true;
  const agents = readIfExists(join(project, "AGENTS.md"));
  return agents?.includes("leina:protocol:start") ?? false;
}

// PROJECT phase of repair: re-wire only over a previous init, never against an opt-out.
function repairProjectPhase(project: string): void {
  const consent = readConsentFlag(project);
  if (consent === "disabled") {
    console.log(`project: consent=disabled — skipped (deinit opt-out respected; 'leina init' re-enables)`);
    return;
  }
  if (!hasInitEvidence(project)) {
    console.log(`project: not initialized — skipped (run 'leina init ${project}' to opt in)`);
    return;
  }
  const cliBase = deriveCliCommand({
    cliEntry: resolvePath(process.argv[1] ?? "."),
    execPath: process.execPath,
  });
  // Preserve the original profile: the capabilities section marks a Windsurf init.
  const agents = readIfExists(join(project, "AGENTS.md"));
  const profile = agents?.includes("leina:capabilities:start") ? WINDSURF_PROFILE : DEVIN_PROFILE;
  const written: string[] = [];
  const failures: string[] = [];
  // Same host resolution as init (persisted selection, else detection) — repair re-wires
  // the hosts the user currently targets, never a host they deactivated.
  const mode = writeInitArtifacts(project, profile, cliBase, resolveInitHosts(undefined), written, failures);
  console.log(`project [${mode.toUpperCase()}] re-wired:`);
  for (const w of written) console.log(`  + ${w}`);
  for (const f of failures) console.log(`  ✖ ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

// Git Bash shim FIX (opt-in): --write-shell-wrapper writes the ~/.bashrc wrapper that
// the shell-interop advisory otherwise only suggests. Explicit flag = explicit consent.
function maybeWriteShellWrapper(): void {
  if (process.platform !== "win32") {
    console.log("shell wrapper: only relevant on Windows Git Bash — skipped");
    return;
  }
  try {
    const bashrc = join(userHome(), ".bashrc");
    const merged = mergeShellWrapper(readIfExists(bashrc), resolvePath(process.argv[1] ?? "."));
    if (merged === null) {
      console.log(`shell wrapper: already present in ${bashrc}`);
    } else {
      writeFileSync(bashrc, merged);
      console.log(`+ ${bashrc} (leina() wrapper — restart Git Bash to pick it up)`);
    }
  } catch (err) {
    console.log(`  ✖ shell wrapper: ${errMsg(err)}`);
    process.exitCode = 1;
  }
}

export function handleRepair(rest: string[]): void {
  // leina repair [<dir> | --project <dir>] [--no-user-hooks] [--write-shell-wrapper]
  //
  // The write-side counterpart of the read-only `doctor`: re-runs the idempotent install
  // writers, scoped strictly by evidence of a previous install —
  //   GLOBAL  (share + symlinks + user-global grant/hooks): only when activation evidence
  //           exists (share populated or blanket sentinel). Never a first-time install.
  //   PROJECT (AGENTS.md/.gitignore/.devin wiring/consent): only when init evidence exists
  //           AND consent != disabled — a deinit opt-out is always respected.
  // Never touches graph.db / memory.db (advisory only). Ends by re-running doctor;
  // remaining failures (e.g. Node version) are listed and drive a non-zero exit.
  const positional = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  const project = resolvePath(optFlag(rest, "--project", undefined) ?? positional ?? ".");

  console.log(`leina repair — ${project}\n`);

  // GLOBAL: re-activate only over a previous activation.
  if (isGlobalActivated() || isBlanketActive()) {
    activateFromArgs("repair", rest);
  } else {
    console.log(`global: never activated — skipped (run 'leina activate' to opt in)`);
  }

  repairProjectPhase(project);

  if (hasFlag(rest, "--write-shell-wrapper")) maybeWriteShellWrapper();

  // DBs are never repaired; surface the one known DB-adjacent remedy instead.
  if (existsSync(join(project, ".leina", "memory.db"))) {
    console.log(
      `note: legacy per-repo memory.db detected — run 'leina memory migrate ${project}' (repair never touches DBs)`,
    );
  }

  // Post-repair verification with the same read-only checks the user would run next.
  const after = runDoctor(readPackageVersion(), project);
  const fails = after.results.filter((r) => r.status === "fail");
  if (fails.length === 0) {
    console.log(`\nrepair done — doctor reports no failing checks.`);
  } else {
    console.log(`\nrepair done — ${fails.length} check(s) still failing (not auto-fixable by repair):`);
    for (const f of fails) console.log(`  ✖ ${f.label}${f.detail ? `: ${f.detail}` : ""}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// PR4: deactivate + deinit (global teardown + per-repo teardown)
// ---------------------------------------------------------------------------

/**
 * Shared helper: derive cliBase and call `runDeactivate`. Used by both `handleDeactivate`
 * and `handleDisable` so the teardown logic lives in one place (activate.ts).
 */
function deactivateFromArgs(label: string): void {
  const cliBase = deriveCliCommand({
    cliEntry: resolvePath(process.argv[1] ?? "."),
    execPath: process.execPath,
  });
  try {
    runDeactivate({ cliBase });
  } catch (err) {
    fail(`${label}: ${errMsg(err)}`);
  }
  // User-global MCP registrations: removed unconditionally (merge-safe — only the leina
  // entry is stripped; a machine that never registered gets all-"unchanged" no-ops).
  const results = unregisterMcpGlobal().filter((r) => r.action !== "unchanged");
  if (results.length > 0) {
    console.log(`${label} — user-global MCP registration removal:`);
    printMcpResults(results);
  }
}

/**
 * `leina deactivate`
 *
 * Global teardown (inverse of `activate`). Does NOT touch `blanketFile()`. Idempotent. [T1]
 *   - Removes managed host symlinks (skills/agents in Devin's global dirs).
 *   - Revokes the user-global Exec(leina) permission grant.
 *   - Removes managed hooks entries from user-global `~/.config/devin/config.json`.
 *
 * Leaves the blanket sentinel as-is — use `disable` if you also want to turn blanket off.
 */
export function handleDeactivate(_rest: string[]): void {
  deactivateFromArgs("deactivate");
}

/**
 * `leina deinit [--project <path>]`
 *
 * Per-repo inverse of `init`. Idempotent. [T3, D3]
 *
 * Operations (strip-inverso by marker, never by .bak):
 *   1. Set consent flag to "disabled" (only if currently "enabled").
 *   2. `removeAgentsMdBlock` — strip the managed protocol block from AGENTS.md (if present).
 *   3. `removeGitignoreBlock` — strip the managed ignore block from .gitignore (if present).
 *   4. `revokeCliExecPermission` — strip the local Exec grant from .devin/config.json (if any).
 *   5. Remove .devin/hooks.v1.json (FULL-mode file; absent in LIGHT init — no error).
 *
 * When nothing needed reverting: prints "nothing to revert" and exits 0 (OQ-2).
 * Does NOT touch `~/.config/devin/config.json` (user-global) — that is `deactivate`'s scope.
 */
// 1. Consent flag → disabled (only if currently "enabled"; "unknown" = never init'd → skip).
function deinitConsent(project: string, written: string[]): void {
  const prevConsent = readConsentFlag(project);
  if (prevConsent === "enabled") {
    writeConsentFlag(project, "disabled");
    written.push(".leina/consent (enabled → disabled)");
  }
}

// 2. AGENTS.md: strip managed protocol block (if any). User content is preserved. [T3, D3]
//    Note: removeAgentsMdBlock returns null both when the block is absent AND when stripping
//    it leaves whitespace-only content. We distinguish by checking if the marker was present.
function deinitAgentsMd(project: string, removed: string[]): void {
  const agentsPath = join(project, "AGENTS.md");
  const existingAgents = readIfExists(agentsPath);
  if (existingAgents === null) return;
  const strippedAgents = removeAgentsMdBlock(existingAgents);
  // "# AGENTS.md" is the scaffold heading mergeAgentsMd writes when it CREATES the file,
  // so a strip that leaves only the heading also means every byte was ours.
  const onlyScaffoldLeft = strippedAgents !== null && strippedAgents.trim() === "# AGENTS.md";
  if (strippedAgents !== null && !onlyScaffoldLeft) {
    writeFileSync(agentsPath, strippedAgents);
    removed.push("AGENTS.md (protocol block)");
  } else if (existingAgents.includes("leina:protocol:start")) {
    // Stripping the block left nothing (or only our scaffold heading): the file only ever
    // held our content, so remove it instead of leaving a husk behind.
    rmSync(agentsPath, { force: true });
    removed.push("AGENTS.md (file removed — contained only the leina block)");
  }
}

// 3. .gitignore: strip managed ignore block (if any). User content is preserved. [T3, D3]
//    Same null-ambiguity as removeAgentsMdBlock: null = absent OR result-empty-after-strip.
function deinitGitignore(project: string, removed: string[]): void {
  const gitignorePath = join(project, ".gitignore");
  const existingGitignore = readIfExists(gitignorePath);
  if (existingGitignore === null) return;
  const strippedGitignore = removeGitignoreBlock(existingGitignore);
  if (strippedGitignore !== null) {
    writeFileSync(gitignorePath, strippedGitignore);
    removed.push(".gitignore (leina block)");
  } else if (existingGitignore.includes("leina:ignore:start")) {
    // Block was present and stripping it left nothing: the file only ever held our
    // content, so remove the file instead of leaving a confusing 0-byte .gitignore.
    rmSync(gitignorePath, { force: true });
    removed.push(".gitignore (file removed — contained only the leina block)");
  }
}

// 4. .devin/config.json: revoke local Exec(leina) grant (if any). [T3, D3]
function deinitDevinConfig(project: string, removed: string[]): void {
  const devinCfgPath = join(project, ".devin", "config.json");
  const existingDevinCfg = readIfExists(devinCfgPath);
  const revokedDevinCfg = revokeCliExecPermission(existingDevinCfg);
  if (revokedDevinCfg !== null) {
    writeFileSync(devinCfgPath, revokedDevinCfg);
    removed.push(".devin/config.json (Exec grant revoked)");
  }
}

// 5. .devin/hooks.v1.json: remove managed file (FULL-mode only; MUST NOT error if absent). [T3]
function deinitHooks(project: string, removed: string[]): void {
  const hooksPath = join(project, ".devin", "hooks.v1.json");
  if (existsSync(hooksPath)) {
    rmSync(hooksPath);
    removed.push(".devin/hooks.v1.json");
  }
}

export function handleDeinit(rest: string[]): void {
  const projectArg = optFlag(rest, "--project", undefined);
  const project = projectArg ? resolvePath(projectArg) : resolvePath(process.cwd());

  const written: string[] = [];
  const removed: string[] = [];

  deinitConsent(project, written);
  deinitAgentsMd(project, removed);
  deinitGitignore(project, removed);
  deinitDevinConfig(project, removed);
  deinitHooks(project, removed);
  deinitMcpRegistration(project, removed);
  deinitClaudeHooks(project, removed);

  // Report: "nothing to revert" when no changes were needed (idempotent second run). [OQ-2]
  if (written.length === 0 && removed.length === 0) {
    console.log(`leina deinit — nothing to revert.`);
    return;
  }

  console.log(`leina deinit — cleaned up from ${project}:`);
  for (const w of written) console.log(`  + ${w}`);
  for (const r of removed) console.log(`  - ${r}`);
}
