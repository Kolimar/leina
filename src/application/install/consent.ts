// consent.ts — Tri-state consent flag per repo. Reads/writes a single-line text atom at
// `.leina/consent`. Called on the hot-path of the agent-gate scope-guard, so it MUST
// be fail-safe: any I/O error → "unknown" (never throws, never blocks the gate).
//
// D2 rationale: this is a direct I/O atom (enabled/disabled/absent), NOT a FileArtifact.
// Unlike the markdown/JSON merge writers, there is no merge step — the flag is written whole.
// Isolation in tests: override `cwd` argument (per-repo) or `$LEINA_HOME` (global).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Three-state per-repo consent. "unknown" means the flag file is absent or unreadable. */
export type ConsentState = "unknown" | "enabled" | "disabled";

/** Relative path of the flag file inside a repo root. */
const FLAG_REL = join(".leina", "consent");

/**
 * Read the consent flag from `<cwd>/.leina/consent`.
 *
 * Returns:
 *  - `"enabled"`  — file contains the string `enabled` (leading/trailing whitespace trimmed)
 *  - `"disabled"` — file contains the string `disabled`
 *  - `"unknown"`  — file absent, unreadable, or contains any other value (fail-safe)
 *
 * NEVER throws. Any filesystem error is swallowed and treated as `"unknown"`.
 */
export function readConsentFlag(cwd: string): ConsentState {
  try {
    const p = join(cwd, FLAG_REL);
    if (!existsSync(p)) return "unknown";
    const raw = readFileSync(p, "utf8").trim();
    if (raw === "enabled") return "enabled";
    if (raw === "disabled") return "disabled";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Write the consent flag to `<cwd>/.leina/consent`, creating the directory if needed.
 * Accepts `"enabled"` or `"disabled"` — `"unknown"` is intentionally excluded (it is not a
 * writable state; absence is how `unknown` is expressed on disk).
 */
export function writeConsentFlag(cwd: string, state: Exclude<ConsentState, "unknown">): void {
  const dir = join(cwd, ".leina");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "consent"), state);
}
