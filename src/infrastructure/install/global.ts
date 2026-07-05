// global.ts — Populate the global share + symlink it into the Devin host's global skills/agents dir.
//
// Two phases, both idempotent:
//
//   1. populateShare(assetsRoot, packageVersion)
//      - Ensures share/{skills,agents,workflows}/ exists under $LEINA_HOME/share.
//      - On first run, or when the package version on disk differs from the bundled one,
//        regenerates the share from bundled assets/. Otherwise no-op.
//      - Writes a .version sentinel so we can detect drift on subsequent runs.
//
//   2. linkHosts()
//      - Creates one symlink per skill and per agent into Devin's global dirs
//        (~/.config/devin/{skills,agents}/<name>/). linkOrCopy handles existing files (refuse
//        to clobber: backs up, then replaces) and the Windows symlink fallback.
//
// Together: `leina install-global` (and `init` as a silent caller) wires up the entire
// skills/agents surface in O(1). The orchestrator skill (`leina-sdd`) and every SDD phase
// skill become available globally with no per-project files.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  blanketFile,
  devinUserConfigFile,
  DEFAULT_HOSTS,
  HOSTS,
  type HostId,
  type HostSpec,
  shareAgentsDir,
  shareRoot,
  shareSelectionFile,
  shareSkillsDir,
  shareVersionFile,
  shareWorkflowsDir,
} from "./share-paths.ts";
import { buildDevinArtifactsFromAgents } from "../../application/install/devin-skills.ts";
import { CLI_EXEC_GRANT, grantCliExecPermission } from "../../application/install/permissions.ts";
import { portWorkflows, rewriteAssetPaths } from "../../application/install/port.ts";
import { copyTree, linkOrCopy, unlinkIfManaged, type LinkResult } from "./symlinks.ts";
import {
  deserializeSelection,
  sameSelection,
  serializeSelection,
  type Selection,
} from "../../application/install/catalog.ts";

/** The no-filter selection (historical behaviour: install every bundled asset). */
const ALL_ASSETS: Selection = { skills: null, agents: null };

/**
 * The agent entries a host consumes, resolved from its share subdir + shape.
 * This is the ONLY place agentShape is interpreted — link/unlink/inspect all
 * iterate these pairs, so a new shape is one case here, not four.
 */
function agentEntries(spec: HostSpec): { name: string; src: string; dest: string }[] {
  const shareDir = spec.agentShareDir();
  if (spec.agentShape === "dir") {
    return listSubdirs(shareDir).map((name) => ({
      name,
      src: join(shareDir, name),
      dest: join(spec.agentsRoot(), name),
    }));
  }
  return listMdFiles(shareDir).map((file) => ({
    name: file.slice(0, -3),
    src: join(shareDir, file),
    dest: join(spec.agentsRoot(), file),
  }));
}

export function normalizeHosts(hosts: string[] | undefined): HostId[] {
  const known = hosts?.filter((h): h is HostId => HOSTS.some((spec) => spec.id === h));
  return known !== undefined && known.length > 0 ? known : [...DEFAULT_HOSTS];
}

/**
 * First-run host detection: Devin (the historical default) plus every host whose global
 * config dir already exists on this machine (e.g. ~/.claude → Claude Code). Used when
 * neither --hosts nor a persisted selection says where to link — a Claude Code user's
 * first `leina setup` should light up their host without needing to know the flag.
 */
export function detectHosts(): HostId[] {
  const out: HostId[] = [];
  for (const spec of HOSTS) {
    if (spec.id === "devin" || existsSync(dirname(spec.skillsRoot()))) out.push(spec.id);
  }
  return out.length > 0 ? out : [...DEFAULT_HOSTS];
}

export interface HostLink {
  host: HostId;
  kind: "skill" | "agent";
  name: string;
  result: LinkResult;
}

export interface InstallGlobalReport {
  shareRoot: string;
  populated: boolean; // true if we (re)wrote the share this run
  staleLinksRemoved: number; // dangling host links swept after a deselecting repopulate
  skillCount: number;
  agentCount: number;
  workflowCount: number;
  hostLinks: HostLink[];
}

/** Resolve the bundled `assets/` directory next to this CLI (works in dev .ts + built .js). */
export function bundledAssetsRoot(cliUrl: string): string {
  // cliUrl = import.meta.url of cli/index.{ts,js}; assets are two levels up.
  return fileURLToPath(new URL("../../assets/", cliUrl));
}

