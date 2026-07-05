// application/install/agent-instructions.ts — AgentInstructionGenerator implementation.
//
// Pure: MUST NOT import node:fs (R-8). All I/O is done by the CLI layer (handleInit).
// Devin produces byte-identical output to mergeAgentsMd(null) (R-3).
// Windsurf adds a ## Capabilities (leina) section with merge-safe markers (R-4, R-6).

import type { FileArtifact } from "../../domain/install/artifact.ts";
import type { AgentProfile, AgentInstructionGenerator } from "../../domain/install/agent.ts";
import type { CommandContract } from "../../domain/capabilities/model.ts";
import { mergeAgentsMd } from "./agents.ts";

// ---------------------------------------------------------------------------
// Capability section markers — own namespace, separate from the protocol block.
// ---------------------------------------------------------------------------

export const CAP_START = "<!-- leina:capabilities:start -->";
export const CAP_END   = "<!-- leina:capabilities:end -->";

// ---------------------------------------------------------------------------
// Predefined profiles
// ---------------------------------------------------------------------------

export const DEVIN_PROFILE: AgentProfile = {
  id: "devin",
  preferredTransport: "cli",
  instructionTargets: ["AGENTS.md"],
};

export const WINDSURF_PROFILE: AgentProfile = {
  id: "windsurf",
  preferredTransport: "cli",
  instructionTargets: ["AGENTS.md"],
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a single CommandContract into a capability list item.
 *
 * Format:
 *   `- \`{id}\` — leina {command}[ [{flags}]]: {description}`
 *
 * Flags are joined with a space inside square brackets. When `cli.flags` is
 * absent or empty, the bracketed block (including the leading space) is omitted.
 */
export function formatCapabilityLine(c: CommandContract): string {
  const flagsPart =
    c.cli.flags && c.cli.flags.length > 0
      ? ` [${c.cli.flags.join(" ")}]`
      : "";
  return `- \`${c.capability.id}\` — leina ${c.cli.command}${flagsPart}: ${c.capability.description}`;
}

// ---------------------------------------------------------------------------
// Merge-safe capabilities section
// ---------------------------------------------------------------------------

/**
 * Inject or replace the capabilities section in `content`.
 *
 * Logic mirrors mergeAgentsMd's marker semantics:
 *   - 0 pairs → append the section at the end (after a blank line separator).
 *   - 1 well-formed pair → replace in place.
 *   - Any other configuration (orphaned, reversed, duplicated) → throw.
 *
 * @param content  Current file content (already has the protocol section).
 * @param caps     Capabilities to list.
 */
export function mergeCapabilitiesSection(
  content: string,
  caps: readonly CommandContract[],
): string {
  const items = caps.map(formatCapabilityLine).join("\n");
  const section =
    `${CAP_START}\n## Capabilities (leina)\n${items}\n${CAP_END}`;

  const lines = content.split("\n");
  const starts: number[] = [];
  const ends: number[]   = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === CAP_START) starts.push(i);
    if (t === CAP_END)   ends.push(i);
  }

  // 0 pairs — append
  if (starts.length === 0 && ends.length === 0) {
    const sep = content.endsWith("\n") ? "\n" : "\n\n";
    return `${content}${sep}${section}\n`;
  }

  // Exactly one well-formed pair — replace in place
  if (starts.length === 1 && ends.length === 1 && ends[0]! > starts[0]!) {
    const before = lines.slice(0, starts[0]);
    const after  = lines.slice(ends[0]! + 1);
    return [...before, section, ...after].join("\n");
  }

  // Malformed
  throw new Error(
    `malformed leina capabilities section — expected exactly one "${CAP_START}" … ` +
      `"${CAP_END}" block, each on its own line. Fix or remove it, then re-run init.`,
  );
}

// ---------------------------------------------------------------------------
// buildAgentsMd — compose the full AGENTS.md for a given profile
// ---------------------------------------------------------------------------

/**
 * Build the AGENTS.md content for `profile` from scratch (existing = null) or
 * by merging with the current file content.
 *
 * - Devin:    pure mergeAgentsMd(existing); caps are NOT used.
 * - Windsurf: mergeAgentsMd(existing) + mergeCapabilitiesSection(_, caps).
 */
export function buildAgentsMd(
  profile: AgentProfile,
  caps: readonly CommandContract[],
  existing: string | null,
): string {
  const base = mergeAgentsMd(existing);
  if (profile.id === "windsurf") {
    return mergeCapabilitiesSection(base, caps);
  }
  return base;
}

// ---------------------------------------------------------------------------
// agentInstructionGenerator — the singleton implementation
// ---------------------------------------------------------------------------

export const agentInstructionGenerator: AgentInstructionGenerator = {
  generate(profile: AgentProfile, caps: readonly CommandContract[]): FileArtifact[] {
    return profile.instructionTargets.map((target) => ({
      path: target,
      content: buildAgentsMd(profile, caps, null),
    }));
  },
};
