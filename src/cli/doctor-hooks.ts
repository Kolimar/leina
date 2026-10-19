// doctor-hooks.ts — `leina doctor` checks for the agent-hook wiring and the committable
// `.leina/` files. Read-only: stats and parses the four hook files, and asks git whether
// a path is ignored (`git check-ignore`, a read).
//
//   - hook launch: every managed entry bakes an absolute node + CLI path. After a reinstall,
//     a version-manager switch or a moved checkout those paths can point at another leina
//     install (or nothing), and the hooks silently run code that is not the one diagnosed.
//   - hosts wired: a selected host with no managed entries anywhere gets no injection, no
//     advisories and no harness enforcement, while the repo looks initialized.
//   - committable files: `.leina/config.json` (project-name lock) and
//     `.leina/memory-export.jsonl` (shared memory) are meant to be committed; a bare
//     `.leina/` ignore line hides them (git cannot re-include a file under an ignored dir).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isLegacyRefreshCommand,
  hookCommandsIn,
  hooksObjectOf,
  managedHookCommands,
  type ParsedHookCommand,
} from "../application/install/hook-command.ts";
import type { HookSource } from "../application/install/hook-scope.ts";
import { claudeUserSettingsFile, devinUserConfigFile, type HostId } from "../infrastructure/install/share-paths.ts";
import type { CheckResult } from "./doctor.ts";

/** The managed entries one hook file carries. */
export interface HookWiring {
  source: HookSource;
  file: string;
  commands: ParsedHookCommand[];
  /** Pre-3.0 Devin `refresh <project>` entries (a full rebuild after every edit). */
  legacyRefresh: number;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The four places the managed gate can be wired for `root`. */
export function collectHookWiring(root: string): HookWiring[] {
  const files: [HookSource, string, "root" | "hooks-key"][] = [
    ["devin-project", join(root, ".devin", "hooks.v1.json"), "root"],
    ["claude-project", join(root, ".claude", "settings.json"), "hooks-key"],
    ["devin-user", devinUserConfigFile(), "hooks-key"],
    ["claude-user", claudeUserSettingsFile(), "hooks-key"],
  ];
  return files.map(([source, file, shape]) => {
    const text = readText(file);
    const legacyRefresh = hookCommandsIn(hooksObjectOf(text, shape)).filter((h) => isLegacyRefreshCommand(h.command)).length;
    return { source, file, commands: managedHookCommands(text, shape), legacyRefresh };
  });
}

/** Nearest ancestor of `path`'s realpath holding a package.json — the install it belongs to. */
export function installRootOf(path: string): string | undefined {
  let dir: string;
  try {
    dir = dirname(realpathSync(path));
  } catch {
    return undefined;
  }
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Hook launch per file: ok when every managed entry launches an existing node + CLI of the
 * install running this doctor; warn otherwise, naming both installs.
 */
export function checkHookLaunch(out: CheckResult[], g: string, wiring: HookWiring[], runningCli: string): void {
  const running = installRootOf(runningCli) ?? runningCli;
  for (const w of wiring) {
    if (w.legacyRefresh > 0) {
      out.push({
        group: g,
        label: `hooks (${w.source})`,
        status: "warn",
        detail: `${w.file}: pre-3.0 'refresh' entry rebuilds the graph after every edit — run leina repair`,
      });
    }
    if (w.commands.length === 0) continue;
    const missing = w.commands.find((c) => !existsSync(c.cli) || !existsSync(c.node));
    const foreign = w.commands.map((c) => installRootOf(c.cli)).find((r) => r !== undefined && r !== running);
    const label = `hooks (${w.source})`;
    if (missing !== undefined) {
      const what = existsSync(missing.cli) ? `node ${missing.node}` : `CLI ${missing.cli}`;
      out.push({ group: g, label, status: "warn", detail: `${w.file}: hooks launch a missing ${what} — run leina activate / leina repair` });
    } else if (foreign !== undefined) {
      out.push({
        group: g,
        label,
        status: "warn",
        detail: `${w.file}: hooks run another leina install (${foreign}, running ${running}) — run leina activate / leina repair`,
      });
    } else {
      out.push({ group: g, label, status: "ok", detail: `${w.file}: ${w.commands.length} managed entries → this install` });
    }
  }
}

/** Which copies a host loads (Devin also loads Claude Code's files). */
const LOADED_BY: Record<HostId, readonly HookSource[]> = {
  claude: ["claude-project", "claude-user"],
  devin: ["devin-project", "claude-project", "devin-user", "claude-user"],
};

/**
 * Per selected host: is the gate wired anywhere it loads? Only a problem while the repo's
 * consent is enabled (otherwise the hooks would stay silent anyway).
 */
export function checkHostsWired(out: CheckResult[], g: string, wiring: HookWiring[], hosts: HostId[], consentEnabled: boolean): void {
  for (const host of hosts) {
    const via = wiring.filter((w) => LOADED_BY[host].includes(w.source) && w.commands.length > 0).map((w) => w.source);
    const label = `${host} hooks`;
    if (via.length > 0) {
      out.push({ group: g, label, status: "ok", detail: `wired via ${via.join(", ")}` });
    } else if (consentEnabled) {
      out.push({
        group: g,
        label,
        status: "warn",
        detail: `no leina hooks wired for ${host} (project or user-global) — no injection, advisories or harness enforcement; run leina repair, leina activate --hosts ${host} or leina init --hosts ${host}`,
      });
    } else {
      out.push({ group: g, label, status: "info", detail: "not wired (consent not enabled here)" });
    }
  }
}

/** True when any copy of the gate is wired (input to injection readiness). */
export function anyHooksWired(wiring: HookWiring[]): boolean {
  return wiring.some((w) => w.commands.length > 0);
}

/** The ignore rule hiding `rel` in the repo at `root`, or undefined when not ignored / no git. */
function ignoredBy(root: string, rel: string): string | undefined {
  const q = spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd: root, encoding: "utf8" });
  if (q.status !== 0) return undefined; // 1 = not ignored; 128 / spawn error = not a repo / no git
  const v = spawnSync("git", ["check-ignore", "-v", "--", rel], { cwd: root, encoding: "utf8" });
  const rule = (v.stdout ?? "").split("\t")[0]?.trim();
  return rule !== undefined && rule.length > 0 ? rule : "an ignore rule";
}

const COMMITTABLE = [join(".leina", "config.json"), join(".leina", "memory-export.jsonl")];

/** Warn when a committable `.leina/` file exists but git ignores it. */
export function checkCommittableLeinaFiles(out: CheckResult[], g: string, root: string): void {
  for (const rel of COMMITTABLE) {
    if (!existsSync(join(root, rel))) continue;
    const rule = ignoredBy(root, rel);
    if (rule === undefined) continue;
    out.push({
      group: g,
      label: rel.split(/[\\/]/).join("/"),
      status: "warn",
      detail:
        `exists but is git-ignored (${rule}) — it is meant to be committed. A bare '.leina/' line ` +
        `hides it; 'leina repair' rewrites that line to '.leina/*' (other rules: fix them by hand)`,
    });
  }
}
