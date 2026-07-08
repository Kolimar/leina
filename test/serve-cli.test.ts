// serve-cli.test.ts — E2E for `leina graph serve` as an actual CLI command (task 3.6/3.7):
// the `graph` sub-command dispatcher in cli/main.ts, the NFR-02 loopback bind guard, and
// a clean Ctrl+C shutdown (SIGINT releases the port, no zombie process).
// Run: node --no-warnings --experimental-strip-types --test test/serve-cli.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function sandboxEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, LEINA_HOME: join(home, ".leina"), HOME: home, USERPROFILE: home };
}

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    env,
  });
}

test("(sc-1) unknown `graph` sub-command → usage message, exit 1; build/visualize untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-serve-cli-home1-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-serve-cli-proj1-"));
  const env = sandboxEnv(home);
  try {
    const bad = run(env, "graph", "nope");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Usage: leina graph <serve\|gc>/);
    assert.match(bad.stderr, /gc \[--dry-run\]/);

    // build stays a top-level command, not moved under `graph` (design: "visualize intacto").
    const built = run(env, "build", dir);
    assert.equal(built.status, 0, built.stdout + built.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(sc-2) NFR-02: non-loopback --host is refused before the server ever binds", () => {
  const home = mkdtempSync(join(tmpdir(), "leina-serve-cli-home2-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-serve-cli-proj2-"));
  const env = sandboxEnv(home);
  try {
    assert.equal(run(env, "build", dir).status, 0);
    const res = run(env, "graph", "serve", dir, "--host", "0.0.0.0", "--port", "0");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /non-loopback/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(sc-3) `graph serve` prints its URL, serves the API, self-registers, and SIGINT shuts it down cleanly", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-serve-cli-home3-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-serve-cli-proj3-"));
  const env = sandboxEnv(home);
  try {
    const built = run(env, "build", dir);
    assert.equal(built.status, 0, built.stdout + built.stderr);

    const child = spawn(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "graph", "serve", dir, "--port", "0"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );

    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const onData = (chunk: Buffer) => {
        out += chunk.toString("utf8");
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m) {
          child.stdout?.off("data", onData);
          resolve(m[0]);
        }
      };
      child.stdout?.on("data", onData);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`server exited early (code ${code})\n${out}`)));
      setTimeout(() => reject(new Error(`timed out waiting for the listen URL:\n${out}`)), 15_000);
    });

    // The API is actually reachable, read-only, and self-registered `dir`.
    const res = await fetch(`${url}/api/projects`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { projects: { root: string }[] };
    assert.ok(body.projects.some((p) => p.root === dir), "graph serve self-registers its own project");

    // Ctrl+C: SIGINT must release the port without leaving a zombie process.
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.kill("SIGINT");
    });
    // win32 has no POSIX SIGINT for child processes: kill() terminates by signal, so the
    // exit code comes back null (signal-terminated) rather than 0. The observable that
    // matters — the process exited and released the port — holds either way.
    if (process.platform === "win32") assert.ok(exitCode === 0 || exitCode === null, `unexpected exit code ${exitCode}`);
    else assert.equal(exitCode, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(sc-4) `graph serve` serves the explorer UI (wave 5): index/app.js/lib.js/style.css + vendored vis-network", async () => {
  const home = mkdtempSync(join(tmpdir(), "leina-serve-cli-home4-"));
  const dir = mkdtempSync(join(tmpdir(), "leina-serve-cli-proj4-"));
  const env = sandboxEnv(home);
  try {
    const built = run(env, "build", dir);
    assert.equal(built.status, 0, built.stdout + built.stderr);

    const child = spawn(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", CLI, "graph", "serve", dir, "--port", "0"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );

    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const onData = (chunk: Buffer) => {
        out += chunk.toString("utf8");
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m) {
          child.stdout?.off("data", onData);
          resolve(m[0]);
        }
      };
      child.stdout?.on("data", onData);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`server exited early (code ${code})\n${out}`)));
      setTimeout(() => reject(new Error(`timed out waiting for the listen URL:\n${out}`)), 15_000);
    });

    try {
      const index = await fetch(`${url}/`);
      assert.equal(index.status, 200);
      assert.match(index.headers.get("content-type") ?? "", /text\/html/);

      const app = await fetch(`${url}/app.js`);
      assert.equal(app.status, 200);
      assert.match(app.headers.get("content-type") ?? "", /javascript/);

      const lib = await fetch(`${url}/lib.js`);
      assert.equal(lib.status, 200);
      assert.match(lib.headers.get("content-type") ?? "", /javascript/);

      const css = await fetch(`${url}/style.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get("content-type") ?? "", /text\/css/);

      const vis = await fetch(`${url}/vendor/vis-network.min.js`);
      assert.equal(vis.status, 200);
      assert.match(vis.headers.get("content-type") ?? "", /javascript/);
      assert.ok((await vis.text()).length > 1000, "must serve the real vendored bundle, not a stub");
    } finally {
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.kill("SIGINT");
      });
      // win32: kill() terminates by signal → exit code null rather than 0 (see sc-3).
      if (process.platform === "win32") assert.ok(exitCode === 0 || exitCode === null, `unexpected exit code ${exitCode}`);
      else assert.equal(exitCode, 0);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
