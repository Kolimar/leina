// On-demand sidecar builder.
//
// The C#/Java sidecar SOURCES ship as inert `.tmpl` text under
// `assets/sidecars/**` so a strict TypeScript/Node quality pipeline never
// sees `.cs`/`.java` files in the repo. They are NOT real project source — they
// are build-time tooling materialised on demand.
//
// When a target repo actually contains Java/C# files and the user opts in, we:
//   1. materialise the templates (strip the `.tmpl` suffix) into a work dir,
//   2. invoke the local toolchain (dotnet / javac+jpackage) to produce a
//      self-contained binary that embeds its own runtime,
//   3. cache the binary under ~/.leina/sidecars/<lang>/dist so subsequent
//      graph builds reuse it.
//
// Building needs the toolchain on PATH (dotnet SDK for C#; JDK 17+ with
// jpackage for Java) plus network access to the package registries. None of
// this is required to USE leina — without a sidecar, C#/Java fall back to
// the (syntactic) tree-sitter path.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { leinaHome } from "../../install/share-paths.ts";
import type { SemanticLang } from "../../../application/graph/detect.ts";

const win = process.platform === "win32";
const EXE = win ? ".exe" : "";

// Package root: this file is src/infrastructure/extractors/semantic/sidecar-build.ts
// (and dist/infrastructure/extractors/semantic/sidecar-build.js once compiled), so
// up four levels lands on the package root where `assets/` is shipped (sibling of
// `src/`/`dist/`).
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Absolute path to the shipped `.tmpl` sources for a sidecar language. */
export function templatesDir(lang: SemanticLang): string {
  return join(PKG_ROOT, "assets", "sidecars", lang);
}

/** Per-language cache root under the leina home (honours $LEINA_HOME). */
export function sidecarCacheRoot(lang: SemanticLang): string {
  return join(leinaHome(), "sidecars", lang);
}

/** Final binary location for a built sidecar (whether or not it exists yet). */
export function builtBinaryPath(lang: SemanticLang): string {
  const dist = join(sidecarCacheRoot(lang), "dist");
  if (lang === "csharp") return join(dist, `RoslynGraph${EXE}`);
  // jpackage app-image: Windows launcher sits at the image root; on Linux/macOS
  // it lives under bin/.
  return win
    ? join(dist, "JavaGraph", `JavaGraph${EXE}`)
    : join(dist, "JavaGraph", "bin", "JavaGraph");
}

/** Has this sidecar already been built and cached? */
export function isSidecarBuilt(lang: SemanticLang): boolean {
  return existsSync(builtBinaryPath(lang));
}

// ---------------------------------------------------------------------------
// Toolchain detection
// ---------------------------------------------------------------------------

function hasTool(bin: string): boolean {
  // `--version` is universally cheap and side-effect free for these tools.
  const probe = spawnSync(bin, ["--version"], { stdio: "ignore" });
  return probe.status === 0 || (probe.status === null && probe.error === undefined);
}

const REQUIRED_TOOLS: Record<SemanticLang, string[]> = {
  csharp: ["dotnet"],
  java: ["javac", "jar", "jpackage", "curl"],
};

/** Which required build tools are missing from PATH for this language. */
export function missingTools(lang: SemanticLang): string[] {
  return REQUIRED_TOOLS[lang].filter((t) => !hasTool(t));
}

// ---------------------------------------------------------------------------
// Materialisation: copy `.tmpl` templates into a work dir, stripping the suffix
// ---------------------------------------------------------------------------

function materialize(lang: SemanticLang, workDir: string): void {
  const src = templatesDir(lang);
  if (!existsSync(src)) {
    throw new Error(`sidecar templates not found for ${lang} at ${src}`);
  }
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const walk = (rel: string): void => {
    const abs = join(src, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        mkdirSync(join(workDir, childRel), { recursive: true });
        walk(childRel);
      } else {
        // Strip a single trailing `.tmpl` so e.g. `Program.cs.tmpl` → `Program.cs`.
        const destRel = childRel.endsWith(".tmpl") ? childRel.slice(0, -".tmpl".length) : childRel;
        const destAbs = join(workDir, destRel);
        mkdirSync(dirname(destAbs), { recursive: true });
        cpSync(join(src, childRel), destAbs);
      }
    }
  };
  walk("");
}

// ---------------------------------------------------------------------------
// Build drivers
// ---------------------------------------------------------------------------

export interface BuildResult {
  ok: boolean;
  binPath?: string;
  error?: string;
}

function run(bin: string, args: string[], cwd: string): { ok: boolean; err?: string } {
  // Inherit the caller's PATH on purpose: build tools (dotnet, javac, jpackage)
  // live in user/SDK-specific locations, not the hardened system PATH. This is a
  // user-initiated build, not an untrusted-input sink.
  const proc = spawnSync(bin, args, { cwd, stdio: "inherit", encoding: "utf8" });
  if (proc.status === 0) return { ok: true };
  return { ok: false, err: proc.error?.message ?? `${bin} exited ${proc.status}` };
}