// The bundled `assets/` directory anchored to the CLI ENTRY script (process.argv[1]).
//
// The entry is realpath'd first: every package manager exposes the global bin through a
// SYMLINK (npm: <prefix>/bin/leina -> <prefix>/lib/node_modules/<pkg>/dist/cli/index.js;
// pnpm adds a second hop through its content-addressed .pnpm store; bun links straight to
// the package). path.resolve keeps the symlink location, so `../../assets` would land
// outside the package (<prefix>/assets). Dereferencing the full chain points the anchor at
// the real dist/cli/index.js, whatever the store layout.
export function entryAssetsRootFrom(entry: string): string {
  const abs = resolve(entry);
  const real = existsSync(abs) ? realpathSync(abs) : abs;
  return bundledAssetsRoot(pathToFileURL(real).href);
}

/** entryAssetsRootFrom over the live process entry. */
export function entryAssetsRoot(): string {
  return entryAssetsRootFrom(process.argv[1] ?? ".");
}

// Skills: copy the bundled SKILL.md tree into share/skills/. The hand-authored
// orchestrator (leina-sdd) and shared conventions (_shared) live here too. For agents
// that have a matching methodology skill, the copied skills/<name>/SKILL.md is intentionally
// overwritten by the thin delegator (see populateDevinAgents) — the methodology is inlined
// into the AGENT.md instead, so the subagent never needs the clobbered path.
function populateSkills(skillsSrc: string, skills: string[] | null): void {
  if (skills === null) {
    copyTree(skillsSrc, shareSkillsDir());
  } else {
    for (const id of skills) {
      const src = join(skillsSrc, id);
      if (existsSync(src)) copyTree(src, join(shareSkillsDir(), id));
    }
  }
  rewriteSkillRefsInPlace(shareSkillsDir());
}

// The bundled sources reference siblings with the host-neutral `skills/...` form. A skill
// linked into a host's global dir (~/.claude/skills/x, ~/.config/devin/skills/x) is read
// from an arbitrary project cwd, where that relative form resolves nowhere. The share is
// per-machine, so resolving the refs to the share's ABSOLUTE skills dir makes them valid
// from any cwd for every host.
function rewriteSkillRefsInPlace(dir: string): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      rewriteSkillRefsInPlace(p);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      const raw = readFileSync(p, "utf8");
      const rewritten = rewriteAssetPaths(raw, shareSkillsDir());
      if (rewritten !== raw) writeFileSync(p, rewritten);
    }
  }
}

// Per-agent artifacts generated from assets/agents/<name>.md (methodology inlined from
// the sibling assets/skills/<name>/SKILL.md when present): the Devin AGENT.md, the thin
// "skills/<name>/SKILL.md" delegator, and the flat Claude claude-agents/<name>.md. All
// belong to the AGENT <name>, so all are filtered by the agent selection — a deselected
// agent leaves the static methodology skill un-clobbered.
function populateAgentArtifacts(root: string, agentsSrc: string, skillsSrc: string, agents: string[] | null): void {
  for (const art of buildDevinArtifactsFromAgents(agentsSrc, skillsSrc)) {
    const segment = art.path.split("/")[1];
    const name = segment?.endsWith(".md") ? segment.slice(0, -3) : segment;
    if (agents !== null && (name === undefined || !agents.includes(name))) continue;
    const dest = join(root, art.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, art.content);
  }
}

// Workflows port: same generator that used to drive per-repo installs, now landing in the
// share so the orchestrator can reference a single copy. portWorkflows filters by
// top-level name, so the union of selected skills+agents scopes it.
function populateWorkflows(root: string, skillsSrc: string, agentsSrc: string, effective: Selection): void {
  const wfFilter =
    effective.skills === null && effective.agents === null
      ? undefined
      : [...new Set([...(effective.skills ?? []), ...(effective.agents ?? [])])];
  const wfArtifacts = portWorkflows(
    skillsSrc,
    agentsSrc,
    "workflows",
    wfFilter?.length === 0 ? ["none"] : wfFilter,
  );
  for (const art of wfArtifacts) {
    const dest = join(root, art.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, art.content);
  }
}

/**
 * Idempotently populate $LEINA_HOME/share/ from bundled assets.
 *
 * Returns true when the share was (re)written this call, false when up-to-date.
 */
