// cli/handlers/serve.ts — `leina graph serve [<dir>] [--port <n>] [--host <h>]` handler
// (task 3.6). Foreground `node:http` server over the read-only JSON API (cli/serve/*):
// opens the given project through the same freshness gate every other read command uses,
// self-registers into the global project registry (design §1 — build/refresh/serve/init
// all upsert), then listens until Ctrl+C.

import { createServer } from "node:http";
import { join, resolve as resolvePath } from "node:path";
import { openFreshStore, memOpenGuarded } from "../wiring.ts";
import { loadServeConfig } from "../../infrastructure/config/serve.ts";
import { deriveProjectKey } from "../../application/project/detect-key.ts";
import { recordProject } from "../../infrastructure/config/project-registry-store.ts";
import { entryAssetsRootFrom } from "../../infrastructure/install/global.ts";
import { createRouter } from "../serve/router.ts";
import { optFlag } from "../args.ts";
import { fail } from "../io.ts";

// NFR-02: bind strictly to loopback — a configured/flagged non-loopback host must be
// refused outright rather than silently accepted (a public bind would expose the whole
// project's graph + memory over plain HTTP with no TLS).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Best-effort self-registration into ~/.leina/projects.json — never blocks startup. */
function recordProjectServe(root: string): void {
  try {
    const projectKey = deriveProjectKey(root).key;
    recordProject({ projectKey, root, lastBuild: Date.now() });
  } catch {
    // bookkeeping only — an ambiguous project key must not stop `serve` from starting
  }
}

export async function handleServe(rest: string[]): Promise<void> {
  const dirArg = rest.find((a) => !a.startsWith("--")) ?? ".";
  const root = resolvePath(dirArg);

  // Freshness gate — identical contract to affected/path/query/visualize: fresh → open
  // as-is, stale+auto → rebuild then open, stale+refuse → instruct and exit, missing →
  // instruct and exit. We don't keep this store open: the router opens (and closes) a
  // store per request, uniformly for the default project and every other registered one.
  const gateStore = await openFreshStore(root);
  gateStore.close();

  // Fail fast on a broken/ambiguous memory setup rather than let every single
  // /nodes/:id/memories request 500 one at a time. Also surfaces the LIKE-mode warning
  // (FTS5 unavailable) up front, same as every other memory-touching command.
  const gateMem = memOpenGuarded(root);
  gateMem.close();

  recordProjectServe(root);

  const config = loadServeConfig(root);
  const portFlag = optFlag(rest, "--port", undefined);
  const hostFlag = optFlag(rest, "--host", undefined);
  const port = portFlag !== undefined ? Number(portFlag) : config.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be an integer in [0,65535], got "${portFlag}"`);
  const host = hostFlag ?? config.host;

  if (!LOOPBACK_HOSTS.has(host)) {
    fail(
      `refusing to bind graph serve to non-loopback host "${host}" (NFR-02) — ` +
        `use 127.0.0.1, ::1 or localhost.`,
    );
  }

  const assetsRoot = join(entryAssetsRootFrom(process.argv[1] ?? "."), "graph-ui");
  const listener = createRouter({ token: config.token, assetsRoot });
  const server = createServer(listener);

  // A single persistent error handler: while starting up it rejects the listen promise
  // (bad port, EADDRINUSE, etc. → clean failure message); once running it just logs, so a
  // stray per-connection error can never crash this long-lived foreground process.
  let started = false;
  server.on("error", (err) => {
    if (!started) return; // handled by the listen() promise below
    process.stderr.write(`leina graph serve: server error: ${err.message}\n`);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      started = true;
      resolveListen();
    });
  }).catch((err: unknown) => {
    fail(`graph serve failed to start: ${err instanceof Error ? err.message : String(err)}`);
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
  console.log(`leina graph serve: http://${host}:${actualPort}  (read-only, Ctrl+C to stop)`);

  // Foreground until Ctrl+C — NFR-02: SIGINT must release the port cleanly, no zombie.
  // server.close() alone only stops accepting new connections and waits for EXISTING
  // ones to end on their own — a keep-alive client (browser, curl --keepalive, fetch's
  // connection pooling) could hold the process open well past the user's Ctrl+C.
  // closeAllConnections() forces every open socket shut immediately, so shutdown is
  // prompt and deterministic regardless of what's still connected.
  await new Promise<void>((resolveShutdown) => {
    process.once("SIGINT", () => {
      server.close(() => resolveShutdown());
      server.closeAllConnections();
    });
  });
}
