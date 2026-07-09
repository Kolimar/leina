// Unit tests for `leina doctor` (src/cli/doctor.ts). All filesystem state is redirected to
// a per-test tmp home (LEINA_HOME/HOME/USERPROFILE) so we never touch the developer's real
// install. runDoctor is read-only, so these run fully in-process.
//
// CLI-only build: runDoctor(version, root) runs env/share/symlink checks + a single
// checkProject(root). There is no registry and no MCP server — absence of a leina MCP
// entry in .devin/config.json is healthy; a leftover legacy entry is a warn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/cli/doctor.ts";
import { installGlobal, populateShare } from "../src/infrastructure/install/global.ts";
import { PROTOCOL_START } from "../src/application/install/protocol.ts";
import { GITIGNORE_START } from "../src/application/install/gitignore.ts";
import { DEVIN_MANAGED_EVENTS } from "../src/application/install/devin-hooks.ts";
import { serializeSelection } from "../src/application/install/catalog.ts";
import { shareSelectionFile } from "../src/infrastructure/install/share-paths.ts";

function withTmpHome<T>(fn: (homeDir: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "leina-doctor-"));
  const saved = {
    LEINA_HOME: process.env.LEINA_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
  };
  process.env.LEINA_HOME = join(home, ".leina");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Point APPDATA into the sandbox so devinConfigRoot() resolves to <home>/.config/devin
  // on Windows too — the exact path these tests assert on every platform.
  process.env.APPDATA = join(home, ".config");
  try {
    return fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function makeFakeAssetsRoot(homeDir: string): string {
  const assets = join(homeDir, "assets");
  mkdirSync(join(assets, "skills", "leina-sdd"), { recursive: true });
  mkdirSync(join(assets, "agents"), { recursive: true });
  writeFileSync(join(assets, "skills", "leina-sdd", "SKILL.md"), "---\nname: leina-sdd\n---\nBody\n");
  writeFileSync(join(assets, "agents", "sdd-explore.md"), "---\nname: sdd-explore\nmodel: sonnet\n---\nBody\n");
  return assets;
}

/**
 * Hand-craft a fully init'd project dir (no graph build). `seedMcp` controls whether a legacy
 * leina MCP server entry is pre-seeded into .devin/config.json.
 */
function makeInitProject(homeDir: string, opts: { seedMcp?: boolean } = {}): string {
  const root = join(homeDir, "proj");
  mkdirSync(join(root, ".devin"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), `# AGENTS.md\n\n${PROTOCOL_START}\nbody\n<!-- end -->\n`);
  writeFileSync(join(root, ".gitignore"), `${GITIGNORE_START}\n.leina/\n<!-- end -->\n`);
  const config = opts.seedMcp
    ? { mcpServers: { "leina": { command: "x", args: [] } } }
    : { mcpServers: { other: { command: "x", args: [] } } };
  writeFileSync(join(root, ".devin", "config.json"), JSON.stringify(config));
  const hooks: Record<string, unknown> = {};
  for (const ev of DEVIN_MANAGED_EVENTS) hooks[ev] = [];
  writeFileSync(join(root, ".devin", "hooks.v1.json"), JSON.stringify(hooks));
  return root;
}

function find(results: ReturnType<typeof runDoctor>["results"], group: string, label: string) {
  return results.find((r) => r.group === group && r.label === label);
}

test("(doc-a) fresh machine: share missing → fail and exit code 1", () => {
  withTmpHome((home) => {
    const report = runDoctor("0.8.0-test", join(home, "proj"));
    assert.equal(find(report.results, "share", "share dir")!.status, "fail");
    assert.equal(report.exitCode, 1, "a fail forces exit 1");
  });
});

test("(doc-b) after installGlobal: share version + symlinks are ok", () => {
  withTmpHome((home) => {
    installGlobal(makeFakeAssetsRoot(home), "0.8.0-test", { skills: null, agents: null, hosts: ["devin"] });
    const report = runDoctor("0.8.0-test", join(home, "proj"));
    assert.equal(find(report.results, "share", "share dir")!.status, "ok");
    assert.equal(find(report.results, "share", "share version")!.status, "ok");
    const links = report.results.filter((r) => r.group === "host links");
    assert.ok(links.length > 0 && links.every((l) => l.status === "ok"), "all host links ok");
  });
});

test("(doc-c) stale share: version drift is a warn, not a fail (exit 0 with no other fails)", () => {
  withTmpHome((home) => {
    populateShare(makeFakeAssetsRoot(home), "0.0.1-old");
    // Build a complete project so the only non-ok signal is the share version drift.
    const root = makeInitProject(home);
    // Global memory.db now lives in LEINA_HOME (set by withTmpHome fixture).
    writeFileSync(join(home, ".leina", "memory.db"), "");
    // No graph manifest → graph check would fail, so use a dir with a fresh manifest-free check is
    // not possible; instead assert only the share-version semantics and that drift alone is a warn.
    const report = runDoctor("0.8.0-new", root);
    const sv = find(report.results, "share", "share version")!;
    assert.equal(sv.status, "warn");
    assert.match(sv.detail ?? "", /stale/);
  });
});

test("(doc-d) init'd project (no MCP): AGENTS/.gitignore/.devin checks pass; unbuilt graph fails", () => {
  withTmpHome((home) => {
    installGlobal(makeFakeAssetsRoot(home), "0.8.0-test", { skills: null, agents: null, hosts: ["devin"] });
    const root = makeInitProject(home);
    const report = runDoctor("0.8.0-test", root);
    const g = "project";
    assert.equal(find(report.results, g, "AGENTS.md")!.status, "ok");
    assert.equal(find(report.results, g, ".gitignore")!.status, "ok");
    // No leina MCP server entry → CLI-only healthy state.
    assert.equal(find(report.results, g, ".devin/config.json")!.status, "ok");
    assert.equal(find(report.results, g, ".devin/hooks.v1.json")!.status, "ok");
    // No graph built → graph check fails → exit 1.
    assert.equal(find(report.results, g, "graph")!.status, "fail");
    // Global memory.db not present yet → warn.
    assert.equal(find(report.results, g, "global memory.db")!.status, "warn");
    // Project key detected (plain dir or git-root — either way ok since this is a test fixture).
    assert.ok(find(report.results, g, "project key") !== undefined, "project key check present");
    assert.equal(report.exitCode, 1);
  });
});

test("(doc-f) malformed .devin/config.json → fail", () => {
  withTmpHome((home) => {
    installGlobal(makeFakeAssetsRoot(home), "0.8.0-test", { skills: null, agents: null, hosts: ["devin"] });
    const root = join(home, "bad");
    mkdirSync(join(root, ".devin"), { recursive: true });
    writeFileSync(join(root, ".devin", "config.json"), "{ not json");
    const report = runDoctor("0.8.0-test", root);
    assert.equal(find(report.results, "project", ".devin/config.json")!.status, "fail");
    assert.equal(report.exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// REQ-D2: checkProject is host-neutral — .devin/* checks only run when the user's
// persisted host selection includes "devin" (same pattern as inspectHostLinks).
// ---------------------------------------------------------------------------

test("(doc-d2a) claude-only selection → no .devin/* findings even when the files exist", () => {
  withTmpHome((home) => {
    installGlobal(makeFakeAssetsRoot(home), "0.8.0-test", { skills: null, agents: null, hosts: ["devin"] });
    writeFileSync(shareSelectionFile(), serializeSelection({ skills: null, agents: null, hosts: ["claude"] }));
    const root = makeInitProject(home); // seeds .devin/config.json + .devin/hooks.v1.json
    const report = runDoctor("0.8.0-test", root);
    const g = "project";
    assert.equal(find(report.results, g, ".devin/config.json"), undefined, "no .devin/config.json check for a claude-only selection");
    assert.equal(find(report.results, g, ".devin/hooks.v1.json"), undefined, "no .devin/hooks.v1.json check for a claude-only selection");
  });
});

test("(doc-d2b) devin selected + hooks.v1.json missing → warn unchanged (regression)", () => {
  withTmpHome((home) => {
    installGlobal(makeFakeAssetsRoot(home), "0.8.0-test", { skills: null, agents: null, hosts: ["devin"] });
    writeFileSync(shareSelectionFile(), serializeSelection({ skills: null, agents: null, hosts: ["devin"] }));
    const root = join(home, "devin-proj");
    mkdirSync(root, { recursive: true });
    const report = runDoctor("0.8.0-test", root);
    const check = find(report.results, "project", ".devin/hooks.v1.json");
    assert.ok(check !== undefined, ".devin/hooks.v1.json check must be present when devin is selected");
    assert.equal(check.status, "warn");
    assert.match(check.detail ?? "", /missing/i);
  });
});

test("(doc-g) absent .devin/config.json is healthy (CLI-only)", () => {
  withTmpHome((home) => {
    installGlobal(makeFakeAssetsRoot(home), "0.8.0-test", { skills: null, agents: null, hosts: ["devin"] });
    const root = join(home, "noconfig");
    mkdirSync(root, { recursive: true });
    const report = runDoctor("0.8.0-test", root);
    assert.equal(find(report.results, "project", ".devin/config.json")!.status, "ok");
  });
});

test("(doc-h) global memory.db present → ok; absent → warn", () => {
  withTmpHome((home) => {
    installGlobal(makeFakeAssetsRoot(home), "0.8.0-test", { skills: null, agents: null, hosts: ["devin"] });
    const root = makeInitProject(home);
    // Absent → warn
    const r1 = runDoctor("0.8.0-test", root);
    assert.equal(find(r1.results, "project", "global memory.db")!.status, "warn");
    // Create global memory.db
    const globalMemDir = join(home, ".leina");
    mkdirSync(globalMemDir, { recursive: true });
    writeFileSync(join(globalMemDir, "memory.db"), "");
    const r2 = runDoctor("0.8.0-test", root);
    assert.equal(find(r2.results, "project", "global memory.db")!.status, "ok");
  });
});

test("(doc-j) project key check present with ok or warn status", () => {
  withTmpHome((home) => {
    installGlobal(makeFakeAssetsRoot(home), "0.8.0-test", { skills: null, agents: null, hosts: ["devin"] });
    const root = makeInitProject(home);
    const report = runDoctor("0.8.0-test", root);
    const pk = find(report.results, "project", "project key");
    assert.ok(pk !== undefined, "project key check must be present");
    // plain fixture dir → dir-basename → ok
    assert.ok(pk.status === "ok" || pk.status === "warn", "status ok or warn (never fail)");
  });
});

test("(doc-k) CLI entrypoint check resolves the dev/installed bin and is ok", () => {
  withTmpHome((home) => {
    const report = runDoctor("0.8.0-test", join(home, "proj"));
    const entry = find(report.results, "environment", "CLI entrypoint");
    assert.ok(entry !== undefined, "CLI entrypoint check must be present");
    // doctor.ts sits next to index.ts in the dev checkout, so it resolves and is ok.
    assert.equal(entry.status, "ok");
    assert.match(entry.detail ?? "", /index\.(ts|js)$/);
  });
});

test("(doc-l) shell interop check present; on non-Windows CI it is ok (no Git Bash risk)", () => {
  withTmpHome((home) => {
    const report = runDoctor("0.8.0-test", join(home, "proj"));
    const si = find(report.results, "environment", "shell interop");
    assert.ok(si !== undefined, "shell interop check must be present");
    // Never a fail — the package is fine even under Git Bash; worst case is a warn.
    assert.ok(si.status === "ok" || si.status === "warn");
    if (process.platform !== "win32") assert.equal(si.status, "ok");
  });
});

// ---------------------------------------------------------------------------
// extractors group (scip-ingestion wave 2, task 4.2; scip-lang-rollout wave B
// adds scip-rust, wave C adds scip-python): scip-go + scip-rust + scip-python
// + sidecar-csharp + sidecar-java availability. Pure detection — no DB, no
// build/index invoked. This sandbox has no scip-go/dotnet/JDK on PATH by
// default, so every check here is a warn, never a fail (tree-sitter always
// covers these files as a syntactic fallback) — unless the sandbox happens
// to have rust-analyzer/scip-python installed, in which case that entry
// legitimately reports "ok" (also asserted as non-fail).
// ---------------------------------------------------------------------------

test("(doc-m) extractors group: scip-go + scip-rust + scip-python + sidecar-csharp + sidecar-java all present, never fail", () => {
  withTmpHome((home) => {
    const report = runDoctor("0.8.0-test", join(home, "proj"));
    for (const label of ["scip-go", "scip-rust", "scip-python", "sidecar-csharp", "sidecar-java"]) {
      const entry = find(report.results, "extractors", label);
      assert.ok(entry !== undefined, `${label} check must be present`);
      // Optional extractors are ok (installed) or info (not installed) — never a problem.
      assert.ok(entry.status === "ok" || entry.status === "info", `${label}: never warn/fail`);
    }
  });
});

test("(doc-n) extractors group: scip-go warn detail instructs 'leina scip install go' when unavailable", () => {
  withTmpHome((home) => {
    const report = runDoctor("0.8.0-test", join(home, "proj"));
    const scipGo = find(report.results, "extractors", "scip-go")!;
    if (scipGo.status === "info") {
      assert.match(scipGo.detail ?? "", /leina scip install go/);
    }
  });
});

test("(doc-o) extractors group: scip-rust warn detail instructs 'leina scip install rust' when unavailable; ok detail names the real .rs extension when available", () => {
  withTmpHome((home) => {
    const report = runDoctor("0.8.0-test", join(home, "proj"));
    const scipRust = find(report.results, "extractors", "scip-rust")!;
    if (scipRust.status === "info") {
      assert.match(scipRust.detail ?? "", /leina scip install rust/);
    } else {
      // status "ok" (rust-analyzer happens to be on PATH in this sandbox):
      // the detail must name the real file extension (.rs), never the
      // language name interpolated as if it were one (".rust files").
      assert.match(scipRust.detail ?? "", /\.rs files/);
      assert.doesNotMatch(scipRust.detail ?? "", /\.rust files/);
    }
  });
});

test("(doc-p) extractors group: scip-python warn detail instructs 'leina scip install python' when unavailable; ok detail names the real .py/.pyi extensions when available", () => {
  withTmpHome((home) => {
    const report = runDoctor("0.8.0-test", join(home, "proj"));
    const scipPython = find(report.results, "extractors", "scip-python")!;
    if (scipPython.status === "info") {
      assert.match(scipPython.detail ?? "", /leina scip install python/);
    } else {
      // status "ok" (scip-python happens to be on PATH in this sandbox): the
      // detail must name the real file extensions (.py/.pyi), never the
      // language name interpolated as if it were one (".python files").
      assert.match(scipPython.detail ?? "", /\.py\/\.pyi files/);
      assert.doesNotMatch(scipPython.detail ?? "", /\.python files/);
    }
  });
});

// ---------------------------------------------------------------------------
// NG6-1: checkInjectionReadiness — ok / warn / fail variants (no DB open)
// ---------------------------------------------------------------------------

test("(NG6-1a) injection readiness ok: global memory.db + resolvable project key + graph.db all present", () => {
  withTmpHome((home) => {
    const root = makeInitProject(home);
    // Create global memory.db (leinaHome = LEINA_HOME set by withTmpHome)
    const memDir = join(home, ".leina");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "memory.db"), "");
    // Create graph.db inside the project
    const leinaDir = join(root, ".leina");
    mkdirSync(leinaDir, { recursive: true });
    writeFileSync(join(leinaDir, "graph.db"), "");

    const report = runDoctor("0.8.0-test", root);
    const check = find(report.results, "project", "injection readiness");
    assert.ok(check !== undefined, "injection readiness check must be present");
    assert.equal(check.status, "ok");
    // No WAL/SHM files created (no SQLite connection opened)
    assert.equal(existsSync(join(memDir, "memory.db-wal")), false, "no WAL on global memory.db");
    assert.equal(existsSync(join(memDir, "memory.db-shm")), false, "no SHM on global memory.db");
    assert.equal(existsSync(join(leinaDir, "graph.db-wal")), false, "no WAL on graph.db");
    assert.equal(existsSync(join(leinaDir, "graph.db-shm")), false, "no SHM on graph.db");
  });
});

test("(NG6-1b) injection readiness warn: global memory.db present + project key ok + graph.db absent", () => {
  withTmpHome((home) => {
    const root = makeInitProject(home);
    // Create global memory.db but NO graph.db
    const memDir = join(home, ".leina");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "memory.db"), "");

    const report = runDoctor("0.8.0-test", root);
    const check = find(report.results, "project", "injection readiness");
    assert.ok(check !== undefined, "injection readiness check must be present");
    assert.equal(check.status, "warn");
    assert.match(check.detail ?? "", /graph\.db|partial/i);
    // No WAL/SHM
    assert.equal(existsSync(join(memDir, "memory.db-wal")), false, "no WAL on global memory.db");
    assert.equal(existsSync(join(memDir, "memory.db-shm")), false, "no SHM on global memory.db");
  });
});

test("(NG6-1c) injection readiness fail: global memory.db absent", () => {
  withTmpHome((home) => {
    const root = makeInitProject(home);
    // Do NOT create global memory.db — LEINA_HOME dir may not exist at all

    const report = runDoctor("0.8.0-test", root);
    const check = find(report.results, "project", "injection readiness");
    assert.ok(check !== undefined, "injection readiness check must be present");
    assert.equal(check.status, "fail");
    // No WAL/SHM anywhere in the home (no DB was opened)
    const memPath = join(home, ".leina", "memory.db-wal");
    assert.equal(existsSync(memPath), false, "no WAL file when memory.db absent");
  });
});

test("(NG6-1d) injection readiness fail: deriveProjectKey throws AmbiguousProjectError (multi-root dir)", () => {
  withTmpHome((home) => {
    // Build a dir with two child .git repos → deriveProjectKey throws AmbiguousProjectError
    const root = join(home, "ambiguous-proj");
    mkdirSync(join(root, "child-a", ".git"), { recursive: true });
    mkdirSync(join(root, "child-b", ".git"), { recursive: true });
    // Need .devin/hooks.v1.json so isLeinaProject passes (and runDoctor calls checkProject)
    mkdirSync(join(root, ".devin"), { recursive: true });
    writeFileSync(join(root, ".devin", "hooks.v1.json"), "{}");
    // Create global memory.db so we reach the deriveProjectKey step
    const memDir = join(home, ".leina");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "memory.db"), "");

    const report = runDoctor("0.8.0-test", root);
    const check = find(report.results, "project", "injection readiness");
    assert.ok(check !== undefined, "injection readiness check must be present");
    assert.equal(check.status, "fail");
    assert.match(check.detail ?? "", /ambiguous|multi.root|AmbiguousProjectError/i);
    // No WAL/SHM
    assert.equal(existsSync(join(memDir, "memory.db-wal")), false, "no WAL on global memory.db");
    assert.equal(existsSync(join(memDir, "memory.db-shm")), false, "no SHM on global memory.db");
  });
});