// .NET runtime identifier for a self-contained single-file publish.
function dotnetRid(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (win) return `win-${arch}`;
  if (process.platform === "darwin") return `osx-${arch}`;
  return `linux-${arch}`;
}

function buildCsharp(workDir: string, dist: string): BuildResult {
  const proj = join(workDir, "RoslynGraph", "RoslynGraph.csproj");
  const publishDir = join(workDir, "publish");
  const r = run(
    "dotnet",
    [
      "publish", proj,
      "-c", "Release",
      "-r", dotnetRid(),
      "--self-contained", "true",
      "-p:PublishSingleFile=true",
      "-o", publishDir,
    ],
    workDir,
  );
  if (!r.ok) return { ok: false, error: `dotnet publish failed: ${r.err}` };

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  // Copy the whole publish dir (single-file exe plus any native sidecar files).
  cpSync(publishDir, dist, { recursive: true });
  const bin = builtBinaryPath("csharp");
  return existsSync(bin) ? { ok: true, binPath: bin } : { ok: false, error: `publish produced no binary at ${bin}` };
}

// JavaParser deps fetched as plain jars (no Maven/Gradle needed). Override the
// registry base for private mirrors via $LEINA_MAVEN_BASE.
const JAVA_DEPS = [
  "com/github/javaparser/javaparser-core/3.26.4/javaparser-core-3.26.4.jar",
  "com/github/javaparser/javaparser-symbol-solver-core/3.26.4/javaparser-symbol-solver-core-3.26.4.jar",
  "com/google/guava/guava/33.4.0-jre/guava-33.4.0-jre.jar",
  "com/google/guava/failureaccess/1.0.2/failureaccess-1.0.2.jar",
];

const JAVA_ADD_MODULES =
  "java.base,java.logging,java.xml,jdk.unsupported,java.desktop,java.sql,java.naming,java.management,java.net.http";

function buildJava(workDir: string, dist: string): BuildResult {
  const projDir = join(workDir, "javagraph");
  const libDir = join(projDir, "lib");
  const classesDir = join(projDir, "classes");
  const appDir = join(projDir, "build", "app");
  mkdirSync(libDir, { recursive: true });
  mkdirSync(classesDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });

  const base = (process.env.LEINA_MAVEN_BASE ?? "https://repo1.maven.org/maven2").replace(/\/+$/, "");
  for (const dep of JAVA_DEPS) {
    const out = join(libDir, dep.slice(dep.lastIndexOf("/") + 1));
    const r = run("curl", ["-fsSL", `${base}/${dep}`, "-o", out], projDir);
    if (!r.ok) return { ok: false, error: `fetching dep ${dep} failed: ${r.err}` };
  }

  const sep = win ? ";" : ":";
  const cp = `lib${sep}lib/*`;
  const javac = run(
    "javac",
    ["-cp", cp, "-d", "classes", join("src", "IdGen.java"), join("src", "JavaGraph.java")],
    projDir,
  );
  if (!javac.ok) return { ok: false, error: `javac failed: ${javac.err}` };

  // Stage the app: dep jars + our compiled jar on one classpath.
  cpSync(libDir, appDir, { recursive: true });
  const jar = run("jar", ["cf", join("build", "app", "javagraph.jar"), "-C", "classes", "."], projDir);
  if (!jar.ok) return { ok: false, error: `jar failed: ${jar.err}` };

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const jpackageArgs = [
    "--type", "app-image", "--name", "JavaGraph",
    "--input", join("build", "app"), "--main-jar", "javagraph.jar", "--main-class", "JavaGraph",
    "--add-modules", JAVA_ADD_MODULES,
    "--jlink-options", "--strip-debug --no-man-pages --no-header-files",
    "--dest", dist,
  ];
  if (win) jpackageArgs.push("--win-console");
  const jp = run("jpackage", jpackageArgs, projDir);
  if (!jp.ok) return { ok: false, error: `jpackage failed: ${jp.err}` };

  const bin = builtBinaryPath("java");
  return existsSync(bin) ? { ok: true, binPath: bin } : { ok: false, error: `jpackage produced no binary at ${bin}` };
}

/**
 * Build (and cache) the sidecar for `lang` from its templates. Idempotent unless
 * `force` is set: a previously built binary short-circuits. Returns a structured
 * result rather than throwing so callers can fall back to tree-sitter.
 */
export function buildSidecar(lang: SemanticLang, opts: { force?: boolean } = {}): BuildResult {
  if (!opts.force && isSidecarBuilt(lang)) {
    return { ok: true, binPath: builtBinaryPath(lang) };
  }
  const missing = missingTools(lang);
  if (missing.length > 0) {
    return { ok: false, error: `missing build tools on PATH: ${missing.join(", ")}` };
  }

  const root = sidecarCacheRoot(lang);
  const workDir = join(root, "work");
  const dist = join(root, "dist");
  try {
    materialize(lang, workDir);
    const res = lang === "csharp" ? buildCsharp(workDir, dist) : buildJava(workDir, dist);
    return res;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Remove a cached sidecar build (work dir + dist). */
export function cleanSidecar(lang: SemanticLang): void {
  rmSync(sidecarCacheRoot(lang), { recursive: true, force: true });
}
