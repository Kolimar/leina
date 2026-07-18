// application/harness/adapters/agentsmd.ts — the universal baseline adapter.
// The AGENTS.md standard is read by Codex CLI, Gemini CLI, Jules, Copilot
// agent, Aider, Zed and others. Instructions-only — enforcement is
// honor-system here, but the executable oracle (`leina harness verify`) is
// identical across platforms, which is what makes outcomes converge.
//
// Coexistence: leina's own protocol block in AGENTS.md uses different markers
// (`<!-- leina:protocol:start -->` … `<!-- leina:protocol:end -->`) than the
// harness managed block (`<!-- harness:begin id=… -->`), so both blocks update
// independently without ever touching each other.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderInstructionBlock } from "./digest.ts";
import {
  type AdapterRepoContext,
  type FileSet,
  type PlatformAdapter,
  type RuleBundle,
} from "./types.ts";

export const agentsmdAdapter: PlatformAdapter = {
  id: "agentsmd",
  displayName: "AGENTS.md (universal)",
  capabilities: {
    contextInjection: false,
    preToolBlock: false,
    completionBlock: false,
    commitBlock: false,
  },
  verifySupport: "instructions-only",

  detect(ctx: AdapterRepoContext): Promise<boolean> {
    // Evidence-based like every other adapter: leina never elects a target the
    // repo shows no trace of. An AGENTS.md consumer leaves the file itself.
    return Promise.resolve(existsSync(join(ctx.repoRoot, "AGENTS.md")));
  },

  generate(bundle: RuleBundle, _ctx: AdapterRepoContext): Promise<FileSet> {
    // No hook can inject the contract protocol here, so the template rides inline.
    const body = renderInstructionBlock(bundle, { includeContractTemplate: true });
    return Promise.resolve({
      files: [
        {
          path: "AGENTS.md",
          kind: "managed-block",
          blockId: "harness-core",
          content: body,
        },
      ],
      warnings: [],
    });
  },
};
