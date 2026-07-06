// serve-config.test.ts — unit tests for the `graph serve` 3-tier config loader:
// src/infrastructure/config/serve.ts. Mirrors test/freshness.test.ts's structure.
// Run: node --no-warnings --experimental-strip-types --test test/serve-config.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadServeConfig } from "../src/infrastructure/config/serve.ts";

const ENV_PORT = "LEINA_SERVE_PORT";
const ENV_HOST = "LEINA_SERVE_HOST";
const ENV_TOKEN = "LEINA_SERVE_TOKEN";

function withoutEnv<T>(keys: string[], fn: () => T): T {
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "leina-serve-cfg-"));
}

// --- defaults ----------------------------------------------------------------

test("defaults: no env, no config.json → port 7423, host 127.0.0.1, no token", () => {
  const dir = tmpDir();
  try {
    withoutEnv([ENV_PORT, ENV_HOST, ENV_TOKEN], () => {
      const cfg = loadServeConfig(dir);
      assert.equal(cfg.port, 7423);
      assert.equal(cfg.host, "127.0.0.1");
      assert.equal(cfg.token, undefined);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- config.json ---------------------------------------------------------------

test("config.json: serve.port/host/token are honored", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(
      join(dir, ".leina", "config.json"),
      JSON.stringify({ serve: { port: 9000, host: "0.0.0.0", token: "secret" } }),
      "utf8",
    );
    withoutEnv([ENV_PORT, ENV_HOST, ENV_TOKEN], () => {
      const cfg = loadServeConfig(dir);
      assert.equal(cfg.port, 9000);
      assert.equal(cfg.host, "0.0.0.0");
      assert.equal(cfg.token, "secret");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config.json: missing/corrupt file falls back to defaults, never throws", () => {
  const dir = tmpDir();
  try {
    withoutEnv([ENV_PORT, ENV_HOST, ENV_TOKEN], () => {
      assert.doesNotThrow(() => loadServeConfig(dir));
      assert.equal(loadServeConfig(dir).port, 7423);
    });

    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(join(dir, ".leina", "config.json"), "{ not valid json", "utf8");
    withoutEnv([ENV_PORT, ENV_HOST, ENV_TOKEN], () => {
      assert.doesNotThrow(() => loadServeConfig(dir));
      assert.equal(loadServeConfig(dir).port, 7423);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- env overrides -------------------------------------------------------------

test("env: LEINA_SERVE_PORT/_HOST/_TOKEN override config.json", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(
      join(dir, ".leina", "config.json"),
      JSON.stringify({ serve: { port: 9000, host: "0.0.0.0", token: "file-token" } }),
      "utf8",
    );
    const saved = { port: process.env[ENV_PORT], host: process.env[ENV_HOST], token: process.env[ENV_TOKEN] };
    try {
      process.env[ENV_PORT] = "8080";
      process.env[ENV_HOST] = "localhost";
      process.env[ENV_TOKEN] = "env-token";
      const cfg = loadServeConfig(dir);
      assert.equal(cfg.port, 8080);
      assert.equal(cfg.host, "localhost");
      assert.equal(cfg.token, "env-token");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        const key = k === "port" ? ENV_PORT : k === "host" ? ENV_HOST : ENV_TOKEN;
        if (v !== undefined) process.env[key] = v;
        else delete process.env[key];
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env: invalid LEINA_SERVE_PORT falls through to config.json/default, never throws", () => {
  const dir = tmpDir();
  try {
    const saved = process.env[ENV_PORT];
    try {
      process.env[ENV_PORT] = "not-a-port";
      withoutEnv([ENV_HOST, ENV_TOKEN], () => {
        const cfg = loadServeConfig(dir);
        assert.equal(cfg.port, 7423);
      });
    } finally {
      if (saved !== undefined) process.env[ENV_PORT] = saved;
      else delete process.env[ENV_PORT];
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("port bounds: 0 and >65535 are rejected, fall back to default", () => {
  const dir = tmpDir();
  try {
    const saved = process.env[ENV_PORT];
    try {
      for (const bad of ["0", "-1", "70000", "3.5"]) {
        process.env[ENV_PORT] = bad;
        withoutEnv([ENV_HOST, ENV_TOKEN], () => {
          assert.equal(loadServeConfig(dir).port, 7423, `port=${bad} must fall back to default`);
        });
      }
    } finally {
      if (saved !== undefined) process.env[ENV_PORT] = saved;
      else delete process.env[ENV_PORT];
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty-string host/token in config.json are ignored (fall back to default/none)", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, ".leina"), { recursive: true });
    writeFileSync(
      join(dir, ".leina", "config.json"),
      JSON.stringify({ serve: { host: "   ", token: "" } }),
      "utf8",
    );
    withoutEnv([ENV_PORT, ENV_HOST, ENV_TOKEN], () => {
      const cfg = loadServeConfig(dir);
      assert.equal(cfg.host, "127.0.0.1");
      assert.equal(cfg.token, undefined);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
