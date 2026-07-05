// domain/project/identity.ts — Tipos puros e helpers de identidad de repositorio.
// arch-rule-1: NO importar nada de application/, infrastructure/ ni cli/.

import { createHash } from "node:crypto";

/** Nivel de confianza de la detección de identidad del repositorio. */
export type RepoConfidence = "high" | "medium" | "low";

/**
 * Agregado de identidad de repositorio — envuelve la clave de proyecto con
 * señales adicionales (confidence, remote normalizado, commit raíz, pathHash).
 */
export interface RepoIdentity {
  /** Clave de proyecto — idéntica al resultado de deriveProjectKey. */
  projectKey: string;
  /** Método de detección empleado (valor de DetectionMethod de la capa application). */
  strategy: string;
  /** Nivel de confianza derivado del strategy según tabla de mapeo. */
  confidence: RepoConfidence;
  /** Remote origin normalizado a "host/org/repo" en minúsculas; ausente si no hay remote. */
  normalizedRemote?: string;
  /** SHA del primer commit (raíz del árbol git); ausente en repos sin commits. */
  rootCommit?: string;
  /** SHA-256(path normalizado)[:16] — 16 chars hex, determinista cross-OS. */
  pathHash: string;
}

/**
 * Mapea un método de detección a su nivel de confianza correspondiente.
 *
 * Mapa cerrado:
 *   config-lock | git-remote  → high
 *   git-root    | child-git-auto → medium
 *   dir-basename               → low
 *
 * Cualquier valor desconocido produce "low" (fallback seguro).
 */
export function methodToConfidence(method: string): RepoConfidence {
  switch (method) {
    case "config-lock":
    case "git-remote":
      return "high";
    case "git-root":
    case "child-git-auto":
      return "medium";
    case "dir-basename":
      return "low";
    default:
      // Valores desconocidos no deberían ocurrir en producción; en TypeScript
      // la capa application invoca esto con DetectionMethod concreto.
      return "low";
  }
}

/**
 * Calcula el pathHash determinista cross-OS para una ruta absoluta.
 * Algoritmo: SHA-256(normalized)[:16]
 * Normalización: replace('\' → '/') + toLowerCase().
 * No usa realpathSync — determinismo sobre portabilidad de symlinks.
 */
export function computePathHash(absPath: string): string {
  const normalized = absPath.replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Canonicaliza una URL de git remote a "host/org/repo" en minúsculas.
 *
 * Soporta:
 *   SCP:   git@github.com:Org/Repo.git  → "github.com/org/repo"
 *   HTTPS: https://github.com/Org/Repo.git → "github.com/org/repo"
 *
 * Retorna undefined si la URL está vacía o no es parseable.
 */
export function normalizeRemote(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;

  // Strip trailing slashes primero, luego .git — así maneja tanto "repo.git" como "repo.git/"
  const stripped = trimmed.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");

  // Formato SCP: user@host:path (ej. git@github.com:org/repo)
  const scpMatch = /^[^@]+@([^:]+):(.+)$/.exec(stripped);
  if (scpMatch) {
    const host = scpMatch[1]!;
    const path = scpMatch[2]!;
    return `${host}/${path}`.toLowerCase();
  }

  // Formato URL (HTTPS / HTTP / SSH con //): usar URL parser
  try {
    const u = new URL(stripped);
    const pathname = u.pathname.replace(/^\//, "");
    if (!pathname) return undefined;
    return `${u.hostname}/${pathname}`.toLowerCase();
  } catch {
    return undefined;
  }
}
