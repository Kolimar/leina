// catalog.ts — the asset catalog (assets/catalog.json) and selection resolution.
//
// The catalog is the single source of truth for WHAT ships in assets/ — every skill and
// agent, its group, its dependencies — so installs can be selective instead of the
// historical copy-everything. Pure module: the caller reads catalog.json and passes the
// text in; resolution is deterministic data-in/data-out (repo convention: writers/resolvers
// are pure, the CLI does the I/O).
//
// Selection model:
//   - `null` selection  → install everything (back-compat default, no filtering).
//   - explicit selection → lists of skill/agent ids, expanded to their dependency closure
//     (`requires` edges, "skill:x" / "agent:y") plus every `required: true` asset.
//   - presets name group sets ("minimal" → core, "sdd" → core+sdd, "full" → all groups).

import { DEFAULT_HOSTS } from "../../domain/install/hosts.ts";

export type AssetKind = "skill" | "agent";

export interface CatalogAsset {
  kind: AssetKind;
  id: string;
  group: string;
  description: string;
  /** Always installed, whatever the selection (core plumbing). */
  required?: boolean;
  /** Dependency edges as "<kind>:<id>" — auto-included with the asset. */
  requires?: string[];
}

export interface Catalog {
  version: number;
  groups: Record<string, string>;
  presets: Record<string, string[]>;
  assets: CatalogAsset[];
}

/** Selected asset names per kind. null = everything (no filtering). */
export interface Selection {
  skills: string[] | null;
  agents: string[] | null;
  /** Host ids to link into (absent = the historical default, Devin only). */
  hosts?: string[];
}

export interface SelectionInput {
  preset?: string;
  /** Comma-split ids, or the sentinels ["all"] / ["none"]. */
  skills?: string[];
  agents?: string[];
}

export interface ResolvedSelection {
  selection: Selection;
  /** Assets pulled in as dependencies/required, beyond what the user named. */
  autoAdded: string[];
}

export function parseCatalog(json: string): Catalog {
  const raw = JSON.parse(json) as Catalog;
  if (typeof raw.version !== "number" || !Array.isArray(raw.assets)) {
    throw new Error("catalog.json: expected { version, groups, presets, assets[] }");
  }
  for (const a of raw.assets) {
    if ((a.kind !== "skill" && a.kind !== "agent") || !a.id || !a.group) {
      throw new Error(`catalog.json: malformed asset entry ${JSON.stringify(a)}`);
    }
  }
  return raw;
}

const key = (kind: AssetKind, id: string): string => `${kind}:${id}`;

// Preset → group set → per-kind id lists. Returns null when the preset names every
// group ("full" collapses to the no-filtering selection).
function expandPreset(
  catalog: Catalog,
  preset: string,
): { skills: string[]; agents: string[] } | null {
  const groups = catalog.presets[preset];
  if (!groups) {
    throw new Error(
      `unknown --preset "${preset}" (expected: ${Object.keys(catalog.presets).join(" | ")})`,
    );
  }
  if (groups.length === Object.keys(catalog.groups).length) return null;
  const inGroups = catalog.assets.filter((a) => groups.includes(a.group));
  const skills = inGroups.filter((a) => a.kind === "skill").map((a) => a.id);
  const agents = inGroups.filter((a) => a.kind === "agent").map((a) => a.id);
  return { skills, agents: agents.length === 0 ? ["none"] : agents };
}

// Required assets are always in — but only count as "auto-added" for a kind that is
// actually being filtered (an unfiltered kind gets them anyway).
function addRequiredAssets(
  catalog: Catalog,
  seed: Set<string>,
  autoAdded: string[],
  filtered: { skill: boolean; agent: boolean },
): void {
  for (const a of catalog.assets) {
    if (!a.required || seed.has(key(a.kind, a.id)) || !filtered[a.kind]) continue;
    seed.add(key(a.kind, a.id));
    autoAdded.push(key(a.kind, a.id));
  }
}

