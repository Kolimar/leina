// cli/active-context.ts — SHIM
//
// The implementation was extracted to the application layer.
// This file re-exports the full public surface so that:
//   - src/cli/agent-gate.ts (line 33) continues to import buildActiveContext
//   - test/use-cases/run-devin-hook.test.ts imports still resolve
//   - agent-gate.ts re-exports (lines 64-65) remain unbroken
//
// DO NOT add logic here — this is a pure forwarding shim.

export {
  SESSION_START_CONTEXT,
  buildActiveContext,
} from "../application/context/active-context.ts";

export type {
  ActiveContextDeps,
  ActiveContextResult,
} from "../application/context/active-context.ts";
