// Derive the launch command for THIS leina CLI install, used to wire Devin hooks that
// call back into the CLI (`leina devin-hook <event>` / `refresh <dir>`).

import { extname, resolve } from "node:path";
import { type McpCommand } from "./protocol.ts";
// Re-exported from application/install/protocol.ts (canonical location).

// Derive the base invocation of THIS CLI, used to wire Devin hooks that call
// `leina hook <event>` or `refresh <dir>`. Same dev/built mirroring as the server: a .ts
// entry needs node + strip-types; a built .js entry runs directly. We point at the absolute CLI
// entry on disk so the hook works regardless of PATH. The caller appends the subcommand.
export function deriveCliCommand(opts: { cliEntry: string; execPath: string }): McpCommand {
  const ext = extname(opts.cliEntry); // ".ts" (dev) or ".js" (built)
  const flags = ext === ".ts" ? ["--no-warnings", "--experimental-strip-types"] : [];
  return {
    command: opts.execPath,
    args: [...flags, resolve(opts.cliEntry)],
  };
}