/**
 * Resolve a user selection against the catalog: validate ids/presets, expand presets to
 * groups, close over `requires`, and always include `required` assets.
 * Throws on unknown preset / skill / agent names (input validation is a hard error).
 */
export function resolveSelection(catalog: Catalog, input: SelectionInput): ResolvedSelection {
  const byKey = new Map<string, CatalogAsset>(catalog.assets.map((a) => [key(a.kind, a.id), a]));

  if (input.preset !== undefined && (input.skills !== undefined || input.agents !== undefined)) {
    throw new Error("use either --preset or --skills/--agents, not both");
  }

  let skills = input.skills;
  let agents = input.agents;
  if (input.preset !== undefined) {
    const expanded = expandPreset(catalog, input.preset);
    if (expanded === null) {
      return { selection: { skills: null, agents: null }, autoAdded: [] };
    }
    ({ skills, agents } = expanded);
  }

  // No selection at all → everything (back-compat).
  if (skills === undefined && agents === undefined) {
    return { selection: { skills: null, agents: null }, autoAdded: [] };
  }

  const expand = (kind: AssetKind, list: string[] | undefined): string[] | null => {
    if (list === undefined || (list.length === 1 && list[0] === "all")) return null;
    if (list.length === 1 && list[0] === "none") return [];
    for (const id of list) {
      if (!byKey.has(key(kind, id))) {
        const known = catalog.assets.filter((a) => a.kind === kind).map((a) => a.id);
        throw new Error(`unknown ${kind} "${id}" (known: ${known.join(", ")})`);
      }
    }
    return list;
  };

  const seed = new Set<string>();
  const explicitSkills = expand("skill", skills);
  const explicitAgents = expand("agent", agents);
  for (const id of explicitSkills ?? []) seed.add(key("skill", id));
  for (const id of explicitAgents ?? []) seed.add(key("agent", id));

  const autoAdded: string[] = [];
  addRequiredAssets(catalog, seed, autoAdded, {
    skill: explicitSkills !== null,
    agent: explicitAgents !== null,
  });

  // Dependency closure (requires edges may chain).
  const queue = [...seed];
  while (queue.length > 0) {
    const k = queue.pop()!;
    for (const dep of byKey.get(k)?.requires ?? []) {
      if (!byKey.has(dep)) throw new Error(`catalog.json: "${k}" requires unknown asset "${dep}"`);
      if (!seed.has(dep)) {
        seed.add(dep);
        autoAdded.push(dep);
        queue.push(dep);
      }
    }
  }

  const pick = (kind: AssetKind, explicit: string[] | null): string[] | null =>
    explicit === null
      ? null
      : [...seed].filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1)).sort();

  return {
    selection: { skills: pick("skill", explicitSkills), agents: pick("agent", explicitAgents) },
    autoAdded: autoAdded.sort(),
  };
}

/** Stable serialized form persisted as share/.selection.json (null = everything). */
export function serializeSelection(selection: Selection): string {
  return JSON.stringify(
    { version: 1, skills: selection.skills, agents: selection.agents, hosts: selection.hosts ?? [...DEFAULT_HOSTS] },
    null,
    2,
  );
}

export function deserializeSelection(json: string | null): Selection | null {
  if (json === null) return null;
  try {
    const raw = JSON.parse(json) as { skills?: string[] | null; agents?: string[] | null; hosts?: string[] };
    return { skills: raw.skills ?? null, agents: raw.agents ?? null, hosts: raw.hosts ?? [...DEFAULT_HOSTS] };
  } catch {
    return null;
  }
}

/** True when two selections install the same asset set into the same hosts. */
export function sameSelection(a: Selection, b: Selection): boolean {
  const eq = (x: string[] | null, y: string[] | null): boolean =>
    x === null || y === null ? x === y : x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  return (
    eq(a.skills, b.skills) &&
    eq(a.agents, b.agents) &&
    eq(a.hosts ?? [...DEFAULT_HOSTS], b.hosts ?? [...DEFAULT_HOSTS])
  );
}
