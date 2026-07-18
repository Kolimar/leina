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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { readPackageVersion } from "../../version.ts";
import { runDoctor } from "../doctor.ts";
import { fail, readIfExists } from "../io.ts";
import { isStale, readManifest } from "../../application/graph/manifest.ts";
import { loadFreshnessConfig } from "../../infrastructure/config/freshness.ts";
import { loadServeConfig } from "../../infrastructure/config/serve.ts";
import {
  detectInstalledHosts,
  entryAssetsRoot,
  isBlanketActive,
  isGlobalActivated,
} from "../../infrastructure/install/global.ts";
import { HOSTS, shareSelectionFile } from "../../infrastructure/install/share-paths.ts";
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
import { createContract, findHarnessRepoRoot, makeHarnessPorts } from "./harness.ts";
import { endContract, loadContract, stateDir } from "../../application/harness/contract-io.ts";
import { harnessDir, loadConfig } from "../../application/harness/config-io.ts";
import { loadResolvedRules } from "../../application/harness/resolver.ts";
import { loadRecipes } from "../../application/harness/recipes.ts";
import { runVerify } from "../../application/harness/verify.ts";
import { runSync } from "../../application/harness/sync.ts";
import { type VerifyReport } from "../../application/harness/gates/report.ts";
import {
  computeEnabledOverrides,
  contractSummary,
  mergeRuleOverridesIntoConfig,
  recipeSuggestions,
  splitAdjustableRules,
  verifyReportLines,
} from "../../application/harness/tui-support.ts";


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

/** Clear the screen and re-print the intro banner — the anchor that keeps the main menu
 * pinned near the top instead of scrolling ever further down as options are chosen. Only
 * reached from handleTui, which already guaranteed an interactive TTY. */
