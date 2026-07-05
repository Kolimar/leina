// sidecar-install.test.ts — prebuilt sidecar download: verify-then-install contract.
// A local HTTP server plays the release host (LEINA_SIDECAR_BASE_URL): the happy path
// places the binary exactly where a local build would; a checksum mismatch or missing
// platform entry installs NOTHING.
// Run: node --no-warnings --experimental-strip-types --test test/sidecar-install.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksumFor,
  installSidecar,
  sidecarArtifactName,
  sidecarBaseUrl,
} from "../src/infrastructure/extractors/semantic/sidecar-install.ts";

// The install path honours $LEINA_HOME through sidecarCacheRoot — sandbox it for the
// whole file (module-scope env mutation, mirrored by every other home-touching test).
const HOME = mkdtempSync(join(tmpdir(), "leina-sidecar-install-"));
process.env.LEINA_HOME = join(HOME, ".leina");

function makeTarball(withBinary: boolean): Buffer {
  // A fake csharp dist: single RoslynGraph executable at the archive root.
  const stage = mkdtempSync(join(tmpdir(), "leina-sidecar-stage-"));
  if (withBinary) {
    const exe = process.platform === "win32" ? "RoslynGraph.exe" : "RoslynGraph";
    writeFileSync(join(stage, exe), "#!/bin/sh\necho fake-sidecar\n");
    chmodSync(join(stage, exe), 0o755);
  } else {
    writeFileSync(join(stage, "README"), "nothing useful");
  }
  const out = join(stage, "..", `tar-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`);
  const r = spawnSync("tar", ["-czf", out, "-C", stage, "."], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const bytes = readFileSync(out);
  rmSync(stage, { recursive: true, force: true });
  rmSync(out, { force: true });
  return bytes;
}

async function serve(files: Record<string, Buffer | string>): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    const key = (req.url ?? "").replace(/^\//, "");
    const body = files[key];
    if (body === undefined) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}`, server };
}

test("(si-1) artifact naming + checksum parsing + base URL override", () => {
  assert.equal(sidecarArtifactName("csharp", "linux", "x64"), "leina-sidecar-csharp-linux-x64.tar.gz");
  assert.equal(sidecarArtifactName("java", "win32", "arm64"), "leina-sidecar-java-win32-arm64.tar.gz");

  const sums = "abc\n" + `${"a".repeat(64)}  leina-sidecar-csharp-linux-x64.tar.gz\n`;
  assert.equal(checksumFor(sums, "leina-sidecar-csharp-linux-x64.tar.gz"), "a".repeat(64));
  assert.equal(checksumFor(sums, "other.tar.gz"), null);

  assert.equal(sidecarBaseUrl({ LEINA_SIDECAR_BASE_URL: "http://x/y/" }), "http://x/y");
  assert.match(sidecarBaseUrl({}), /github\.com\/Kolimar\/leina\/releases\/download\/sidecars-v1/);
});

test("(si-2) happy path: download, verify, unpack to the build's exact location", async () => {
  const artifact = sidecarArtifactName("csharp");
  const tarball = makeTarball(true);
  const sha = createHash("sha256").update(tarball).digest("hex");
  const { base, server } = await serve({
    "checksums.txt": `${sha}  ${artifact}\n`,
    [artifact]: tarball,
  });
  process.env.LEINA_SIDECAR_BASE_URL = base;
  try {
    const res = await installSidecar("csharp", { force: true });
    assert.equal(res.ok, true, res.error);
    assert.ok(existsSync(res.binPath!), "binary placed at builtBinaryPath");
    assert.match(readFileSync(res.binPath!, "utf8"), /fake-sidecar/);

    // Second install without --force is a no-op success (already installed).
    const again = await installSidecar("csharp");
    assert.equal(again.ok, true);
  } finally {
    server.close();
    delete process.env.LEINA_SIDECAR_BASE_URL;
    rmSync(join(process.env.LEINA_HOME!, "sidecars"), { recursive: true, force: true });
  }
});

test("(si-3) checksum mismatch refuses and installs nothing", async () => {
  const artifact = sidecarArtifactName("csharp");
  const tarball = makeTarball(true);
  const { base, server } = await serve({
    "checksums.txt": `${"0".repeat(64)}  ${artifact}\n`,
    [artifact]: tarball,
  });
  process.env.LEINA_SIDECAR_BASE_URL = base;
  try {
    const res = await installSidecar("csharp", { force: true });
    assert.equal(res.ok, false);
    assert.match(res.error!, /checksum mismatch/);
    assert.match(res.error!, /refusing to install/);
  } finally {
    server.close();
    delete process.env.LEINA_SIDECAR_BASE_URL;
    rmSync(join(process.env.LEINA_HOME!, "sidecars"), { recursive: true, force: true });
  }
});

test("(si-4) platform not published → actionable error naming the local-build fallback", async () => {
  const { base, server } = await serve({ "checksums.txt": "" });
  process.env.LEINA_SIDECAR_BASE_URL = base;
  try {
    const res = await installSidecar("csharp", { force: true });
    assert.equal(res.ok, false);
    assert.match(res.error!, /no prebuilt csharp sidecar/);
    assert.match(res.error!, /leina sidecar build csharp/);
  } finally {
    server.close();
    delete process.env.LEINA_SIDECAR_BASE_URL;
  }
});

test("(si-5) archive without the expected binary → error, not a silent bad install", async () => {
  const artifact = sidecarArtifactName("csharp");
  const tarball = makeTarball(false);
  const sha = createHash("sha256").update(tarball).digest("hex");
  const { base, server } = await serve({
    "checksums.txt": `${sha}  ${artifact}\n`,
    [artifact]: tarball,
  });
  process.env.LEINA_SIDECAR_BASE_URL = base;
  try {
    const res = await installSidecar("csharp", { force: true });
    assert.equal(res.ok, false);
    assert.match(res.error!, /did not contain the expected binary/);
  } finally {
    server.close();
    delete process.env.LEINA_SIDECAR_BASE_URL;
    rmSync(join(process.env.LEINA_HOME!, "sidecars"), { recursive: true, force: true });
  }
});

test("(si-6) checksums.txt 404 (release/tag never published) → same actionable advice as an unpublished platform", async () => {
  // No "checksums.txt" key at all → the fake server answers 404, distinct from an
  // empty checksums.txt (si-4, which is a 200 with no matching entry).
  const { base, server } = await serve({});
  process.env.LEINA_SIDECAR_BASE_URL = base;
  try {
    const res = await installSidecar("csharp", { force: true });
    assert.equal(res.ok, false);
    assert.match(res.error!, /no prebuilt csharp sidecar/);
    assert.match(res.error!, /leina sidecar build csharp/);
  } finally {
    server.close();
    delete process.env.LEINA_SIDECAR_BASE_URL;
  }
});

test("(si-7) network unreachable (no HTTP status at all) → distinct message, no build advice", async () => {
  // Point at a closed port on localhost: fetch fails at the connection level, never
  // gets an HTTP response, so no FetchStatusError is thrown — a true network failure.
  process.env.LEINA_SIDECAR_BASE_URL = "http://127.0.0.1:1";
  try {
    const res = await installSidecar("csharp", { force: true });
    assert.equal(res.ok, false);
    assert.match(res.error!, /network unreachable/);
    assert.doesNotMatch(res.error!, /sidecar build/);
  } finally {
    delete process.env.LEINA_SIDECAR_BASE_URL;
  }
});

test.after(() => {
  rmSync(HOME, { recursive: true, force: true });
});
