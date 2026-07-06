// `leina graph serve` config: port, bind host and optional auth token.
//
// Resolution precedence per key: env LEINA_SERVE_PORT/_HOST/_TOKEN > .leina/config.json
// "serve" key > defaults (port 7423, host 127.0.0.1, no token). Cloned from
// freshness.ts: `coerce*()` never throws, an invalid/missing value at one tier simply
// falls through to the next. NFR-02 (strict loopback bind) is enforced by the HTTP
// server itself (wave 3.4/3.6), not here — this module only resolves configuration.

import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

export interface ServeConfig {
  port: number;
  host: string;
  /** Absent when no token is configured — the server then skips auth entirely (FR-05). */
  token?: string;
}

const ENV_PORT = "LEINA_SERVE_PORT";
const ENV_HOST = "LEINA_SERVE_HOST";
const ENV_TOKEN = "LEINA_SERVE_TOKEN";

const DEFAULT_PORT = 7423;
const DEFAULT_HOST = "127.0.0.1";

function coercePort(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function coerceHost(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function coerceToken(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

interface ServeConfigFile {
  port?: unknown;
  host?: unknown;
  token?: unknown;
}

function fromConfigFile(root: string): ServeConfigFile {
  try {
    const p = join(resolvePath(root), ".leina", "config.json");
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { serve?: ServeConfigFile };
    return parsed.serve ?? {};
  } catch {
    return {};
  }
}

export function loadServeConfig(root: string): ServeConfig {
  const file = fromConfigFile(root);
  const port = coercePort(process.env[ENV_PORT]) ?? coercePort(file.port) ?? DEFAULT_PORT;
  const host = coerceHost(process.env[ENV_HOST]) ?? coerceHost(file.host) ?? DEFAULT_HOST;
  const token = coerceToken(process.env[ENV_TOKEN]) ?? coerceToken(file.token);
  const config: ServeConfig = { port, host };
  // Null-check to decide whether a token was configured at all — not a secret-vs-secret
  // comparison (the actual request-time token check, NFR-02, must use a constant-time
  // compare in the HTTP layer).
  // eslint-disable-next-line security/detect-possible-timing-attacks
  if (token !== null) config.token = token;
  return config;
}