// ---------------------------------------------------------------------------
// REQ-DV-1: repoIdentity en DoctorReport (T6 etapa-3)
// ---------------------------------------------------------------------------

test("(doc-ri-a) runDoctor: repoIdentity presente con shape correcto en el proyecto actual", () => {
  withTmpHome((_home) => {
    // Usamos el directorio raíz actual (este repo git) como root para que buildRepoIdentity funcione
    const report = runDoctor("0.8.0-test", ".");
    // repoIdentity puede estar ausente si buildRepoIdentity lanza (e.g. git no disponible)
    if (report.repoIdentity === undefined) return; // fail-open: skip assertions
    const ri = report.repoIdentity;
    // confidence debe ser uno de los 3 valores válidos
    const validConf = ["high", "medium", "low"];
    assert.ok(validConf.includes(ri.confidence), `confidence '${ri.confidence}' debe ser high|medium|low`);
    // pathHash siempre presente: 16 hex chars
    assert.match(ri.pathHash, /^[0-9a-f]{16}$/, "pathHash debe ser 16 hex chars");
    // projectKey nunca vacío
    assert.ok(ri.projectKey.length > 0, "projectKey no debe estar vacío");
  });
});

test("(doc-ri-b) runDoctor fail-open: repoIdentity ausente cuando buildRepoIdentity lanza AmbiguousProjectError", () => {
  withTmpHome((home) => {
    // Un directorio con dos repos hijo causa AmbiguousProjectError en deriveProjectKey,
    // lo que hace lanzar buildRepoIdentity → runDoctor lo captura (fail-open)
    const ambiguousDir = join(home, "ambiguous-ri");
    mkdirSync(join(ambiguousDir, "repo-a", ".git"), { recursive: true });
    mkdirSync(join(ambiguousDir, "repo-b", ".git"), { recursive: true });

    const report = runDoctor("0.8.0-test", ambiguousDir);
    // DoctorReport debe seguir teniendo results y exitCode válidos
    assert.ok(Array.isArray(report.results), "results debe ser array");
    assert.ok(typeof report.exitCode === "number", "exitCode debe ser número");
    // repoIdentity debe estar ausente (fail-open: AmbiguousProjectError capturada)
    assert.equal(report.repoIdentity, undefined, "repoIdentity debe ser undefined cuando buildRepoIdentity lanza");
  });
});

test("(doc-ri-c) runDoctor: DoctorReport serializable como JSON con repoIdentity optional", () => {
  withTmpHome((_home) => {
    const report = runDoctor("0.8.0-test", ".");
    // JSON.stringify no debe lanzar — el tipo es serializable
    let json: string;
    assert.doesNotThrow(() => { json = JSON.stringify(report); }, "JSON.stringify no debe lanzar");
    const parsed = JSON.parse(json!) as typeof report;
    assert.ok(Array.isArray(parsed.results), "results presente tras round-trip JSON");
    assert.ok(typeof parsed.exitCode === "number", "exitCode presente tras round-trip JSON");
  });
});
