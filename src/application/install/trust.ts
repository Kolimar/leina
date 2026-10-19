// trust.ts — Out-of-repo WORKSPACE TRUST store. The trust anchor for every
// execution/enforcement decision (harness hooks, automated verify, project-layer
// executable gates) — distinct from the consent flag.
//
// Why not `.leina/consent`: that flag lives INSIDE the repo, so a hostile clone can
// simply commit `.leina/consent = enabled` and self-grant trust. The consent flag keeps
// its meaning (advisory hooks, MCP opt-out, repair evidence); trust is recorded where a
// repo cannot reach: one record per trusted repo under $LEINA_HOME/trust/, keyed by the
// sha256 of the repo root's REALPATH (a moved or re-cloned repo is a different workspace
// and must be trusted again). Written by `leina init` (FULL and LIGHT), removed by
// `leina deinit`.
//
// Fail-safe like consent.ts: reads never throw — any I/O error → untrusted.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trustStoreDir } from "../../infrastructure/install/share-paths.ts";
import { readConsentFlag } from "./consent.ts";

/** Realpath of `root` plus its record file; throws when `root` does not exist. */
function trustRecord(root: string): { real: string; file: string } {
  const real = realpathSync(root);
  const key = createHash("sha256").update(real).digest("hex");
  return { real, file: join(trustStoreDir(), key) };
}

/** Path of the record that trusts `root` (for reports). Throws when `root` does not exist. */
export function trustRecordPath(root: string): string {
  return trustRecord(root).file;
}

/**
 * Record `root` as trusted on this machine. Idempotent. Throws on I/O failure so
 * the caller (init) can report the step as failed.
 */
export function trustWorkspace(root: string): void {
  const { real, file } = trustRecord(root);
  mkdirSync(trustStoreDir(), { recursive: true });
  // The record carries the realpath it was keyed from: readable for audits, and
  // re-checked on read so a stray file can never stand in for another repo.
  writeFileSync(file, `${real}\n`);
}

/** Drop the trust record of `root`. Returns true when a record was removed. Never throws. */
export function untrustWorkspace(root: string): boolean {
  try {
    if (!hasTrustRecord(root)) return false;
    rmSync(trustRecord(root).file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** A trust record for `root` exists in this machine's store. Never throws. */
export function hasTrustRecord(root: string): boolean {
  try {
    const { real, file } = trustRecord(root);
    return readFileSync(file, "utf8").trim() === real;
  } catch {
    return false;
  }
}

/**
 * The trust check for every automated execution/enforcement path: the user ran
 * `leina init` on this repo (record present) AND has not opted out since (an explicit
 * `.leina/consent = disabled` always wins — a repo can only ever LOWER trust through
 * its own files, never raise it). Never throws.
 */
export function isWorkspaceTrusted(root: string): boolean {
  return hasTrustRecord(root) && readConsentFlag(root) !== "disabled";
}