export function populateShare(
  assetsRoot: string,
  packageVersion: string,
  selection?: Selection,
): boolean {
  const root = shareRoot();
  const sentinel = shareVersionFile();
  const current = safeRead(sentinel);
  // selection === undefined means "keep whatever was chosen before" (repair, plain
  // re-activate); an explicit selection is compared against the persisted one so a
  // changed choice forces a repopulate even on the same package version.
  const persisted = deserializeSelection(safeRead(shareSelectionFile())) ?? ALL_ASSETS;
  const effective = selection ?? persisted;
  if (current === packageVersion && sameSelection(persisted, effective)) return false;

  // Replace the share atomically: rm -rf the kind dirs, repopulate, then write the sentinel last.
  // We never touch anything outside share/, so a corrupted partial population is recoverable.
  // The kind dirs are skills + workflows plus every host's agent share dir (from the table),
  // so a new host's output is swept automatically.
  const kindDirs = new Set([shareSkillsDir(), shareWorkflowsDir(), ...HOSTS.map((h) => h.agentShareDir())]);
  for (const sub of kindDirs) {
    rmSync(sub, { recursive: true, force: true });
  }
  mkdirSync(shareSkillsDir(), { recursive: true });
  mkdirSync(shareAgentsDir(), { recursive: true });
  mkdirSync(shareWorkflowsDir(), { recursive: true });

  const skillsSrc = join(assetsRoot, "skills");
  const agentsSrc = join(assetsRoot, "agents");
  populateSkills(skillsSrc, effective.skills);
  populateAgentArtifacts(root, agentsSrc, skillsSrc, effective.agents);
  populateWorkflows(root, skillsSrc, agentsSrc, effective);

  writeFileSync(shareSelectionFile(), serializeSelection(effective));
  writeFileSync(sentinel, packageVersion);
  return true;
}

/**
 * Remove host symlinks that point INTO the share but whose target no longer exists —
 * the leftovers of a repopulate that deselected assets. Only dangling links inside the
 * share are touched (third-party links and healthy links are never candidates). The
 * Windows copy-fallback (real dirs, not symlinks) is not swept — those copies are
 * refreshed wholesale on the next populate.
 */
export function sweepDanglingHostLinks(): number {
  let removed = 0;
  const share = shareRoot();
  for (const dir of HOSTS.flatMap((h) => [h.skillsRoot(), h.agentsRoot()])) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      try {
        if (!lstatSync(p).isSymbolicLink()) continue;
        const target = resolve(dirname(p), readlinkSync(p));
        if (target.startsWith(share) && !existsSync(target)) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch {
        /* unreadable entry — leave it alone */
      }
    }
  }
  return removed;
}

/**
 * Create per-name symlinks from Devin's global dirs into share/. Idempotent.
 *
 * Devin: one symlink per skill (`~/.config/devin/skills/<name>/`) and per agent
 *        (`~/.config/devin/agents/<name>/`).
 */
export function linkHosts(hosts: HostId[] = [...DEFAULT_HOSTS]): HostLink[] {
  const out: HostLink[] = [];

  const skillEntries = listSubdirs(shareSkillsDir());

  for (const spec of HOSTS) {
    if (!hosts.includes(spec.id)) continue;
    for (const name of skillEntries) {
      const result = linkOrCopy(join(shareSkillsDir(), name), join(spec.skillsRoot(), name));
      out.push({ host: spec.id, kind: "skill", name, result });
    }
    for (const e of agentEntries(spec)) {
      out.push({ host: spec.id, kind: "agent", name: e.name, result: linkOrCopy(e.src, e.dest) });
    }
  }

  return out;
}

/**
 * Returns true when the global share has been fully populated (the `.version` sentinel is
 * written LAST by `populateShare`, so its presence is an atomic "population completed" signal).
 * Cheap: one `stat` call. Use this to detect whether `leina activate` has been run.
 */
export function isGlobalActivated(): boolean {
  return existsSync(shareVersionFile());
}

/**
 * Returns true when the blanket sentinel file exists at `$LEINA_HOME/.blanket`.
 * When active, `init` takes the LIGHT path (consent + gitignore only; share/symlinks/hooks
 * are already machine-wide from `setup`). Cheap: one `stat` call.
 */
export function isBlanketActive(): boolean {
  return existsSync(blanketFile());
}

