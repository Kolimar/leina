// Node id normalization. Stable across runs so re-extracting the same code
// yields the same ids (idempotent builds). The scheme: NFKC normalize +
// casefold + collapse non-alphanumerics.

export function normalizeLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "_")
    .replaceAll(/(^_+)|(_+$)/g, "");
}

/**
 * Split an identifier into lowercase word subtokens: camelCase humps, digits and every
 * non-alphanumeric separator are boundaries. "openFreshStore" → [open, fresh, store];
 * "memory_repository.ts" → [memory, repository, ts]; "HTTPServer2" → [http, server, 2].
 * This is what lets a natural-language query term ("store") hit a camelCase symbol
 * whose *whole* label never contains the bare word.
 */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .normalize("NFKC")
    // camelCase / PascalCase boundaries, incl. acronym-then-word (HTTPServer → HTTP Server)
    .replaceAll(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replaceAll(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    // letter/digit boundaries
    .replaceAll(/(\p{L})(\p{N})/gu, "$1 $2")
    .replaceAll(/(\p{N})(\p{L})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

// A node id is scoped by file + normalized label so two same-named symbols in
// different files stay distinct. Members carry their owner for uniqueness.
export function makeId(...parts: string[]): string {
  return parts
    .map((p) => normalizeLabel(p))
    .filter((p) => p.length > 0)
    .join(":");
}

// Workspace-mode namespaced id: `<repoKey>::<makeId(...parts)>`.
// The repoKey is normalized via the same rules as project keys (hyphens, no "::")
// so the "::" separator is unambiguous (makeId uses ":" internally).
// ONLY called in workspace mode — single-repo always uses plain makeId.
export function makeNamespacedId(repoKey: string, ...parts: string[]): string {
  // Normalize the repoKey: NFKC + lowercase + collapse non-alphanumeric to hyphen + trim
  const normalizedKey = repoKey
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[/\\:]+/g, "-")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-+)|(-+$)/g, "") || "project";
  return `${normalizedKey}::${makeId(...parts)}`;
}
