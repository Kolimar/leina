// workspace-trust-store.test.ts — the OUT-OF-REPO workspace trust store
// (src/application/install/trust.ts). The repo-local consent flag can be
// committed by a hostile clone, so execution/enforcement trust lives under
// $LEINA_HOME/trust/, keyed by the repo root's realpath, written by
// `leina init` (FULL and LIGHT) and removed by `leina deinit`.
//
// Run: node --no-warnings --experimental-strip-types --test test/workspace-trust-store.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasTrustRecord,
  isWorkspaceTrusted,
  trustWorkspace,
  untrustWorkspace,
} from "../src/application/install/trust.ts";
import { isolateLeinaHome } from "./helpers/harness-tmprepo.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

let sandbox: string;
let home: string;
let repo: string;
let restoreHome: () => void;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "leina-trust-store-"));
  home = join(sandbox, "leina-home");
  repo = join(sandbox, "repo");
  mkdirSync(repo, { recursive: true });
  restoreHome = isolateLeinaHome(home);
});

afterEach(() => {
  restoreHome();
  rmSync(sandbox, { recursive: true, force: true });
});

function writeConsent(state: string): void {
  mkdirSync(join(repo, ".leina"), { recursive: true });
  writeFileSync(join(repo, ".leina", "consent"), state);
}

describe("trust store (unit)", () => {
  it("(trust-store-1) a committed .leina/consent = enabled grants no trust on its own", () => {
    writeConsent("enabled");
    assert.equal(isWorkspaceTrusted(repo), false);
  });

  it("(trust-store-2) trustWorkspace records the repo under $LEINA_HOME, never inside the repo", () => {
    trustWorkspace(repo);
    assert.equal(isWorkspaceTrusted(repo), true);
    assert.equal(readdirSync(join(home, "trust")).length, 1);
    assert.equal(existsSync(join(repo, ".leina")), false, "nothing written into the repo");
  });

  it("(trust-store-3) keyed by realpath: a symlinked path to the same repo is the same workspace", () => {
    const link = join(sandbox, "repo-link");
    symlinkSync(repo, link);
    trustWorkspace(link);
    assert.equal(isWorkspaceTrusted(repo), true);
    assert.equal(isWorkspaceTrusted(link), true);
  });

  it("(trust-store-4) a sibling repo, a missing path or another LEINA_HOME is not trusted", () => {
    trustWorkspace(repo);
    const sibling = join(sandbox, "other");
    mkdirSync(sibling);
    assert.equal(isWorkspaceTrusted(sibling), false);
    assert.equal(isWorkspaceTrusted(join(sandbox, "missing")), false);

    const restore = isolateLeinaHome(join(sandbox, "another-home"));
    try {
      assert.equal(isWorkspaceTrusted(repo), false, "trust is per machine/home, not per repo");
    } finally {
      restore();
    }
  });

  it("(trust-store-5) an explicit consent opt-out wins over a trust record", () => {
    trustWorkspace(repo);
    writeConsent("disabled");
    assert.equal(hasTrustRecord(repo), true);
    assert.equal(isWorkspaceTrusted(repo), false);
  });

  it("(trust-store-6) untrustWorkspace removes the record; idempotent", () => {
    trustWorkspace(repo);
    assert.equal(untrustWorkspace(repo), true);
    assert.equal(isWorkspaceTrusted(repo), false);
    assert.equal(untrustWorkspace(repo), false);
  });
});

describe("trust store — leina init / deinit (e2e)", () => {
  function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        LEINA_HOME: home,
        HOME: sandbox,
        USERPROFILE: sandbox,
        LEINA_DISABLE_AUTOBUILD: "1",
      },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("(trust-init-1) FULL init trusts the repo; deinit removes the record", () => {
    const init = cli("init", "--project", repo, "--hosts", "devin", "--profile", "devin");
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /FULL/);
    assert.match(init.stdout, /workspace trust/);
    assert.equal(isWorkspaceTrusted(repo), true);

    const deinit = cli("deinit", "--project", repo);
    assert.equal(deinit.status, 0, deinit.stderr);
    assert.match(deinit.stdout, /workspace trust/);
    assert.equal(hasTrustRecord(repo), false);
  });

  it("(trust-init-2) LIGHT init (blanket mode) trusts the repo too", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".blanket"), "");
    const init = cli("init", "--project", repo, "--hosts", "devin");
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /LIGHT/);
    assert.equal(isWorkspaceTrusted(repo), true);
  });
});
