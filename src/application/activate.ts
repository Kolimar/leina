// application/activate.ts — Activate/Deactivate use-cases.
// Orchestrates the global activation pipeline: populate share directory, symlink into host
// dirs, write the user-global host config — the Devin config (Exec grant + hooks) and, for
// Claude Code, the managed hooks in ~/.claude/settings.json. Hooks follow the host
// selection: a selected host gets them (unless --no-user-hooks), any other host gets ours
// stripped. runDeactivate is the inverse — unlinkHosts + revokeCliExecPermission + strip
// the managed hooks from both files; it does NOT touch the blanket sentinel (that is
// handleDisable's sole responsibility).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpCommand } from "./install/protocol.ts";
import { installGlobal, unlinkHosts } from "../infrastructure/install/global.ts";
import type { Selection } from "./install/catalog.ts";
import {
  buildUserGlobalHooks,
  devinUserConfigWithHooks,
  removeUserGlobalHooks,
} from "./install/devin-hooks.ts";
import { claudeHooksJson, removeClaudeHooks } from "./install/claude-hooks.ts";
import { parseJsonRoot } from "./install/hooks-common.ts";
import { grantCliExecPermission, revokeCliExecPermission } from "./install/permissions.ts";
import { claudeUserSettingsFile, devinUserConfigFile } from "../infrastructure/install/share-paths.ts";

function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/**
 * Write `next` over a user-owned config file, copying the previous content to
 * `<file>.bak-<ISO>` first when the file existed and its content changes. A copy (not a
 * rename) so a dotfiles symlink keeps pointing where it did: the write goes through it.
 * A failed backup is reported, never silent. Returns the report lines.
 */
