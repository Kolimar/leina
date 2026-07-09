// hosts.ts — host identity data, pure domain.
//
// A "host" is an AI assistant whose global config dir leina links the share into
// (skills + agents). This module owns WHICH hosts exist; HOW each host resolves on the
// filesystem (roots, agent format) lives in the infrastructure table
// (infrastructure/install/share-paths.ts HOSTS), keyed by these ids.
//
// There is deliberately NO default host: leina never links into a host the user didn't
// name (see requireHosts in cli/handlers/install.ts).

export type HostId = "devin" | "claude";

export const HOST_IDS: readonly HostId[] = ["devin", "claude"];

export function isHostId(x: string): x is HostId {
  return (HOST_IDS as readonly string[]).includes(x);
}
