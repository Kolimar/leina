// test/mocks/fake-agent-runner.ts — Helper for end-to-end Devin hook sequence tests.
//
// FakeAgentRunner wraps the real leina CLI: it creates a temporary project directory
// initialised with `leina init` (so the scope guard recognises it), then runs
// `devin-hook <event>` invocations via spawnSync using the same pattern as
// test/devin-hook-cli.test.ts.
//
// NOTE: No parameter properties (--experimental-strip-types compatibility).
// Run: node --no-warnings --experimental-strip-types --test test/mocks/fake-agent-runner.test.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Step {
  event: string;
  payload: object;
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// FakeAgentRunner
// ---------------------------------------------------------------------------

export class FakeAgentRunner {
  readonly dir: string;

  // Private: use static create() to obtain an instance.
  private constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Create a new FakeAgentRunner backed by a fresh temporary directory that
   * has been initialised with `leina init` so the scope guard inside
   * runAgentGate recognises it as a leina project.
   *
   * The temporary directory is created under os.tmpdir(). Call cleanup() when done.
   */
  static create(): FakeAgentRunner {
    const dir = mkdtempSync(join(tmpdir(), "cg-fake-agent-"));
    // Initialise the project (writes .devin/hooks.v1.json, AGENTS.md, .gitignore).
    // Suppress autobuild and home writes so tests stay sandboxed.
    const init = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        CLI,
        "init",
        "--project",
        dir,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LEINA_DISABLE_AUTOBUILD: "1",
          HOME: dir,
          USERPROFILE: dir,
          // Isolate memory so the runner uses the project-local DB only.
          LEINA_HOME: dir,
        },
      },
    );
    if (init.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`FakeAgentRunner.create: leina init failed (${init.stderr})`);
    }
    return new FakeAgentRunner(dir);
  }

  /**
   * Run a single devin-hook event against the project directory.
   * Payload is serialised to JSON and piped on stdin (same as the real Devin host).
   * The environment strips DEVIN_PROJECT_DIR so the hook resolves its root from cwd.
   */
  run(event: string, payload: object, env?: Record<string, string>): HookResult {
    const input = JSON.stringify(payload);
    const baseEnv = { ...process.env };
    delete baseEnv.DEVIN_PROJECT_DIR;

    const r = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        CLI,
        "devin-hook",
        event,
      ],
      {
        cwd: this.dir,
        input,
        encoding: "utf8",
        env: env ? { ...baseEnv, ...env } : baseEnv,
      },
    );
    return {
      code: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  /**
   * Run a sequence of steps in order.
   * Returns one HookResult per step, in the same order.
   */
  runSequence(steps: Step[]): HookResult[] {
    return steps.map((step) => this.run(step.event, step.payload, step.env));
  }

  /**
   * Remove the temporary project directory.
   */
  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
