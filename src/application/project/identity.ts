// application/project/identity.ts — Lógica de identidad de repositorio con IO.
//
// Orquesta: deriveProjectKey (detect-key) + safeGitOutput (safe-exec) +
// helpers puros de domain/project/identity.
//
// arch-rule-3: NO importar node:sqlite, node:child_process, web-tree-sitter, ts-morph.
// arch-rule-4: NO importar cli/.

import { resolve } from "node:path";
import { deriveProjectKey } from "./detect-key.ts";
import { safeGitOutput } from "../../infrastructure/install/safe-exec.ts";
import {
  type RepoIdentity,
  methodToConfidence,
  computePathHash,
  normalizeRemote,
} from "../../domain/project/identity.ts";

export type { RepoIdentity };

/**
 * Construye un agregado RepoIdentity para el directorio indicado.
 *
 * Pasos:
 *  1. resolve(cwd) → ruta absoluta
 *  2. deriveProjectKey(resolved) → projectKey + strategy
 *  3. methodToConfidence(strategy) → confidence
 *  4. computePathHash(resolved) → pathHash (SHA-256[:16], cross-OS)
 *  5. safeGitOutput rev-list → rootCommit? (undefined en repo vacío)
 *  6. safeGitOutput remote get-url → normalizedRemote? (undefined si sin remote)
 *
 * Fail-open: cualquier fallo de git produce campos undefined; NUNCA lanza
 * (la capa cli/doctor envuelve la llamada en try/catch como capa de seguridad adicional).
 */
export function buildRepoIdentity(cwd: string): RepoIdentity {
  const resolved = resolve(cwd);
  // Puede lanzar AmbiguousProjectError — se propaga para que cli la maneje
  const det = deriveProjectKey(resolved);

  const confidence = methodToConfidence(det.method);
  const pathHash = computePathHash(resolved);

  // rootCommit: safeGitOutput ya retorna null en repo vacío (sin HEAD) o error git
  const rcOut = safeGitOutput(["rev-list", "--max-parents=0", "HEAD"], resolved);
  const rootCommit = rcOut !== null && rcOut.length > 0 ? rcOut : undefined;

  // normalizedRemote: safeGitOutput retorna null si no existe el remote 'origin'
  const rawRemote = safeGitOutput(["remote", "get-url", "origin"], resolved);
  const normalizedRemoteVal = rawRemote !== null ? normalizeRemote(rawRemote) : undefined;

  const result: RepoIdentity = {
    projectKey: det.key,
    strategy: det.method,
    confidence,
    pathHash,
  };
  if (rootCommit !== undefined) result.rootCommit = rootCommit;
  if (normalizedRemoteVal !== undefined) result.normalizedRemote = normalizedRemoteVal;

  return result;
}
