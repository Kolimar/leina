// sidecar-install.ts — prebuilt semantic sidecars: download → verify → cache.
//
// The alternative to `sidecar build` for machines WITHOUT a .NET/JDK toolchain: fetch a
// per-platform tarball published by CI (see .github/workflows/sidecars.yml), verify its
// sha256 against the published checksum, and unpack it into the same cache location the
// local build would produce (`sidecarCacheRoot(lang)/dist`) — everything downstream
// (SidecarExtractor, status, clean) is agnostic about how the binary got there.
//
// Download is ALWAYS explicit and opt-in (`leina sidecar install <lang>`), consistent
// with the consent-first install philosophy. The base URL is injectable via
// $LEINA_SIDECAR_BASE_URL (tests, mirrors, air-gapped hosts); the default points at the
// project's GitHub release assets for the pinned SIDECAR_DIST_TAG.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { SemanticLang } from "../../../application/graph/detect.ts";
import { builtBinaryPath, isSidecarBuilt, sidecarCacheRoot } from "./sidecar-build.ts";

/** Bump when the sidecar sources/templates change in a binary-incompatible way. */
export const SIDECAR_DIST_TAG = "sidecars-v1";

const DEFAULT_BASE = `https://github.com/Kolimar/leina/releases/download/${SIDECAR_DIST_TAG}`;

export function sidecarArtifactName(
  lang: SemanticLang,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `leina-sidecar-${lang}-${platform}-${arch}.tar.gz`;
}

export function sidecarBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LEINA_SIDECAR_BASE_URL?.trim();
  return base !== undefined && base.length > 0 ? base.replace(/\/$/, "") : DEFAULT_BASE;
}

export interface InstallResult {
  ok: boolean;
  binPath?: string;
  error?: string;
}

/** Thrown by {@link fetchBytes} on a non-2xx HTTP response — carries the status so callers
 *  can distinguish "server answered but said no" (404 on a missing release/tag) from a
 *  network failure (DNS/connection error, no HTTP status at all). */
export class FetchStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new FetchStatusError(res.status, `${res.status} ${res.statusText} fetching ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Parse "<sha256>  <filename>" checksum lines (sha256sum format). */
export function checksumFor(checksumText: string, artifactName: string): string | null {
  for (const line of checksumText.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m?.[2] === artifactName) return m[1]!;
  }
  return null;
}

export async function installSidecar(
  lang: SemanticLang,
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  if (isSidecarBuilt(lang) && opts.force !== true) {
    return { ok: true, binPath: builtBinaryPath(lang) };
  }

  const artifact = sidecarArtifactName(lang);
  const base = sidecarBaseUrl();
  const noPrebuiltError = `no prebuilt ${lang} sidecar for ${process.platform}-${process.arch} at ${base} — build locally with 'leina sidecar build ${lang}'`;

  // 1. Checksum first, in its own try/catch: a 404 here (release/tag never published)
  //    gets the same actionable advice as "platform not in the manifest"; a network
  //    failure (no HTTP status at all) is a different, non-actionable failure mode.
  let checksumsBytes: Uint8Array;
  try {
    checksumsBytes = await fetchBytes(`${base}/checksums.txt`);
  } catch (err) {
    if (err instanceof FetchStatusError) {
      return { ok: false, error: noPrebuiltError };
    }
    return {
      ok: false,
      error: `network unreachable fetching ${base}/checksums.txt: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    // A missing checksum entry means this platform/tag was never published.
    const checksums = new TextDecoder().decode(checksumsBytes);
    const expected = checksumFor(checksums, artifact);
    if (expected === null) {
      return { ok: false, error: noPrebuiltError };
    }

    // 2. Download + verify BEFORE anything touches the cache.
    const bytes = await fetchBytes(`${base}/${artifact}`);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      return { ok: false, error: `checksum mismatch for ${artifact}: expected ${expected}, got ${actual} — refusing to install` };
    }

    // 3. Unpack into the same dist/ the local build would produce.
    const root = sidecarCacheRoot(lang);
    const dist = join(root, "dist");
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    const tarball = join(root, artifact);
    writeFileSync(tarball, bytes);
    const tar = spawnSync("tar", ["-xzf", tarball, "-C", dist], { encoding: "utf8" });
    rmSync(tarball, { force: true });
    if (tar.status !== 0) {
      return { ok: false, error: `tar extraction failed: ${tar.stderr || tar.error?.message || "unknown"}` };
    }

    const bin = builtBinaryPath(lang);
    if (!existsSync(bin)) {
      return { ok: false, error: `archive did not contain the expected binary at ${bin}` };
    }
    if (process.platform !== "win32") chmodSync(bin, 0o755);
    return { ok: true, binPath: bin };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
