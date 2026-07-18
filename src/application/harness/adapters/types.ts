// application/harness/adapters/types.ts — the platform-adapter contract for the
// harness sync engine. Adapters are PURE: `generate` returns the desired
// artifact set and never touches disk — all idempotency, clobber-safety and
// lockfile bookkeeping live in writer.ts. Ported from the origin
// harness-framework's src/adapters/types.ts.

import { type HarnessConfig, type Recipe, type Rule } from "../../../domain/harness/model.ts";

export type VerifySupport = "blocking-hooks" | "advisory-hooks" | "instructions-only";

/**
 * A single enum is too coarse: Cursor can block commits but not completion,
 * OpenCode can block tools but not the stop. Capabilities are granular; the
 * summary is derived for doctor/list output.
 */
export interface EnforcementCapabilities {
  contextInjection: boolean;
  preToolBlock: boolean;
  completionBlock: boolean;
  commitBlock: boolean;
}

export type WriteKind = "owned" | "managed-block" | "json-merge";

/** Merge strategies the writer knows how to apply to foreign JSON files. */
export type JsonMergeStrategy = "opencode-instructions" | "cursor-hooks";

export interface GeneratedFile {
  /** Repo-relative path. */
  path: string;
  kind: WriteKind;
  /**
   * owned: full file content · managed-block: the block body ·
   * json-merge: JSON of the harness-managed entries (see json-merge.ts).
   */
  content: string;
  /** managed-block only: marker id. */
  blockId?: string;
  /** json-merge only: which merge strategy applies. */
  mergeStrategy?: JsonMergeStrategy;
  /** Optional file mode for generated executables. */
  mode?: number;
}

export interface FileSet {
  files: GeneratedFile[];
  warnings: string[];
}

export interface RuleBundle {
  /** All resolved + enabled rules, sorted by id. */
  rules: Rule[];
  /** Golden-path recipes (builtin + project, by-name override). */
  recipes: Recipe[];
  config: HarnessConfig;
  /** sha256 over canonical inputs — the lockfile sourceHash. */
  digest: string;
}

export interface AdapterRepoContext {
  repoRoot: string;
}

export interface PlatformAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: EnforcementCapabilities;
  readonly verifySupport: VerifySupport;
  detect(ctx: AdapterRepoContext): Promise<boolean>;
  /** Pure: returns desired artifacts, never touches disk. */
  generate(bundle: RuleBundle, ctx: AdapterRepoContext): Promise<FileSet>;
}