/**
 * Remove previously-installed symlinks from the Devin global dirs, but ONLY those that point
 * into our share (managed symlinks). Symlinks pointing elsewhere — i.e. installed by a
 * different tool — are left untouched (T2, D1).
 *
 * Mirrors `linkHosts()` structure: iterates share/{skills,agents} to know which names were
 * installed, then calls `unlinkIfManaged` on the corresponding host-dir entries.
 *
 * Returns one `HostLink` per candidate entry:
 *  - `action: "unlinked"`          — managed symlink removed
 *  - `action: "skipped-unmanaged"` — dest does not exist, is not a symlink, or points outside
 *                                     the share → left alone
 */
export function unlinkHosts(): HostLink[] {
  const out: HostLink[] = [];

  // Teardown sweeps EVERY host in the table, whatever the current selection says —
  // a host deselected months ago must still get cleaned up by deactivate/disable.
  for (const spec of HOSTS) {
    for (const name of listSubdirs(shareSkillsDir())) {
      const dest = join(spec.skillsRoot(), name);
      const removed = unlinkIfManaged(dest, shareSkillsDir());
      out.push({
        host: spec.id,
        kind: "skill",
        name,
        result: { path: dest, action: removed ? "unlinked" : "skipped-unmanaged" },
      });
    }
    for (const e of agentEntries(spec)) {
      const removed = unlinkIfManaged(e.dest, spec.agentShareDir());
      out.push({
        host: spec.id,
        kind: "agent",
        name: e.name,
        result: { path: e.dest, action: removed ? "unlinked" : "skipped-unmanaged" },
      });
    }
  }

  return out;
}

/** Unlink one host's managed links (used when a host is DESELECTED on re-activate). */
function unlinkSingleHost(id: HostId): number {
  const spec = HOSTS.find((h) => h.id === id);
  if (!spec) return 0;
  let removed = 0;
  for (const name of listSubdirs(shareSkillsDir())) {
    if (unlinkIfManaged(join(spec.skillsRoot(), name), shareSkillsDir())) removed++;
  }
  for (const e of agentEntries(spec)) {
    if (unlinkIfManaged(e.dest, spec.agentShareDir())) removed++;
  }
  return removed;
}

/** Combined entry point: populate + link, returning a structured report for the CLI. */
export function installGlobal(
  assetsRoot: string,
  packageVersion: string,
  selection?: Selection,
): InstallGlobalReport {
  const prevHosts = normalizeHosts(
    (deserializeSelection(safeRead(shareSelectionFile())) ?? ALL_ASSETS).hosts,
  );
  const populated = populateShare(assetsRoot, packageVersion, selection);
  const hosts = normalizeHosts(
    (deserializeSelection(safeRead(shareSelectionFile())) ?? selection ?? ALL_ASSETS).hosts,
  );
  // A host that was linked before but is no longer selected gets its managed links
  // removed (its share targets still exist, so the dangling sweep alone can't see them).
  let staleLinksRemoved = 0;
  for (const prev of prevHosts) {
    if (!hosts.includes(prev)) staleLinksRemoved += unlinkSingleHost(prev);
  }
  // A repopulate may also have deselected assets: their host symlinks now dangle into
  // the share — sweep them before (re)linking what exists.
  staleLinksRemoved += populated ? sweepDanglingHostLinks() : 0;
  const hostLinks = linkHosts(hosts);
  return {
    shareRoot: shareRoot(),
    populated,
    staleLinksRemoved,
    skillCount: listSubdirs(shareSkillsDir()).length,
    agentCount: listSubdirs(shareAgentsDir()).length,
    workflowCount: countWorkflowFiles(shareWorkflowsDir()),
    hostLinks,
  };
}

/** Outcome of ensuring the user-global `Exec(leina)` permission grant. */
export type CliGrantResult = "added" | "present" | "skipped-malformed";

/**
 * Idempotently pre-authorize the leina CLI in the user-global Devin config
 * (`~/.config/devin/config.json`) by adding `Exec(leina)` to `permissions.allow`. One
 * machine-wide grant covers every repo, so the agent never gets a permission prompt for
 * `leina ...` in any project.
 *
 * Creates the file (and its parent dir) when absent; merges into an existing config otherwise.
 * Returns:
 *   - "added"            the grant was written (file created or `allow` extended)
 *   - "present"          the grant was already there → no write
 *   - "skipped-malformed" the file exists but is malformed / wrong-shaped → left untouched
 */
