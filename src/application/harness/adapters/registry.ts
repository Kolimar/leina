// application/harness/adapters/registry.ts — the fixed set of platform
// adapters plus auto-detection. `sync` targets either the platforms declared
// in config (`config.platforms`) or, when empty, whichever platforms
// `adapter.detect()` finds evidence for in the repo.

import { type HarnessConfig } from "../../../domain/harness/model.ts";
import { agentsmdAdapter } from "./agentsmd.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { cursorAdapter } from "./cursor.ts";
import { windsurfAdapter } from "./windsurf.ts";
import { opencodeAdapter } from "./opencode.ts";
import { type AdapterRepoContext, type PlatformAdapter } from "./types.ts";

const ADAPTERS: PlatformAdapter[] = [
  agentsmdAdapter,
  claudeCodeAdapter,
  cursorAdapter,
  windsurfAdapter,
  opencodeAdapter,
];

export function allAdapters(): PlatformAdapter[] {
  return [...ADAPTERS];
}

export function adapterById(id: string): PlatformAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

export function registerAdapter(adapter: PlatformAdapter): void {
  ADAPTERS.push(adapter);
}

/** Adapters whose `detect()` reports platform evidence in the repo. */
export async function detectAdapters(ctx: AdapterRepoContext): Promise<PlatformAdapter[]> {
  const detected: PlatformAdapter[] = [];
  for (const adapter of ADAPTERS) {
    if (await adapter.detect(ctx)) detected.push(adapter);
  }
  return detected;
}

/** Resolve explicit platform ids; unknown ids become warnings, never errors. */
export function adaptersByIds(ids: readonly string[]): { adapters: PlatformAdapter[]; warnings: string[] } {
  const adapters: PlatformAdapter[] = [];
  const warnings: string[] = [];
  for (const id of ids) {
    const adapter = adapterById(id);
    if (adapter) adapters.push(adapter);
    else warnings.push(`no adapter implemented for platform "${id}" yet — skipping`);
  }
  return { adapters, warnings };
}

/**
 * The sync target set, mirroring the origin CLI's selection: explicit
 * `config.platforms` when declared (unknown ids become warnings), otherwise
 * auto-detection over every registered adapter.
 */
export async function selectAdapters(
  config: HarnessConfig,
  ctx: AdapterRepoContext,
): Promise<{ adapters: PlatformAdapter[]; warnings: string[] }> {
  if (config.platforms.length === 0) {
    return { adapters: await detectAdapters(ctx), warnings: [] };
  }
  return adaptersByIds(config.platforms);
}
