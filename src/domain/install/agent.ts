// domain/install/agent.ts — Agent profile and instruction generator domain types.
//
// ARCH: This file MUST import ONLY from other domain/ modules. No application/, infrastructure/
// or cli/ imports allowed (arch-rule-1).

import type { FileArtifact } from "./artifact.ts";
import type { CommandContract } from "../capabilities/model.ts";

/** Transport layer through which a capability is exposed. */
export type Transport = "cli" | "mcp" | "sdk";

/**
 * AgentProfile — describes an AI agent integration target and the instruction files it needs.
 * Pure data: no behaviour, no I/O.
 */
export interface AgentProfile {
  /** Canonical agent id. Only profiles that actually exist (see agent-instructions.ts). */
  id: "devin" | "windsurf" | "claude";
  /** Primary transport this agent is expected to use. */
  preferredTransport: Transport;
  /** Fallback transport when the preferred one is unavailable (optional). */
  fallbackTransport?: Transport;
  /** List of instruction file targets to generate (e.g. ["AGENTS.md"]). */
  instructionTargets: string[];
}

/**
 * AgentInstructionGenerator — produces FileArtifact[] for a given profile and capability set.
 * Pure: no I/O. The CLI layer reads existing files and applies merge-safe primitives.
 */
export interface AgentInstructionGenerator {
  generate(profile: AgentProfile, caps: readonly CommandContract[]): FileArtifact[];
}