export function ensureUserConfigCliGrant(): CliGrantResult {
  const cfgPath = devinUserConfigFile();
  // Read directly and treat any failure as "absent" (EAFP) rather than exists-then-read,
  // which is a TOCTOU race: the file could change between the check and the read.
  let existing: string | null;
  try {
    existing = readFileSync(cfgPath, "utf8");
  } catch {
    existing = null;
  }
  const next = grantCliExecPermission(existing);
  if (next !== null) {
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, next);
    return "added";
  }
  // next === null → nothing to write. grantCliExecPermission returns null both when the grant is
  // already present and when the file is malformed/wrong-shaped; distinguish them for the report.
  return existing?.includes(CLI_EXEC_GRANT) ? "present" : "skipped-malformed";
}

/**
 * Self-heal the global share. Named wrapper around installGlobal so callers read as intent —
 * "make the share current for this binary" — and so the behaviour has a single unit-test
 * surface. populateShare is version-gated, so this is a cheap no-op when the share already
 * matches `version`; on a version bump it repopulates and re-links so freshly-bundled
 * skills/agents become visible (the `install-global` / `init` paths use it).
 */
export function maybeHealShare(assetsRoot: string, version: string): InstallGlobalReport {
  return installGlobal(assetsRoot, version);
}

// ---------------------------------------------------------------------------
// Read-only inspection (for `leina doctor`). Never writes — mirrors linkHosts()'s
// share→host mapping but only stats what's on disk.
// ---------------------------------------------------------------------------

export type HostLinkState = "ok" | "missing" | "broken" | "wrong-target" | "copy-fallback" | "copy-stale";

export interface HostLinkStatus {
  host: HostId;
  kind: "skill" | "agent";
  name: string;
  /** Where the host link is expected to live. */
  dest: string;
  state: HostLinkState;
}

/** Classify one expected host link without touching it. */
function inspectLink(
  host: HostId,
  kind: "skill" | "agent",
  name: string,
  src: string,
  dest: string,
  shareStampMs: number | null,
): HostLinkStatus {
  const base = { host, kind, name, dest } as const;
  let lst;
  try {
    lst = lstatSync(dest);
  } catch {
    return { ...base, state: "missing" };
  }
  if (lst.isSymbolicLink()) {
    // Dangling symlink: the link node exists but its target is gone.
    if (!existsSync(dest)) return { ...base, state: "broken" };
    const target = resolve(dirname(dest), readlinkSync(dest));
    return { ...base, state: target === resolve(src) ? "ok" : "wrong-target" };
  }
  // A real directory/file (not a symlink) is the Windows copy fallback — the files are
  // present but do NOT auto-propagate share updates. A copy made before the last populate
  // (older than the .version sentinel) is serving outdated content: flag it for repair.
  if (shareStampMs !== null && lst.mtimeMs < shareStampMs) {
    return { ...base, state: "copy-stale" };
  }
  return { ...base, state: "copy-fallback" };
}

/**
 * Report the on-disk state of every host link the share expects, without modifying anything.
 * Read-only counterpart to linkHosts() used by the doctor command.
 */
export function inspectHostLinks(): HostLinkStatus[] {
  const out: HostLinkStatus[] = [];
  // Only the ACTIVE hosts (persisted selection) — a host the user never opted into must
  // not produce doctor noise about "missing" links.
  const hosts = normalizeHosts(
    (deserializeSelection(safeRead(shareSelectionFile())) ?? ALL_ASSETS).hosts,
  );
  // When the last populate happened: copies older than this predate the current share.
  let shareStampMs: number | null = null;
  try {
    shareStampMs = statSync(shareVersionFile()).mtimeMs;
  } catch {
    /* no sentinel — cannot judge staleness */
  }
  for (const spec of HOSTS) {
    if (!hosts.includes(spec.id)) continue;
    for (const name of listSubdirs(shareSkillsDir())) {
      out.push(
        inspectLink(spec.id, "skill", name, join(shareSkillsDir(), name), join(spec.skillsRoot(), name), shareStampMs),
      );
    }
    for (const e of agentEntries(spec)) {
      out.push(inspectLink(spec.id, "agent", e.name, e.src, e.dest, shareStampMs));
    }
  }
  return out;
}

// ---- helpers ----

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

function listMdFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => e.endsWith(".md"));
  } catch {
    return [];
  }
}

function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => {
      try {
        return statSync(join(dir, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function countWorkflowFiles(dir: string): number {
  let n = 0;
  function walk(d: string): void {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e);
      const st = (() => {
        try {
          return statSync(full);
        } catch {
          return null;
        }
      })();
      if (!st) continue;
      if (st.isDirectory()) walk(full);
      else if (e.endsWith(".md")) n++;
    }
  }
  walk(dir);
  return n;
}
