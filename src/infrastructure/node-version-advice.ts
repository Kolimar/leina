// node-version-advice.ts — Pure detection of the active Node version manager and
// builder of the LIKE-mode degradation warning emitted by memOpenGuarded.
//
// DESIGN CONSTRAINTS (from sdd/fts5-like-fallback/design):
//   - No exec() calls — detection is purely env-var + existsSync.
//   - Cross-platform: env-var check works on Windows too (existsSync paths are POSIX hints).
//   - targetMajor is passed in so the advice is not hard-coded to any specific version.
//
// Following the pattern of share-paths.ts (pure functions, no I/O side effects).

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The detected Node version manager. "none" means no manager was found. */
export type NodeManager = "fnm" | "nvm" | "asdf" | "volta" | "none";

export interface NodeVersionAdvice {
  /** The detected manager (or "none" when no manager is found). */
  manager: NodeManager;
  /** Exact command to switch to the target Node major version. */
  switchCommand: string;
  /**
   * Absolute path to a `.nvmrc` or `.node-version` pin file found in `cwd`,
   * if one exists. Informational — the warning includes it so the user knows
   * why an old version was loaded.
   */
  pinnedFile?: string;
}

// ---------------------------------------------------------------------------
// Detection helpers (pure — only env + existsSync, never exec)
// ---------------------------------------------------------------------------

function detectManager(env: NodeJS.ProcessEnv): NodeManager {
  // Priority order: fnm → nvm → asdf → volta.
  // Prefer env vars (fastest, most reliable) then filesystem fallbacks.
  return detectManagerFromEnv(env) ?? detectManagerFromFilesystem(env) ?? "none";
}

// Env-var detection (fastest, most reliable). Returns null when no manager env is set.
function detectManagerFromEnv(env: NodeJS.ProcessEnv): NodeManager | null {
  if (env.FNM_DIR || env.FNM_MULTISHELL_PATH) return "fnm"; // fnm
  if (env.NVM_DIR) return "nvm"; // nvm
  if (env.ASDF_DIR || env.ASDF_DATA_DIR) return "asdf"; // asdf
  if (env.VOLTA_HOME) return "volta"; // volta
  return null;
}

// Filesystem fallbacks (env not set, but the tool may still be installed).
// Use the HOME from the injected env so tests can control which paths are checked.
function detectManagerFromFilesystem(env: NodeJS.ProcessEnv): NodeManager | null {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  if (!home) return null;
  // [home-relative path segments, manager]. fnm binary locations vary; check a
  // common home-relative path for it.
  const probes: [string[], NodeManager][] = [
    [[".nvm", "nvm.sh"], "nvm"],
    [[".asdf", "bin", "asdf"], "asdf"],
    [[".volta", "bin", "volta"], "volta"],
    [[".local", "share", "fnm"], "fnm"],
  ];
  for (const [segments, manager] of probes) {
    if (existsSync(join(home, ...segments))) return manager;
  }
  return null;
}

function buildSwitchCommand(manager: NodeManager, targetMajor: number): string {
  switch (manager) {
    case "fnm":
      return `fnm install ${targetMajor} && fnm use ${targetMajor}`;
    case "nvm":
      return `nvm install ${targetMajor} && nvm use ${targetMajor}`;
    case "asdf":
      return `asdf install nodejs ${targetMajor} && asdf set nodejs ${targetMajor}`;
    case "volta":
      return `volta install node@${targetMajor}`;
    case "none":
      return `Download Node ${targetMajor}+ from https://nodejs.org`;
  }
}

function findPinnedFile(cwd: string): string | undefined {
  for (const name of [".nvmrc", ".node-version"]) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the active Node version manager and build upgrade advice.
 *
 * @param cwd - Working directory to check for .nvmrc / .node-version pin files.
 * @param targetMajor - The target Node major version to recommend.
 */
export function detectNodeVersionAdvice(cwd: string, targetMajor: number): NodeVersionAdvice {
  return detectNodeVersionAdviceFromEnv(process.env, cwd, targetMajor);
}

/**
 * Injectable variant used by unit tests to mock `process.env`.
 * @internal
 */
export function detectNodeVersionAdviceFromEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
  targetMajor: number,
): NodeVersionAdvice {
  const manager = detectManager(env);
  const switchCommand = buildSwitchCommand(manager, targetMajor);
  const pinnedFile = findPinnedFile(cwd);
  return pinnedFile ? { manager, switchCommand, pinnedFile } : { manager, switchCommand };
}

/**
 * Build the multi-line LIKE-mode degradation warning written to stderr by
 * `memOpenGuarded` whenever a memory command runs without FTS5.
 *
 * Format mirrors the design spec:
 *   ⚠ leina: Node <ver> sin SQLite FTS5 — la búsqueda de memoria corre en modo degradado
 *     (LIKE): sin stemming porter ni ranking BM25, solo coincidencia de subcadena.
 *     Para full-text real, actualizá a Node <target>+:
 *     → <switchCommand>
 *     (.nvmrc detectado: <path>)   ← only when pinnedFile is set
 *     Diagnóstico completo: leina doctor
 */
export function buildLikeModeWarning(
  nodeVersion: string,
  advice: NodeVersionAdvice,
): string {
  const lines: string[] = [
    `⚠ leina: Node ${nodeVersion} without SQLite FTS5 — memory search is running in degraded mode`,
    `  (LIKE): no porter stemming or BM25 ranking, substring match only.`,
    `  For full-text search, upgrade to Node ${(/\d+/.exec(advice.switchCommand))?.[0] ?? "24"}+:`,
    `  → ${advice.switchCommand}`,
  ];
  if (advice.pinnedFile) {
    lines.push(`  (pin file detected: ${advice.pinnedFile})`);
  }
  lines.push(`  Full diagnosis: leina doctor`);
  return lines.join("\n");
}
