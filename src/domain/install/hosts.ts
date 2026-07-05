// hosts.ts — host identity data, pure domain.
//
// A "host" is an AI assistant whose global config dir leina links the share into
// (skills + agents). This module owns WHICH hosts exist and the historical default;
// HOW each host resolves on the filesystem (roots, agent format) lives in the
// infrastructure table (infrastructure/install/share-paths.ts HOSTS), keyed by these ids.

export type HostId = "devin" | "claude";

export const HOST_IDS: readonly HostId[] = ["devin", "claude"];

/** Back-compat default: Devin was the only host before the table existed. */
export const DEFAULT_HOSTS: readonly HostId[] = ["devin"];

export function isHostId(x: string): x is HostId {
  return (HOST_IDS as readonly string[]).includes(x);
}
