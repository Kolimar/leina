// test/e2e-workspace-memory-cli.test.ts
//
// E2E tests for `workspace memory context` and `workspace memory search` CLI
// commands on a real workspace with ≥2 repos (CRIT-2 regression guard).
//
// These tests MUST FAIL without the fix in wiring.ts (where deriveProjectKey was called
// on the workspace root, throwing AmbiguousProjectError for every workspace) and PASS
// with it (deriveWorkspaceRootKey skips the child-git-auto step).
//
// The test creates a temporary workspace with:
//   ws-root/
//     workspace.json    ← forces workspace mode
//     repo-alpha/       ← git init + package.json name "@acme/alpha"
//     repo-beta/        ← git init + package.json name "@acme/beta"
//
// Seeds one memory observation per repo key via the `memory save` CLI (to have
// something to search for), then exercises:
//   workspace memory context   <wsRoot>
//   workspace memory search    <wsRoot> acme
//
// Both commands must exit 0 (no crash) and produce federated output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {},
): RunResult {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", env: opts.env ?? process.env, input: opts.input },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function initGitRepo(dir: string): void {
  try {
    spawnSync("git", ["init"], { cwd: dir, stdio: "pipe" });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  } catch {
    // git may not be available in all CI environments — silently skip
  }
}

/** Create an isolated workspace fixture: wsRoot + 2 child git repos + workspace.json. */
function createWorkspaceFixture(): { wsRoot: string; home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "leina-ws-mem-home-"));
  const wsRoot = mkdtempSync(join(tmpdir(), "leina-ws-mem-ws-"));

  // workspace.json → forces workspace mode detection
  writeFileSync(join(wsRoot, "workspace.json"), JSON.stringify({}), "utf8");

  // repo-alpha
  const alphaDir = join(wsRoot, "repo-alpha");
  mkdirSync(join(alphaDir, "src"), { recursive: true });
  initGitRepo(alphaDir);
  writeFileSync(
    join(alphaDir, "package.json"),
    JSON.stringify({ name: "@acme/alpha", version: "1.0.0" }),
    "utf8",
  );
  writeFileSync(
    join(alphaDir, "src", "index.ts"),
    'export function alphaFn(): void { console.log("alpha"); }\n',
    "utf8",
  );

  // repo-beta
  const betaDir = join(wsRoot, "repo-beta");
  mkdirSync(join(betaDir, "src"), { recursive: true });
  initGitRepo(betaDir);
  writeFileSync(
    join(betaDir, "package.json"),
    JSON.stringify({ name: "@acme/beta", version: "1.0.0" }),
    "utf8",
  );
  writeFileSync(
    join(betaDir, "src", "index.ts"),
    'export function betaFn(): void { console.log("beta"); }\n',
    "utf8",
  );

  return {
    wsRoot,
    home,
    cleanup: () => {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(wsRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// (CRIT-2-e2e-1) workspace memory context — must not crash on 2-repo workspace
// ---------------------------------------------------------------------------

test(
  "(CRIT-2-e2e-1) workspace memory context does not crash with AmbiguousProjectError on 2-repo workspace",
  () => {
    const { wsRoot, home, cleanup } = createWorkspaceFixture();
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, LEINA_HOME: home };

      // Seed one observation to the workspace key (derived from wsRoot basename).
      // We use `memory save <wsRoot>` — the wiring will derive the workspace key
      // via deriveWorkspaceRootKey, which must NOT throw.
      // NOTE: seeding is optional for the crash test; the command must still exit 0
      // even with an empty memory store.

      const r = runCli(["workspace", "memory", "context", wsRoot], { env });

      assert.equal(
        r.code,
        0,
        `Expected exit 0 but got ${r.code}.\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );

      // Must not mention AmbiguousProjectError in stderr
      assert.ok(
        !r.stderr.includes("AmbiguousProjectError"),
        `AmbiguousProjectError must not appear in stderr. Got: ${r.stderr}`,
      );
      assert.ok(
        !r.stderr.includes("ambiguous project"),
        `'ambiguous project' must not appear in stderr. Got: ${r.stderr}`,
      );
    } finally {
      cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// (CRIT-2-e2e-2) workspace memory search — federated search on 2-repo workspace
// ---------------------------------------------------------------------------

test(
  "(CRIT-2-e2e-2) workspace memory search returns federated results across 2 repos without crashing",
  () => {
    const { wsRoot, home, cleanup } = createWorkspaceFixture();
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, LEINA_HOME: home };

      // Seed observations to each child repo's individual key using memory save.
      // repo-alpha key: "repo-alpha" (basename-derived), repo-beta key: "repo-beta"
      const alphaDir = join(wsRoot, "repo-alpha");
      const betaDir = join(wsRoot, "repo-beta");

      const saveAlpha = runCli(
        [
          "memory", "save", alphaDir,
          "--title", "alpha circuit breaker design",
          "--content", "alpha uses circuit breaker pattern for resilience",
          "--type", "architecture",
        ],
        { env },
      );
      assert.equal(
        saveAlpha.code,
        0,
        `memory save on repo-alpha failed. stderr: ${saveAlpha.stderr}`,
      );

      const saveBeta = runCli(
        [
          "memory", "save", betaDir,
          "--title", "beta retry strategy",
          "--content", "beta uses exponential backoff for retry logic",
          "--type", "architecture",
        ],
        { env },
      );
      assert.equal(
        saveBeta.code,
        0,
        `memory save on repo-beta failed. stderr: ${saveBeta.stderr}`,
      );

      // Now run federated search on the workspace root — must NOT crash
      const r = runCli(["workspace", "memory", "search", wsRoot, "circuit"], { env });

      assert.equal(
        r.code,
        0,
        `Expected exit 0 for workspace memory search but got ${r.code}.\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );

      // Must not mention AmbiguousProjectError
      assert.ok(
        !r.stderr.includes("AmbiguousProjectError"),
        `AmbiguousProjectError must not appear in stderr. Got: ${r.stderr}`,
      );

      // Should find the alpha observation (contains "circuit")
      assert.ok(
        r.stdout.includes("circuit") || r.stdout.includes("alpha"),
        `Expected federated hit for "circuit" in stdout. Got: ${r.stdout}`,
      );
    } finally {
      cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// (CRIT-2-e2e-3) workspace memory context with seeded observations shows them
// ---------------------------------------------------------------------------

test(
  "(CRIT-2-e2e-3) workspace memory context shows seeded observations from member repos",
  () => {
    const { wsRoot, home, cleanup } = createWorkspaceFixture();
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, LEINA_HOME: home };

      const alphaDir = join(wsRoot, "repo-alpha");
      const betaDir = join(wsRoot, "repo-beta");

      // Seed to alpha
      runCli(
        [
          "memory", "save", alphaDir,
          "--title", "alpha resilience pattern",
          "--content", "alpha service uses resilience4j circuit breaker",
          "--type", "decision",
        ],
        { env },
      );

      // Seed to beta
      runCli(
        [
          "memory", "save", betaDir,
          "--title", "beta deployment strategy",
          "--content", "beta uses canary deployment via feature flags",
          "--type", "decision",
        ],
        { env },
      );

      // workspace memory context must exit 0 and include observations from both repos
      const r = runCli(["workspace", "memory", "context", wsRoot], { env });

      assert.equal(
        r.code,
        0,
        `Expected exit 0 but got ${r.code}.\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );

      // Must not mention AmbiguousProjectError
      assert.ok(
        !r.stderr.includes("AmbiguousProjectError"),
        `AmbiguousProjectError must not appear in stderr. Got: ${r.stderr}`,
      );

      // Federated context must show at least one observation from alpha or beta
      const combined = r.stdout + r.stderr;
      assert.ok(
        combined.includes("alpha") || combined.includes("beta"),
        `Expected federated observations from alpha or beta in output.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
    } finally {
      cleanup();
    }
  },
);