function writeWithBackup(file: string, existing: string | null, next: string, note: string): string[] {
  const out: string[] = [];
  if (existing !== null && existing !== next) {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const bak = `${file}.bak-${stamp}`;
    try {
      copyFileSync(file, bak);
      out.push(`${bak} (backup)`);
    } catch (err) {
      // Proceeding is safe — the writers are merge-safe and preserve third-party keys —
      // but a silently missing backup is not: surface it in the report.
      out.push(
        `warning: backup of ${file} failed (${err instanceof Error ? err.message : String(err)}); proceeding without backup`,
      );
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  out.push(`${file} (${note})`);
  return out;
}

/**
 * Write (or update) the user-global Devin config file (`~/.config/devin/config.json`,
 * or the platform-equivalent resolved by `devinUserConfigFile()`).
 *
 * PR4 unification: previously used `join(homedir(), ".config", "devin", "config.json")`
 * directly; now delegates to `devinUserConfigFile()` which honours $HOME / $USERPROFILE /
 * $APPDATA so test sandboxes redirect correctly on all platforms.
 */
export function writeUserGlobalConfig(opts: {
  cliBase: McpCommand;
  withHooks: boolean;
}): { written: string[]; removed: string[] } {
  const { cliBase, withHooks } = opts;
  // Unified path: devinUserConfigFile() honours $HOME/$USERPROFILE/$APPDATA (see share-paths.ts).
  const userCfgPath = devinUserConfigFile();
  const existing = readIfExists(userCfgPath);
  let next: string | null = existing;
  next = grantCliExecPermission(next) ?? next;
  // Hooks off (opted out, or Devin not selected): strip the managed entries an earlier
  // activation wrote, so the machine-wide wiring always matches the current choice.
  const stripped = withHooks ? null : removeUserGlobalHooks(next);
  next = withHooks ? devinUserConfigWithHooks(next, buildUserGlobalHooks(cliBase)) : (stripped ?? next);
  if (next === null || next === existing) return { written: [], removed: [] };
  const note = ["Exec(leina) pre-authorized", withHooks ? "merged hooks" : null, stripped !== null ? "managed hooks removed" : null]
    .filter(Boolean)
    .join(" + ");
  return { written: writeWithBackup(userCfgPath, existing, next, note), removed: [] };
}

/**
 * Merge (withHooks) or strip the managed `agent-hook --host claude --scope user` entries in
 * Claude Code's user settings (`~/.claude/settings.json`): fires in every project, quiet
 * wherever consent/trust are missing, and deferring to a project's own wiring. Merge-safe
 * (other hooks, permissions and keys are preserved) and idempotent. The file is created only
 * when hooks are wanted. A malformed file is never clobbered: merging into it throws so the
 * caller reports the step as failed.
 */
export function writeClaudeUserSettings(opts: { cliBase: McpCommand; withHooks: boolean }): string[] {
  const file = claudeUserSettingsFile();
  const existing = readIfExists(file);
  if (!opts.withHooks) {
    const stripped = removeClaudeHooks(existing);
    return stripped === null ? [] : writeWithBackup(file, existing, stripped, "managed Claude Code hooks removed");
  }
  if (parseJsonRoot(existing) === null) throw new Error("malformed JSON — left untouched");
  const merged = claudeHooksJson(opts.cliBase, existing, "user");
  return merged === null ? [] : writeWithBackup(file, existing, merged, "merged Claude Code hooks");
}

export interface ActivateOpts {
  assetsRoot: string;
  version: string;
  cliBase: McpCommand;
  userHooks: boolean;
  /** Asset selection; undefined keeps the persisted choice (or everything). */
  selection?: Selection;
}

export interface ActivateReport {
  ok: boolean;
  /** Human-readable description of each step that FAILED (empty when ok). */
  problems: string[];
}

export function runActivate(opts: ActivateOpts): ActivateReport {
  const { assetsRoot, version, cliBase, userHooks, selection } = opts;
  const problems: string[] = [];
  const report = installGlobal(assetsRoot, version, selection);
  console.log(`leina activate — share at ${report.shareRoot}`);
  console.log(
    `  ${report.populated ? "populated" : "up-to-date"} v${version} ` +
      `(${report.skillCount} skills, ${report.agentCount} agents, ${report.workflowCount} workflows)`,
  );
  if (report.staleLinksRemoved > 0) {
    console.log(`  - swept ${report.staleLinksRemoved} stale host link(s) (deselected assets)`);
  }
  const changed = report.hostLinks.filter((l) => l.result.action !== "unchanged");
  if (changed.length === 0) {
    console.log("  hosts: all symlinks already in place");
  } else {
    for (const link of changed) {
      console.log(`  + ${link.host}/${link.kind}/${link.name}: ${link.result.action} → ${link.result.path}`);
      if (link.result.backup) console.log(`      backup: ${link.result.backup}`);
    }
  }
  let upToDate = true;
  try {
    const ucResult = writeUserGlobalConfig({ cliBase, withHooks: userHooks && report.hosts.includes("devin") });
    for (const w of ucResult.written) console.log(`  + ${w}`);
    for (const r of ucResult.removed) console.log(`  - ${r}`);
    upToDate = ucResult.written.length === 0 && ucResult.removed.length === 0;
  } catch (err) {
    // A failure here means the machine-wide Exec grant and/or hooks were NOT installed —
    // the agent WILL hit permission prompts. Report it as a failure, not a "skipped".
    const msg = err instanceof Error ? err.message : String(err);
    problems.push(
      `user-global config (${devinUserConfigFile()}): ${msg} — grant/hooks NOT installed; ` +
        `fix the file (often malformed JSON) and re-run 'leina activate'`,
    );
  }
  try {
    const lines = writeClaudeUserSettings({ cliBase, withHooks: userHooks && report.hosts.includes("claude") });
    for (const w of lines) console.log(`  + ${w}`);
    upToDate &&= lines.length === 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    problems.push(
      `Claude Code user settings (${claudeUserSettingsFile()}): ${msg} — hooks NOT installed; ` +
        `fix the file and re-run 'leina activate'`,
    );
  }
  if (upToDate && problems.length === 0) console.log("  user-global config: already up-to-date");
  return { ok: problems.length === 0, problems };
}

/**
 * `runDeactivate` — inverse of `runActivate`. [T1, D3]
 *
 * Removes managed host symlinks, revokes the CLI Exec permission grant, and strips the
 * managed hook entries from the user-global Devin config (`devinUserConfigFile()`) and
 * from Claude Code's user settings (`claudeUserSettingsFile()`).
 *
 * MUST NOT touch `blanketFile()` — that sentinel is `handleDisable`'s sole responsibility.
 * Idempotent: all three operations are no-ops when there is nothing to remove.
 *
 * The `cliBase` parameter is kept for API symmetry with `runActivate` and to allow
 * future extensibility; it is not used in the teardown path.
 */
export function runDeactivate(_opts: { cliBase: McpCommand }): void {
  // 1. Remove managed host symlinks (skills/agents in Devin's global dirs).
  const hostLinks = unlinkHosts();
  const unlinked = hostLinks.filter((l) => l.result.action === "unlinked");

  // 2. Strip CLI Exec grant + managed hook entries from user-global config.
  //    Both writers are pure and return null when there is nothing to remove (idempotent).
  const userCfgPath = devinUserConfigFile();
  const existing = readIfExists(userCfgPath);
  let current: string | null = existing;

  const afterRevoke = revokeCliExecPermission(current);
  if (afterRevoke !== null) current = afterRevoke;

  const afterHooks = removeUserGlobalHooks(current);
  if (afterHooks !== null) current = afterHooks;

  const configChanged = current !== null && current !== existing;
  if (configChanged) {
    mkdirSync(dirname(userCfgPath), { recursive: true });
    writeFileSync(userCfgPath, current!);
  }

  // 3. Strip the managed hooks from Claude Code's user settings (other keys untouched).
  const claudeFile = claudeUserSettingsFile();
  const claudeBefore = readIfExists(claudeFile);
  const claudeAfter = removeClaudeHooks(claudeBefore);
  if (claudeAfter !== null) writeFileSync(claudeFile, claudeAfter);

  // Print report.
  console.log(`leina deactivate — global teardown.`);
  if (unlinked.length > 0) {
    for (const l of unlinked) {
      console.log(`  - ${l.host}/${l.kind}/${l.name}: removed`);
    }
  } else {
    console.log(`  hosts: no managed symlinks to remove (already clean)`);
  }
  if (configChanged) console.log(`  - ${userCfgPath} (Exec grant + hooks removed)`);
  if (claudeAfter !== null) console.log(`  - ${claudeFile} (Claude Code hooks removed)`);
  if (!configChanged && claudeAfter === null) console.log(`  user-global config: already clean`);
}
