// cli/handlers/tui.ts — `leina tui`: interactive install/maintenance console.
//
// A thin PRESENTATION layer, by design: every action dispatches to the same functions the
// flag-based commands use (handleSetup/handleActivate/handleRepair/… and the env store),
// so the TUI can never drift from the CLI's behaviour. It only adds menus on top.
//
// Requires a real interactive terminal on stdin+stdout; otherwise it fails with the
// non-interactive equivalents. The env "set" flow uses a password-style prompt, keeping
// the names-not-values contract (see handlers/env.ts).

import * as p from "@clack/prompts";
import { writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { readPackageVersion } from "../../version.ts";
import { runDoctor } from "../doctor.ts";
import { fail, readIfExists } from "../io.ts";
import {
  entryAssetsRoot,
  isBlanketActive,
  isGlobalActivated,
} from "../../infrastructure/install/global.ts";
import { DEFAULT_HOSTS, HOSTS, shareSelectionFile } from "../../infrastructure/install/share-paths.ts";
import {
  deserializeSelection,
  parseCatalog,
  resolveSelection,
  type Catalog,
} from "../../application/install/catalog.ts";
import { readConsentFlag } from "../../application/install/consent.ts";
import { addMcpRegistration, hasMcpRegistration, removeMcpRegistration } from "../../application/install/mcp-config.ts";
import { inspectMcpGlobal } from "../../infrastructure/install/mcp-hosts.ts";
import {
  ENV_KEY_RE,
  maskValue,
  parseEnvFile,
  removeEnvVar,
  upsertEnvVar,
} from "../../application/env/store.ts";
import { envFilePath, readEnvFile, writeEnvFile } from "../../infrastructure/env/env-file.ts";
import {
  handleActivate,
  handleDeactivate,
  handleDeinit,
  handleDisable,
  handleInit,
  handleRepair,
  handleSetup,
  hasHookWiring,
} from "./install.ts";


function loadCatalog(): Catalog | null {
  const raw = readIfExists(join(entryAssetsRoot(), "catalog.json"));
  try {
    return raw === null ? null : parseCatalog(raw);
  } catch {
    return null;
  }
}

function bail(value: unknown): boolean {
  if (p.isCancel(value)) {
    p.cancel("back");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function showStatus(project: string): void {
  const report = runDoctor(readPackageVersion(), project);
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const r of report.results) counts[r.status]++;
  const problems = report.results.filter((r) => r.status !== "ok");
  const lines = [
    `checks: ${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail`,
    ...problems.map((r) => `${r.status === "fail" ? "✖" : "⚠"} ${r.group}/${r.label}: ${r.detail ?? ""}`),
  ];
  p.note(lines.join("\n"), `doctor — ${project}`);
}

// ---------------------------------------------------------------------------
// Install / update (group multiselect → activate or setup)
// ---------------------------------------------------------------------------

async function installFlow(catalog: Catalog | null): Promise<void> {
  if (catalog === null) {
    p.log.error("bundled catalog.json missing — falling back to full install");
  }

  let flags: string[] = [];
  if (catalog !== null) {
    const groupIds = Object.keys(catalog.groups);
    // Preselect the groups implied by the persisted selection (all groups when full).
    const persisted = deserializeSelection(readIfExists(shareSelectionFile()));
    const active =
      persisted === null || (persisted.skills === null && persisted.agents === null)
        ? groupIds
        : groupIds.filter((gid) =>
            catalog.assets.some(
              (a) =>
                a.group === gid &&
                (a.kind === "skill"
                  ? persisted.skills === null || persisted.skills.includes(a.id)
                  : persisted.agents === null || persisted.agents.includes(a.id)),
            ),
          );

    const chosen = await p.multiselect({
      message: "Which asset groups should be installed? (core is always included)",
      options: groupIds.map((gid) => ({
        value: gid,
        label: gid,
        hint: catalog.groups[gid],
      })),
      initialValues: active,
      required: false,
    });
    if (bail(chosen)) return;

    const groups = [...new Set(["core", ...(chosen as string[])])];
    if (groups.length !== groupIds.length) {
      const inGroups = catalog.assets.filter((a) => groups.includes(a.group));
      const skills = inGroups.filter((a) => a.kind === "skill").map((a) => a.id);
      const agents = inGroups.filter((a) => a.kind === "agent").map((a) => a.id);
      flags = [
        "--skills", skills.length > 0 ? skills.join(",") : "none",
        "--agents", agents.length > 0 ? agents.join(",") : "none",
      ];
      // Validate the composed selection now, so a catalog problem surfaces as a message
      // in the TUI instead of an exit inside the handler.
      resolveSelection(catalog, { skills: skills.length > 0 ? skills : ["none"], agents: agents.length > 0 ? agents : ["none"] });
    } else {
      flags = ["--preset", "full"];
    }
  }

  // Which AI hosts to link into.
  const persistedHosts =
    deserializeSelection(readIfExists(shareSelectionFile()))?.hosts ?? [...DEFAULT_HOSTS];
  const hosts = await p.multiselect({
    message: "Link the assets into which AI hosts?",
    options: HOSTS.map((h) => ({ value: h.id, label: h.label, hint: h.skillsRoot() })),
    initialValues: persistedHosts.filter((h) => HOSTS.some((spec) => spec.id === h)),
    required: true,
  });
  if (bail(hosts)) return;
  flags = [...flags, "--hosts", (hosts as string[]).join(",")];

  const blanket = await p.confirm({
    message: "Enable blanket mode too? (setup: every repo auto-wires with a one-time consent prompt)",
    initialValue: isBlanketActive(),
  });
  if (bail(blanket)) return;

  // User-global MCP registration: one server entry per host covers every project (the
  // tools resolve `root` at call time). Pre-checked when already registered somewhere.
  const mcp = await p.confirm({
    message: "Register the leina MCP server user-globally? (Claude Code / Cursor / Windsurf — tools available in every project)",
    initialValue: inspectMcpGlobal().some((s) => s.state === "registered"),
  });
  if (bail(mcp)) return;
  if (mcp === true) flags = [...flags, "--mcp"];

  console.log("");
  if (blanket === true) handleSetup(flags);
  else handleActivate(flags);
  console.log("");
}

// ---------------------------------------------------------------------------
// Current project (init / deinit)
// ---------------------------------------------------------------------------

async function projectFlow(project: string): Promise<void> {
  const consent = readConsentFlag(project);
  const wired = hasHookWiring(project) || consent === "enabled";
  const mcpPath = join(project, ".mcp.json");
  const mcpRegistered = hasMcpRegistration(readIfExists(mcpPath));
  const action = await p.select({
    message: `Project ${project} — consent: ${consent}${wired ? " (wired)" : ""}`,
    options: [
      { value: "init", label: "init — wire leina into this repo", hint: "adaptive LIGHT/FULL" },
      { value: "deinit", label: "deinit — opt this repo out", hint: "consent=disabled + strip wiring" },
      {
        value: "mcp",
        label: mcpRegistered
          ? ".mcp.json — remove project MCP registration"
          : ".mcp.json — register MCP server in this project",
        hint: "committable, for teams (user-global registration covers solo use)",
      },
      { value: "back", label: "back" },
    ],
  });
  if (bail(action) || action === "back") return;
  console.log("");
  if (action === "init") await handleInit(["--project", project]);
  else if (action === "deinit") handleDeinit(["--project", project]);
  else toggleProjectMcp(project, mcpPath, mcpRegistered);
  console.log("");
}

// Toggle the project-level `.mcp.json` registration in place (merge-safe writers — other
// servers and unknown keys survive; malformed JSON is never clobbered).
function toggleProjectMcp(project: string, mcpPath: string, registered: boolean): void {
  const existing = readIfExists(mcpPath);
  const next = registered ? removeMcpRegistration(existing) : addMcpRegistration(existing);
  if (next === null) {
    p.log.error(`${mcpPath}: nothing to change (malformed JSON is never touched — fix it and retry)`);
    return;
  }
  writeFileSync(mcpPath, next);
  p.log.success(registered ? "leina entry removed from .mcp.json" : "leina MCP server registered in .mcp.json");
}

// ---------------------------------------------------------------------------
// Env store
// ---------------------------------------------------------------------------

async function envFlow(): Promise<void> {
  for (;;) {
    const entries = parseEnvFile(readEnvFile());
    const action = await p.select({
      message: `Env store — ${envFilePath()} (${entries.length} variable(s), values masked)`,
      options: [
        { value: "list", label: "list variables (masked)" },
        { value: "set", label: "set a variable", hint: "value via hidden prompt — never shown, never in argv" },
        { value: "unset", label: "remove a variable" },
        { value: "back", label: "back" },
      ],
    });
    if (bail(action) || action === "back") return;

    if (action === "list") {
      p.note(
        entries.length === 0 ? "(none)" : entries.map((e) => `${e.key}=${maskValue(e.value)}`).join("\n"),
        "variables",
      );
    } else if (action === "set") {
      const key = await p.text({
        message: "Variable name",
        placeholder: "MY_SERVICE_TOKEN",
        validate: (v) => (v !== undefined && ENV_KEY_RE.test(v) ? undefined : "letters/digits/_ only"),
      });
      if (bail(key)) continue;
      const value = await p.password({ message: `Value for ${key as string} (hidden)` });
      if (bail(value)) continue;
      writeEnvFile(upsertEnvVar(readEnvFile(), key as string, (value as string | undefined) ?? ""));
      p.log.success(`${key as string} saved (0600). Consume it with: leina env exec --only ${key as string} -- <cmd>`);
    } else if (action === "unset") {
      if (entries.length === 0) {
        p.log.warn("nothing to remove");
        continue;
      }
      const key = await p.select({
        message: "Remove which variable?",
        options: entries.map((e) => ({ value: e.key, label: `${e.key}=${maskValue(e.value)}` })),
      });
      if (bail(key)) continue;
      const next = removeEnvVar(readEnvFile(), key as string);
      if (next !== null) writeEnvFile(next);
      p.log.success(`${key as string} removed`);
    }
  }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

async function uninstallFlow(): Promise<void> {
  const action = await p.select({
    message: "Uninstall what?",
    options: [
      { value: "deactivate", label: "deactivate — remove global share links + grant/hooks", hint: "keeps blanket sentinel" },
      { value: "disable", label: "disable — full machine-wide teardown", hint: "deactivate + blanket OFF" },
      { value: "back", label: "back" },
    ],
  });
  if (bail(action) || action === "back") return;
  const sure = await p.confirm({ message: `Really run '${action as string}'?`, initialValue: false });
  if (bail(sure) || sure !== true) return;
  console.log("");
  if (action === "disable") handleDisable([]);
  else handleDeactivate([]);
  console.log("");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function handleTui(rest: string[]): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      "leina tui needs an interactive terminal.\n" +
        "Non-interactive equivalents: setup/activate [--preset|--skills|--agents], init, deinit,\n" +
        "repair, doctor, env <set|list|unset|exec>, deactivate, disable.",
    );
  }
  const positional = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  const project = resolvePath(positional ?? ".");
  const catalog = loadCatalog();

  p.intro(`leina v${readPackageVersion()} — interactive console`);

  for (;;) {
    const activated = isGlobalActivated();
    const blanket = isBlanketActive();
    const state = activated ? (blanket ? "installed + blanket" : "installed (no blanket)") : "not installed";

    const action = (await p.select({
      message: `Main menu   [global: ${state}]`,
      options: [
        { value: "status", label: "status — doctor health summary" },
        { value: "install", label: activated ? "update install — change asset selection" : "install — choose assets and activate" },
        { value: "project", label: "this project — init / deinit" },
        { value: "repair", label: "repair — re-run idempotent writers for broken state" },
        { value: "env", label: "env vars — credentials for skills (masked)" },
        { value: "uninstall", label: "uninstall — deactivate / disable" },
        { value: "exit", label: "exit" },
      ],
    }));

    if (p.isCancel(action) || action === "exit") {
      p.outro("bye");
      return;
    }
    if (action === "status") showStatus(project);
    else if (action === "install") await installFlow(catalog);
    else if (action === "project") await projectFlow(project);
    else if (action === "repair") {
      console.log("");
      handleRepair([project]);
      console.log("");
      process.exitCode = 0; // repair sets 1 on residual doctor failures; the TUI stays open
    } else if (action === "env") await envFlow();
    else if (action === "uninstall") await uninstallFlow();
  }
}