function banner(version: string): void {
  console.clear();
  p.intro(`leina v${version} — interactive console`);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function showStatus(project: string): void {
  const report = runDoctor(readPackageVersion(), project);
  const counts = { ok: 0, info: 0, warn: 0, fail: 0 };
  for (const r of report.results) counts[r.status]++;
  // Only warn/fail are actionable — info (optional / not-applicable) is not a problem.
  const problems = report.results.filter((r) => r.status === "warn" || r.status === "fail");
  const lines = [
    `checks: ${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail · ${counts.info} info`,
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
  // Pre-select the user's persisted hosts, or — on a first run — the hosts actually
  // detected on this machine (a suggestion, NOT a decision: the multiselect is `required`,
  // so nothing is wired unless the user confirms). Never defaults to a fixed vendor.
  const persistedHosts =
    deserializeSelection(readIfExists(shareSelectionFile()))?.hosts ?? detectInstalledHosts();
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
// Graph serve — launch the read-only graph explorer for the current project
// ---------------------------------------------------------------------------

async function serveFlow(project: string): Promise<void> {
  // Guard BEFORE launching: handleServe opens through the freshness gate, which calls
  // fail() (process.exit) on a never-built or stale+refuse graph — that would kill the
  // whole TUI. Catch those cases here and stay in the menu with an actionable message.
  if (readManifest(project) === null) {
    p.log.error(`no graph built for ${project} — run build first (main menu is install/maintenance; use \`leina build\`).`);
    return;
  }
  const stale = isStale(project);
  if (stale.stale && loadFreshnessConfig(project) === "refuse") {
    p.log.error(`graph is stale (${stale.reason}) and freshness posture is "refuse" — run \`leina refresh\` first.`);
    return;
  }

  const config = loadServeConfig(project);
  const portRaw = await p.text({
    message: "Port for the graph explorer",
    initialValue: String(config.port),
    // Validate here so an out-of-range port surfaces as a re-prompt, never as handleServe's
    // fail() (which would exit the process and take the TUI with it).
    validate: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n <= 65535 ? undefined : "port must be an integer in [0, 65535]";
    },
  });
  if (bail(portRaw)) return;

  p.note(
    `Read-only graph explorer for\n${project}\n\n` +
      `Runs in the foreground — press Ctrl+C to stop it and return to this menu.`,
    "graph serve",
  );
  console.log("");
  // Lazy import: node:http + the cli/serve/* transport must not tax TUI startup, same as
  // the top-level `graph serve` dispatch in main.ts. handleServe returns cleanly on SIGINT.
  const { handleServe } = await import("./serve.ts");
  await handleServe([project, "--port", portRaw as string]);
  console.log("");
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
// Harness — armar arnés para la tarea en curso (contrato + reglas + gates).
// Misma filosofía que el resto del TUI: capa fina que re-despacha a las mismas
// funciones de application/harness y handlers/harness.ts que usa el CLI.
// ---------------------------------------------------------------------------

async function harnessFlow(project: string): Promise<void> {
  const root = findHarnessRepoRoot(project);
  for (;;) {
    const action = await p.select({
      message: `Harness — ${root}`,
      options: [
        { value: "arm", label: "armar arnés para una feature", hint: "entrevista guiada → contrato + reglas" },
        { value: "status", label: "ver estado del arnés", hint: "contrato activo + último verify" },
        { value: "verify", label: "verificar ahora", hint: "corre los gates (leina harness verify)" },
        { value: "sync", label: "sincronizar plataformas (sync)", hint: "regenera artefactos desde las reglas" },
        { value: "back", label: "volver" },
      ],
    });
    if (bail(action) || action === "back") return;
    if (action === "arm") await harnessArmFlow(root);
    else if (action === "status") await harnessStatusFlow(root);
    else if (action === "verify") await harnessVerifyFlow(root);
    else if (action === "sync") await harnessSyncFlow(root);
  }
}

/** Globs/criterios uno a uno hasta línea vacía; sugerencias de receta confirmables. */
async function collectRepeatable(
  message: string,
  placeholder: string,
  suggested: string[],
  min: number,
): Promise<string[] | null> {
  const items: string[] = [];
  if (suggested.length > 0) {
    const kept = await p.multiselect({
      message: `${message} — sugeridos por la receta (confirma o descarta)`,
      options: suggested.map((v) => ({ value: v, label: v })),
      initialValues: suggested,
      required: false,
    });
    if (bail(kept)) return null;
    items.push(...(kept as string[]));
  }
  for (;;) {
    const value = await p.text({
      message: `${message} (línea vacía para terminar${min > 0 ? `; mínimo ${min}` : ""})`,
      placeholder,
    });
    if (bail(value)) return null;
    const text = ((value as string | undefined) ?? "").trim();
    if (text.length === 0) {
      if (items.length >= min) return items;
      p.log.warn(`hace falta al menos ${min} entrada(s)`);
      continue;
    }
    if (!items.includes(text)) items.push(text);
  }
}

// a. Contrato activo: nunca pisarlo sin confirmación explícita.
// true = se puede continuar armando uno nuevo; false = volver al menú.
async function confirmNoActiveContract(root: string): Promise<boolean> {
  const { contract: active, error } = await loadContract(root);
  if (error) {
    p.log.error(error);
    return false;
  }
  if (!active) return true;

  p.note(contractSummary(active), "contrato activo");
  const decision = await p.select({
    message: "Ya hay un contrato activo — ¿qué hacemos?",
    options: [
      { value: "keep", label: "continuar con él", hint: "no se toca nada" },
      { value: "end", label: "cerrarlo y archivar", hint: "contract end; después se arma uno nuevo" },
      { value: "cancel", label: "cancelar" },
    ],
  });
  if (bail(decision) || decision === "cancel") return false;
  if (decision === "keep") {
    p.log.info("sigue trabajando dentro del scope; cierra con `leina harness verify` + `leina harness contract end`");
    return false;
  }
  const ended = await endContract(root);
  if (!ended.ok) {
    p.log.error(ended.error);
    return false;
  }
  p.log.success(`contrato archivado en ${ended.archivedTo}`);
  return true;
}

interface HarnessInterview {
  goal: string;
  taskType: string;
  scope: string[];
  outOfScope: string[];
  criteria: string[];
}

// b+c. Entrevista guiada (harness/contract-interview hecha interfaz) con
// recetas del taskType que precargan scope/criterios sugeridos.
async function harnessInterview(root: string): Promise<HarnessInterview | null> {
  const goal = await p.text({
    message: "Goal — una frase: ¿qué significa «hecho»?",
    placeholder: "p.ej. Añadir listado de usuarios con paginación",
    validate: (v) => (v !== undefined && v.trim().length > 0 ? undefined : "el goal es obligatorio"),
  });
  if (bail(goal)) return null;

  const { config } = await loadConfig(root);
  const taskType = await p.select({
    message: "Tipo de tarea",
    options: config.taskTypes.map((t) => ({ value: t, label: t })),
  });
  if (bail(taskType)) return null;

  let suggestedScope: string[] = [];
  let suggestedCriteria: string[] = [];
  const { recipes } = await loadRecipes(root);
  const matching = recipes.filter((r) => r.taskType === taskType);
  if (matching.length > 0) {
    const recipeName = await p.select({
      message: "¿Aplicar una receta? (precarga scope y criterios sugeridos)",
      options: [
        { value: "", label: "ninguna" },
        ...matching.map((r) => ({ value: r.name, label: r.name, hint: r.description })),
      ],
    });
    if (bail(recipeName)) return null;
    const recipe = matching.find((r) => r.name === recipeName);
    if (recipe) {
      const suggestions = recipeSuggestions(recipe.body);
      suggestedScope = suggestions.scope;
      suggestedCriteria = suggestions.criteria;
      p.log.info(`receta «${recipe.name}» — sigue sus pasos: ${recipe.sourcePath}`);
    }
  }

  const scope = await collectRepeatable("Scope — glob de archivos que la tarea puede tocar", "p.ej. src/auth/**", suggestedScope, 0);
  if (scope === null) return null;
  const outOfScope = await collectRepeatable("Fuera de scope — glob explícitamente prohibido (opcional)", "p.ej. docs/**", [], 0);
  if (outOfScope === null) return null;
  const criteria = await collectRepeatable("Criterio de aceptación — observable y verificable", "p.ej. el endpoint devuelve 200 con la forma esperada", suggestedCriteria, 1);
  if (criteria === null) return null;

  return { goal: goal as string, taskType: taskType as string, scope, outOfScope, criteria };
}

// d. Reglas: las blocking activas son fijas (la capa local no puede
// debilitarlas); el resto es ajustable y se persiste como override de
// `enabled` en .harness/config.json (capa proyecto). Devuelve los ids de las
// reglas que quedan activas, o null si el usuario cancela / el config está roto.
async function selectHarnessRules(root: string): Promise<string[] | null> {
  const resolution = await loadResolvedRules(root);
  for (const e of resolution.errors) p.log.error(e);
  const { fixed, adjustable } = splitAdjustableRules(resolution.rules);
  const activeRuleIds = fixed.map((r) => r.id);
  if (fixed.length > 0) {
    p.note(
      fixed.map((r) => `● ${r.id} (${r.phase} · blocking)`).join("\n"),
      "reglas fijas — blocking activas, no descartables",
    );
  }
  if (adjustable.length === 0) return activeRuleIds;

  const chosen = await p.multiselect({
    message: "Reglas ajustables — activa/desactiva para este repo",
    options: adjustable.map((r) => ({
      value: r.id,
      label: r.id,
      hint: `${r.phase} · ${r.severity}${r.enabled ? "" : " · off"}${r.summary ? ` — ${r.summary}` : ""}`,
    })),
    initialValues: adjustable.filter((r) => r.enabled).map((r) => r.id),
    required: false,
  });
  if (bail(chosen)) return null;
  const selected = chosen as string[];

  const overrides = computeEnabledOverrides(adjustable, selected);
  if (Object.keys(overrides).length > 0) {
    const configPath = join(harnessDir(root), "config.json");
    const next = mergeRuleOverridesIntoConfig(readIfExists(configPath), overrides);
    if (next === null) {
      p.log.error(`${configPath}: JSON malformado — no se toca; arréglalo y reintenta`);
      return null;
    }
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, next);
    p.log.success(`overrides de reglas guardados en ${configPath}`);
  }
  return [...activeRuleIds, ...selected];
}

// El flujo estrella: contrato activo → entrevista → reglas → resumen → contrato.
async function harnessArmFlow(root: string): Promise<void> {
  if (!(await confirmNoActiveContract(root))) return;

  const interview = await harnessInterview(root);
  if (interview === null) return;

  const activeRuleIds = await selectHarnessRules(root);
  if (activeRuleIds === null) return;

  // e. Resumen → confirmación → misma ruta de creación que `contract new`.
  const summaryLines = [
    `goal: ${interview.goal}`,
    `tipo: ${interview.taskType}`,
    `scope: ${interview.scope.length > 0 ? interview.scope.join(", ") : "(vacío — el gate de diff no restringe nada)"}`,
    ...(interview.outOfScope.length > 0 ? [`fuera de scope: ${interview.outOfScope.join(", ")}`] : []),
    "criterios:",
    ...interview.criteria.map((c) => `  [ ] ${c}`),
    "",
    `reglas activas (${activeRuleIds.length}):`,
    ...activeRuleIds.sort().map((id) => `  · ${id}`),
  ];
  p.note(summaryLines.join("\n"), "resumen del arnés");
  const sure = await p.confirm({ message: "¿Crear el contrato con este arnés?", initialValue: true });
  if (bail(sure) || sure !== true) return;

  const created = await createContract(root, {
    goal: interview.goal,
    taskType: interview.taskType,
    scope: interview.scope,
    outOfScope: interview.outOfScope,
    criteria: interview.criteria,
  });
  if (!created.ok) {
    p.log.error(created.error);
    return;
  }
  p.log.success("contrato creado");
  p.note(
    "siguiente paso: trabaja dentro del scope y cierra con `leina harness verify`\n(y `leina harness contract end` cuando esté en verde)",
    "harness",
  );
}

async function harnessStatusFlow(root: string): Promise<void> {
  const { contract, error } = await loadContract(root);
  if (error) p.log.error(error);
  p.note(contract ? contractSummary(contract) : "(ninguno)", "contrato activo");

  const raw = readIfExists(join(stateDir(root), "verify-report.json"));
  if (raw === null) {
    p.log.info("sin verify-report.json — aún no se ha ejecutado `leina harness verify`");
    return;
  }
  try {
    const report = JSON.parse(raw) as VerifyReport;
    p.note(verifyReportLines(report).join("\n"), "último verify");
  } catch {
    p.log.error("verify-report.json malformado — se regenera con `leina harness verify`");
  }
}

async function harnessVerifyFlow(root: string): Promise<void> {
  const spin = p.spinner();
  spin.start("ejecutando gates (harness verify)");
  const outcome = await runVerify(root, { ports: makeHarnessPorts() });
  spin.stop(
    outcome.exitCode === 0
      ? "verify en verde — todos los gates bloqueantes pasan"
      : outcome.exitCode === 1
        ? "verify en rojo — hay gates bloqueantes fallando"
        : "verify no pudo ejecutarse (error de configuración)",
  );
  for (const w of outcome.warnings) p.log.warn(w);
  for (const e of outcome.loadErrors) p.log.error(e);
  if (outcome.loadErrors.length === 0) p.note(verifyReportLines(outcome.report).join("\n"), "reporte por gate");
  // El exit code no mata el TUI: aquí solo se muestra el resultado.
}

async function harnessSyncFlow(root: string): Promise<void> {
  const spin = p.spinner();
  spin.start("sincronizando plataformas (harness sync)");
  const result = await runSync(root, {});
  spin.stop(result.exitCode === 0 ? "sync completado" : "sync con conflictos o errores");
  for (const w of result.warnings) p.log.warn(w);
  for (const e of result.errors) p.log.error(e);
  if (result.outcome) {
    const written = result.outcome.items.filter((i) => i.action === "created" || i.action === "updated").length;
    const skipped = result.outcome.items.filter((i) => i.action === "unchanged").length;
    p.note(
      [
        ...result.outcome.items.map((i) => `${i.action.padEnd(9)} ${i.path} [${i.adapter}/${i.kind}]`),
        "",
        `${written} escrito(s) · ${skipped} sin cambios · ${result.outcome.conflictCount} conflicto(s)/error(es)`,
      ].join("\n"),
      "harness sync",
    );
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
  const version = readPackageVersion();

  // Anchor the console: start from a clean screen with the banner at the top.
  banner(version);

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
        { value: "harness", label: "harness — armar arnés para la tarea en curso", hint: "contrato + reglas + gates" },
        { value: "serve", label: "graph serve — live read-only graph explorer", hint: "foreground; Ctrl+C returns here" },
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

    // Wipe the screen NOW — after the choice, before the action runs. The menu therefore
    // always renders on a fresh screen (never scrolling further down each pick), while the
    // selected action's output stays visible above the next menu until the next choice.
    banner(version);

    if (action === "status") showStatus(project);
    else if (action === "install") await installFlow(catalog);
    else if (action === "project") await projectFlow(project);
    else if (action === "harness") await harnessFlow(project);
    else if (action === "serve") await serveFlow(project);
    else if (action === "repair") {
      console.log("");
      handleRepair([project]);
      console.log("");
      process.exitCode = 0; // repair sets 1 on residual doctor failures; the TUI stays open
    } else if (action === "env") await envFlow();
    else if (action === "uninstall") await uninstallFlow();
  }
}
