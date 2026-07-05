// application/activate.ts — Activate/Deactivate use-cases.
// Orchestrates the global activation pipeline: populate share directory,
// symlink into host dirs, write user-global config. Extracted from cli/index.ts.
//
// PR4 changes:
//  - writeUserGlobalConfig: unified to use devinUserConfigFile() from share-paths.ts
//    instead of join(homedir(), ".config", "devin", "config.json"). Both resolve to the same
//    path on Linux/macOS, but devinUserConfigFile() also honours $HOME/$USERPROFILE/$APPDATA,
//    making it sandbox-safe in tests and more correct on Windows.
//  - runDeactivate: inverse of runActivate — unlinkHosts + revokeCliExecPermission +
//    removeUserGlobalHooks applied to the user-global config. Does NOT touch blanketFile()
//    (that is handleDisable's sole responsibility). [T1, D3]

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpCommand } from "./install/protocol.ts";
import { installGlobal, unlinkHosts } from "../infrastructure/install/global.ts";
import type { Selection } from "./install/catalog.ts";
import {
  buildUserGlobalHooks,
  devinUserConfigWithHooks,
  removeUserGlobalHooks,
} from "./install/devin-hooks.ts";
import { grantCliExecPermission, revokeCliExecPermission } from "./install/permissions.ts";
import { devinUserConfigFile } from "../infrastructure/install/share-paths.ts";

function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
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
  const written: string[] = [];
  const removed: string[] = [];
  const { cliBase, withHooks } = opts;
  // Unified path: devinUserConfigFile() honours $HOME/$USERPROFILE/$APPDATA (see share-paths.ts).
  const userCfgPath = devinUserConfigFile();
  const existing = readIfExists(userCfgPath);
  mkdirSync(dirname(userCfgPath), { recursive: true });
  let next: string | null = existing;
  next = grantCliExecPermission(next) ?? next;
  if (withHooks) {
    next = devinUserConfigWithHooks(next, buildUserGlobalHooks(cliBase));
  }
  if (existing !== null && existing !== next) {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const bak = `${userCfgPath}.bak-${stamp}`;
    try {
      renameSync(userCfgPath, bak);
      written.push(`${bak} (backup)`);
    } catch (err) {
      // Proceeding is safe — the writers are merge-safe and preserve third-party keys —
      // but a silently missing backup is not: surface it in the report.
      written.push(
        `warning: backup of ${userCfgPath} failed (${err instanceof Error ? err.message : String(err)}); proceeding without backup`,
      );
    }
  }
  if (next !== null && next !== existing) {
    writeFileSync(userCfgPath, next);
    const notes = [
      "Exec(leina) pre-authorized",
      withHooks ? "merged hooks" : null,
    ]
      .filter(Boolean)
      .join(" + ");
    written.push(`${userCfgPath} (${notes})`);
  }
  return { written, removed };
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
  try {
    const ucResult = writeUserGlobalConfig({ cliBase, withHooks: userHooks });
    for (const w of ucResult.written) console.log(`  + ${w}`);
    for (const r of ucResult.removed) console.log(`  - ${r}`);
    if (ucResult.written.length === 0 && ucResult.removed.length === 0) {
      console.log("  user-global config: already up-to-date");
    }
  } catch (err) {
    // A failure here means the machine-wide Exec grant and/or hooks were NOT installed —
    // the agent WILL hit permission prompts. Report it as a failure, not a "skipped".
    const msg = err instanceof Error ? err.message : String(err);
    problems.push(
      `user-global config (${devinUserConfigFile()}): ${msg} — grant/hooks NOT installed; ` +
        `fix the file (often malformed JSON) and re-run 'leina activate'`,
    );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * `runDeactivate` — inverse of `runActivate`. [T1, D3]
 *
 * Removes managed host symlinks, revokes the CLI Exec permission grant, and strips the
 * managed hook entries from the user-global Devin config (`devinUserConfigFile()`).
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

  // Print report.
  console.log(`leina deactivate — global teardown.`);
  if (unlinked.length > 0) {
    for (const l of unlinked) {
      console.log(`  - ${l.host}/${l.kind}/${l.name}: removed`);
    }
  } else {
    console.log(`  hosts: no managed symlinks to remove (already clean)`);
  }
  if (configChanged) {
    console.log(`  - ${userCfgPath} (Exec grant + hooks removed)`);
  } else {
    console.log(`  user-global config: already clean`);
  }
}
