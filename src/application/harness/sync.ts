// application/harness/sync.ts — one reusable run of the sync engine:
// buildBundle → adapter selection (explicit platforms > config.platforms >
// auto-detect) → generate file sets → applyFileSets. Shared by the
// `leina harness sync` CLI handler and the `leina init` harness bootstrap so
// both surfaces produce byte-identical artifacts.

import { buildBundle } from "./adapters/bundle.ts";
import { adaptersByIds, selectAdapters } from "./adapters/registry.ts";
import { applyFileSets, type AdapterFileSet, type ApplyOutcome } from "./adapters/writer.ts";
import { type PlatformAdapter } from "./adapters/types.ts";

export interface SyncOptions {
  /** Compute actions without writing anything; drift → exit 1 (CI mode). */
  check?: boolean;
  /** Overwrite artifacts that were hand-edited. */
  force?: boolean;
  /** Explicit adapter ids — overrides config.platforms / auto-detection. */
  platforms?: string[];
}

export interface SyncResult {
  /** Undefined only when rule/config loading failed (exitCode 2). */
  outcome?: ApplyOutcome;
  errors: string[];
  warnings: string[];
  /** 0 = clean · 1 = drift (--check) or conflicts · 2 = load error. */
  exitCode: 0 | 1 | 2;
}

export async function runSync(repoRoot: string, options: SyncOptions = {}): Promise<SyncResult> {
  const { bundle, errors, warnings } = await buildBundle(repoRoot);
  const allWarnings = [...warnings];
  if (errors.length > 0) {
    return { errors, warnings: allWarnings, exitCode: 2 };
  }

  let adapters: PlatformAdapter[];
  if (options.platforms !== undefined && options.platforms.length > 0) {
    const explicit = adaptersByIds(options.platforms);
    adapters = explicit.adapters;
    allWarnings.push(...explicit.warnings);
  } else {
    const selected = await selectAdapters(bundle.config, { repoRoot });
    adapters = selected.adapters;
    allWarnings.push(...selected.warnings);
  }

  const sets: AdapterFileSet[] = [];
  for (const adapter of adapters) {
    const fileSet = await adapter.generate(bundle, { repoRoot });
    allWarnings.push(...fileSet.warnings.map((w) => `[${adapter.id}] ${w}`));
    sets.push({ adapter: adapter.id, fileSet });
  }

  const outcome = await applyFileSets(repoRoot, sets, {
    sourceHash: bundle.digest,
    ...(options.check !== undefined ? { check: options.check } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
  });

  const exitCode = options.check
    ? outcome.driftCount > 0
      ? 1
      : 0
    : outcome.conflictCount > 0
      ? 1
      : 0;

  return { outcome, errors: [], warnings: allWarnings, exitCode };
}
