// cli/node-gate.ts — minimum-Node gate, evaluated BEFORE the dispatcher's import graph.
//
// WHY A SEPARATE, IMPORT-FREE MODULE: the dispatcher (main.ts) statically imports the
// handler tree, which reaches `import { DatabaseSync } from "node:sqlite"`. Under ESM the
// whole module graph is resolved and linked before ANY module body runs, so on a Node
// without `node:sqlite` the process dies in the link phase with ERR_UNKNOWN_BUILTIN_MODULE
// — an opaque stack trace, and no chance for an in-body version check to explain it.
// The entry (index.ts) therefore imports only this module (which imports nothing at the
// top level), runs the gate, and only then dynamically imports the dispatcher — dynamic
// import defers resolution of the heavy graph until after the check.
//
// `engines` in package.json is advisory only (npm merely warns, and pnpm/bun skip
// lifecycle checks entirely) — this runtime gate is the one check that always runs,
// regardless of package manager or --ignore-scripts.

// 22.13.0 is the first 22.x Active LTS release where `node:sqlite` is available without
// --experimental-sqlite (unflagged in 23.4.0, backported to 22.13.0). Shared with doctor.
export const MIN_NODE = { major: 22, minor: 13 } as const;

// Nodes below 24 lack SQLite FTS5 (memory search degrades to LIKE mode), so the upgrade
// advice targets 24 even though 22.13 is the hard floor. Kept in sync with
// FTS5_MIN_NODE_MAJOR in infrastructure/sqlite/schema.ts (not imported: that module's
// import chain must stay out of the gate).
export const RECOMMENDED_NODE_MAJOR = 24;

/** Pure version comparison — exported for tests. Unparseable versions do NOT block. */
export function isSupportedNodeVersion(version: string): boolean {
  const [maj, min] = version.split(".").map((n) => Number.parseInt(n, 10));
  if (maj === undefined || Number.isNaN(maj)) return true;
  if (maj !== MIN_NODE.major) return maj > MIN_NODE.major;
  return (min ?? 0) >= MIN_NODE.minor;
}

/** Pure message builder — exported for tests. */
export function buildNodeGateMessage(
  version: string,
  switchCommand?: string,
  pinnedFile?: string,
): string {
  const lines = [
    `✖ leina requires Node >= ${MIN_NODE.major}.${MIN_NODE.minor} — you are running Node ${version}.`,
    `  Node ${RECOMMENDED_NODE_MAJOR}+ is recommended (enables SQLite FTS5 full-text memory search).`,
  ];
  if (switchCommand) lines.push(`  → ${switchCommand}`);
  if (pinnedFile) lines.push(`  (pin file detected: ${pinnedFile} — it may be loading the old version)`);
  return `${lines.join("\n")  }\n`;
}

/**
 * Exit with an actionable message when the running Node is below MIN_NODE.
 * The version-manager advice module is imported dynamically and only on the failure
 * path, so the happy path stays import-free and adds no startup cost.
 */
export async function runNodeGate(version: string = process.versions.node): Promise<void> {
  if (isSupportedNodeVersion(version)) return;
  let switchCommand: string | undefined;
  let pinnedFile: string | undefined;
  try {
    const { detectNodeVersionAdvice } = await import("../infrastructure/node-version-advice.ts");
    const advice = detectNodeVersionAdvice(process.cwd(), RECOMMENDED_NODE_MAJOR);
    switchCommand = advice.switchCommand;
    pinnedFile = advice.pinnedFile;
  } catch {
    // Advice is best-effort — the core message never depends on it.
  }
  process.stderr.write(buildNodeGateMessage(version, switchCommand, pinnedFile));
  process.exit(1);
}
