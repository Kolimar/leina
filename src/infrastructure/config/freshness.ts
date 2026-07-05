// Freshness posture: how the server reacts when the graph's sources changed
// since the last build.
//   auto   - rebuild-if-stale before serving (default; best for solo/dev work)
//   refuse - don't rebuild; instruct the caller to refresh (best for CI / Devin
//            / a committed graph, where rebuilding in the VM is undesirable)
//
// Resolution precedence: env LEINA_FRESHNESS > .leina/config.json
// "freshness" key > default "auto". Invalid values fall through, never throw.

import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

export type FreshnessPosture = "auto" | "refuse";

const ENV_KEY = "LEINA_FRESHNESS";
const DEFAULT: FreshnessPosture = "auto";

function coerce(value: unknown): FreshnessPosture | null {
  return value === "auto" || value === "refuse" ? value : null;
}

function fromConfigFile(root: string): FreshnessPosture | null {
  try {
    const p = join(resolvePath(root), ".leina", "config.json");
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { freshness?: unknown };
    return coerce(parsed.freshness);
  } catch {
    return null;
  }
}

export function loadFreshnessConfig(root: string): FreshnessPosture {
  return coerce(process.env[ENV_KEY]) ?? fromConfigFile(root) ?? DEFAULT;
}
