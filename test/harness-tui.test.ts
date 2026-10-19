// harness-tui.test.ts — building blocks del flow TUI "armar arnés". El TUI en
// sí es interactivo (tui-cli.test.ts cubre el contrato sin TTY); aquí se
// testean las piezas NO interactivas que el flow compone: la partición de
// reglas fijas/ajustables, el cálculo de overrides de enabled, el writer
// merge-safe de `.harness/config.json`, las sugerencias extraídas de recetas,
// las proyecciones textuales y el helper compartido createContract (misma
// ruta de código que `leina harness contract new`); y el flow armado completo
// con prompts guionados (__setPromptsForTests): nada se escribe sin confirmar.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-tui.test.ts

import { afterEach, beforeEach, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { type Rule, type TaskContract } from "../src/domain/harness/model.ts";
import { type VerifyReport } from "../src/application/harness/gates/report.ts";
import {
  computeEnabledOverrides,
  contractSummary,
  mergeRuleOverridesIntoConfig,
  recipeSuggestions,
  splitAdjustableRules,
  verifyReportLines,
} from "../src/application/harness/tui-support.ts";
import { createContract } from "../src/cli/handlers/harness.ts";
import { __setPromptsForTests, harnessArmFlow } from "../src/cli/handlers/tui.ts";
import { loadRecipes } from "../src/application/harness/recipes.ts";
import { isolateLeinaHome, makeTmpRepo, type TmpRepo } from "./helpers/harness-tmprepo.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRule(overrides: Partial<Rule> & { id: string }): Rule {
  return {
    version: 1,
    phase: "verify",
    severity: "blocking",
    scope: {},
    enabled: true,
    tags: [],
    body: "",
    sourcePath: `/rules/${overrides.id.replace("/", "-")}.md`,
    layer: "builtin",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// splitAdjustableRules — blocking activas = fijas; el resto es ajustable.
// ---------------------------------------------------------------------------

describe("splitAdjustableRules", () => {
  it("marks enabled blocking rules as fixed and everything else as adjustable", () => {
    const rules = [
      makeRule({ id: "harness/tests-pass", enabled: true, severity: "blocking" }),
      makeRule({ id: "harness/lint-clean", enabled: false, severity: "blocking" }),
      makeRule({ id: "harness/changelog-updated", enabled: false, severity: "advisory" }),
      makeRule({ id: "project/style", enabled: true, severity: "advisory" }),
    ];
    const { fixed, adjustable } = splitAdjustableRules(rules);
    assert.deepEqual(fixed.map((r) => r.id), ["harness/tests-pass"]);
    assert.deepEqual(
      adjustable.map((r) => r.id),
      ["harness/lint-clean", "harness/changelog-updated", "project/style"],
    );
  });

  it("empty input → empty split", () => {
    assert.deepEqual(splitAdjustableRules([]), { fixed: [], adjustable: [] });
  });
});

// ---------------------------------------------------------------------------
// computeEnabledOverrides — solo diffs, nunca redundancia.
// ---------------------------------------------------------------------------

describe("computeEnabledOverrides", () => {
  const adjustable = [
    makeRule({ id: "harness/lint-clean", enabled: false, severity: "blocking" }),
    makeRule({ id: "harness/changelog-updated", enabled: false, severity: "advisory" }),
    makeRule({ id: "project/style", enabled: true, severity: "advisory" }),
  ];

  it("selecting a disabled rule → { enabled: true }; deselecting an enabled one → { enabled: false }", () => {
    const overrides = computeEnabledOverrides(adjustable, ["harness/lint-clean"]);
    assert.deepEqual(overrides, {
      "harness/lint-clean": { enabled: true },
      "project/style": { enabled: false },
    });
  });

  it("selection matching the current state produces no overrides", () => {
    assert.deepEqual(computeEnabledOverrides(adjustable, ["project/style"]), {});
  });
});

// ---------------------------------------------------------------------------
// mergeRuleOverridesIntoConfig — writer merge-safe del config.json de proyecto.
// ---------------------------------------------------------------------------

describe("mergeRuleOverridesIntoConfig", () => {
  it("null/empty input seeds a fresh config with only the rules key", () => {
    const next = mergeRuleOverridesIntoConfig(null, { "harness/lint-clean": { enabled: true } });
    assert.ok(next !== null);
    assert.deepEqual(JSON.parse(next), { rules: { "harness/lint-clean": { enabled: true } } });
    assert.ok(next.endsWith("\n"), "trailing newline");
  });

  it("preserves unrelated top-level keys, other rules and per-rule fields", () => {
    const existing = JSON.stringify({
      $schema: "x",
      defaultBranch: "trunk",
      rules: {
        "harness/tests-pass": { severity: "blocking", enabled: true },
        "harness/lint-clean": { severity: "advisory" },
      },
    });
    const next = mergeRuleOverridesIntoConfig(existing, { "harness/lint-clean": { enabled: true } });
    assert.ok(next !== null);
    const parsed = JSON.parse(next);
    assert.equal(parsed.defaultBranch, "trunk");
    assert.equal(parsed.$schema, "x");
    assert.deepEqual(parsed.rules["harness/tests-pass"], { severity: "blocking", enabled: true });
    // Field-level merge: adding `enabled` must not wipe the existing `severity`.
    assert.deepEqual(parsed.rules["harness/lint-clean"], { severity: "advisory", enabled: true });
  });

  it("never clobbers malformed or non-object JSON (returns null)", () => {
    assert.equal(mergeRuleOverridesIntoConfig("{ not json", { "a/b": { enabled: true } }), null);
    assert.equal(mergeRuleOverridesIntoConfig("[1,2]", { "a/b": { enabled: true } }), null);
    assert.equal(mergeRuleOverridesIntoConfig('"str"', { "a/b": { enabled: true } }), null);
  });
});

// ---------------------------------------------------------------------------
// recipeSuggestions — precarga de scope/criterios desde el cuerpo de la receta.
// ---------------------------------------------------------------------------

describe("recipeSuggestions", () => {
  it("extracts --scope and --criterion values from the contract-new command line", () => {
    const body =
      'Declare: `leina harness contract new --goal "Add x" --type feature ' +
      '--scope "src/routes/**" --scope "test/**" --criterion "endpoint returns expected shape" ' +
      '--criterion "error cases covered by tests"`\nthen work.';
    assert.deepEqual(recipeSuggestions(body), {
      scope: ["src/routes/**", "test/**"],
      criteria: ["endpoint returns expected shape", "error cases covered by tests"],
    });
  });

  it("deduplicates and tolerates bodies without suggestions", () => {
    assert.deepEqual(recipeSuggestions('--scope "a/**" --scope "a/**"').scope, ["a/**"]);
    assert.deepEqual(recipeSuggestions("no flags here"), { scope: [], criteria: [] });
  });

  it("finds suggestions in every builtin recipe that declares a taskType", async () => {
    const { recipes, errors } = await loadRecipes(path.join(import.meta.dirname, "fixtures-does-not-exist"));
    assert.deepEqual(errors, []);
    const typed = recipes.filter((r) => r.taskType !== undefined);
    assert.ok(typed.length >= 2, "builtin recipes present");
    for (const recipe of typed) {
      const s = recipeSuggestions(recipe.body);
      assert.ok(s.scope.length > 0, `${recipe.name}: scope suggestions`);
      assert.ok(s.criteria.length > 0, `${recipe.name}: criteria suggestions`);
    }
  });
});

// ---------------------------------------------------------------------------
// Proyecciones textuales
// ---------------------------------------------------------------------------

describe("contractSummary / verifyReportLines", () => {
  it("contractSummary shows goal, tipo, scope and per-criterion state", () => {
    const contract: TaskContract = {
      goal: "meta visible",
      taskType: "feature",
      scope: ["src/**"],
      outOfScope: ["docs/**"],
      criteria: [
        { text: "c1", done: true },
        { text: "c2", done: false },
      ],
      maxRetries: 3,
    };
    const text = contractSummary(contract);
    assert.match(text, /goal: meta visible/);
    assert.match(text, /tipo: feature/);
    assert.match(text, /scope: src\/\*\*/);
    assert.match(text, /fuera de scope: docs\/\*\*/);
    assert.match(text, /\[x\] c1/);
    assert.match(text, /\[ \] c2/);
  });

  it("contractSummary flags an empty scope explicitly", () => {
    const text = contractSummary({ goal: "g", scope: [], outOfScope: [], criteria: [], maxRetries: 3 });
    assert.match(text, /scope: \(vacío/);
  });

  it("verifyReportLines renders one compact line per gate plus the summary", () => {
    const report: VerifyReport = {
      schemaVersion: 1,
      phases: ["verify"],
      startedAt: new Date().toISOString(),
      durationMs: 5,
      results: [
        {
          ruleId: "harness/tests-pass",
          phase: "verify",
          severity: "blocking",
          gateType: "command",
          gateIndex: 0,
          durationMs: 3,
          status: "pass",
          detail: "exit 0",
        },
        {
          ruleId: "harness/no-secrets",
          phase: "verify",
          severity: "blocking",
          gateType: "diff-content",
          gateIndex: 0,
          durationMs: 2,
          status: "fail",
          detail: "added line matches forbidden pattern",
        },
      ],
      summary: {
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        errors: 0,
        blockingFailures: 1,
        advisoryFailures: 0,
      },
    };
    const lines = verifyReportLines(report);
    assert.match(lines[0] ?? "", /✔ harness\/tests-pass \[command\] \(blocking\)$/);
    assert.match(lines[1] ?? "", /✘ harness\/no-secrets \[diff-content\].*forbidden pattern/);
    assert.match(lines.at(-1) ?? "", /1 ok · 1 fallo\(s\) \(1 bloqueante\(s\)\) · 0 omitido\(s\)/);
  });

  it("verifyReportLines handles an empty report", () => {
    const report: VerifyReport = {
      schemaVersion: 1,
      phases: ["verify"],
      startedAt: new Date().toISOString(),
      durationMs: 0,
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, blockingFailures: 0, advisoryFailures: 0 },
    };
    assert.match(verifyReportLines(report)[0] ?? "", /ningún gate aplicable/);
  });
});

// ---------------------------------------------------------------------------
// createContract — el helper compartido CLI/TUI, sobre un repo git efímero.
// ---------------------------------------------------------------------------

describe("createContract (shared CLI/TUI path)", () => {
  let repo: TmpRepo;
  let restoreHome: () => void;

  beforeEach(async () => {
    repo = await makeTmpRepo();
    restoreHome = isolateLeinaHome(path.join(repo.root, "no-user-config"));
    await repo.write("src/app.ts", "export const app = 1;\n");
    repo.git("add", ".");
    repo.git("commit", "-m", "init");
  });

  afterEach(async () => {
    restoreHome();
    await repo.cleanup();
  });

  it("creates contract.json + checklist.md with the git base ref", async () => {
    const result = await createContract(repo.root, {
      goal: "armar arnés desde el TUI",
      taskType: "feature",
      scope: ["src/**"],
      outOfScope: ["docs/**"],
      criteria: ["c1", "c2"],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.contract.maxRetries, 3, "default max retries");
    assert.match(result.contract.baseRef ?? "", /^[0-9a-f]{40}$/);

    const onDisk = JSON.parse(await fs.readFile(path.join(repo.root, ".harness/state/current/contract.json"), "utf8"));
    assert.equal(onDisk.goal, "armar arnés desde el TUI");
    assert.deepEqual(onDisk.scope, ["src/**"]);
    assert.deepEqual(onDisk.outOfScope, ["docs/**"]);
    assert.equal(onDisk.criteria.length, 2);

    const checklist = await fs.readFile(path.join(repo.root, ".harness/state/current/checklist.md"), "utf8");
    assert.match(checklist, /- \[ \] c1/);
    assert.match(checklist, /- \[ \] c2/);
  });

  it("refuses to clobber an active contract and returns it", async () => {
    await createContract(repo.root, { goal: "first" });
    const second = await createContract(repo.root, { goal: "second" });
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.match(second.error, /already active/);
    assert.equal(second.active?.goal, "first");
  });

  it("rejects an empty goal and an unknown task type", async () => {
    const noGoal = await createContract(repo.root, { goal: "   " });
    assert.equal(noGoal.ok, false);
    if (!noGoal.ok) assert.match(noGoal.error, /requires --goal/);

    const badType = await createContract(repo.root, { goal: "g", taskType: "yolo" });
    assert.equal(badType.ok, false);
    if (!badType.ok) assert.match(badType.error, /unknown task type/);
  });

  it("rejects a non-positive maxRetries", async () => {
    const result = await createContract(repo.root, { goal: "g", maxRetries: 0 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /--max-retries must be a positive integer/);
  });
});

// ---------------------------------------------------------------------------
// Sanidad: la partición + overrides componen (el camino que recorre el TUI).
// ---------------------------------------------------------------------------

test("TUI composition: split → select → overrides → merged config round-trip", () => {
  const rules = [
    makeRule({ id: "harness/tests-pass", enabled: true, severity: "blocking" }),
    makeRule({ id: "harness/lint-clean", enabled: false, severity: "blocking" }),
    makeRule({ id: "harness/changelog-updated", enabled: false, severity: "advisory" }),
  ];
  const { fixed, adjustable } = splitAdjustableRules(rules);
  assert.deepEqual(fixed.map((r) => r.id), ["harness/tests-pass"]);

  // El usuario activa lint-clean y deja changelog-updated apagada.
  const overrides = computeEnabledOverrides(adjustable, ["harness/lint-clean"]);
  const next = mergeRuleOverridesIntoConfig("{}", overrides);
  assert.ok(next !== null);
  assert.deepEqual(JSON.parse(next).rules, { "harness/lint-clean": { enabled: true } });
});

// ---------------------------------------------------------------------------
// harnessArmFlow con prompts guionados: nada se escribe antes de confirmar.
// ---------------------------------------------------------------------------

describe("harnessArmFlow (prompts guionados)", () => {
  let repo: TmpRepo;
  let restoreHome: () => void;

  beforeEach(async () => {
    repo = await makeTmpRepo();
    restoreHome = isolateLeinaHome(path.join(repo.root, "no-user-config"));
    await repo.write("src/app.ts", "export const app = 1;\n");
    repo.git("add", ".");
    repo.git("commit", "-m", "init");
  });

  afterEach(async () => {
    __setPromptsForTests(null);
    restoreHome();
    await repo.cleanup();
  });

  /** Fake @clack/prompts: answers by prompt kind; `confirm` decides the outcome. */
  function scriptedPrompts(confirmAnswer: boolean): void {
    let criteriaAsked = 0;
    const noop = (): void => undefined;
    const fake = {
      isCancel: () => false,
      cancel: noop,
      note: noop,
      log: { info: noop, warn: noop, error: noop, success: noop, message: noop, step: noop },
      text: async ({ message }: { message: string }) => {
        if (message.startsWith("Goal")) return "armar arnés";
        if (message.startsWith("Criterio")) return criteriaAsked++ === 0 ? "el criterio" : "";
        return ""; // scope / fuera de scope: línea vacía termina
      },
      // Tipo "docs": ninguna receta builtin lo declara → sin prompt de receta.
      select: async ({ message }: { message: string }) => (message === "Tipo de tarea" ? "docs" : ""),
      // Invierte la selección inicial → siempre produce overrides de reglas.
      multiselect: async ({ options, initialValues }: { options: { value: string }[]; initialValues?: string[] }) =>
        options.map((o) => o.value).filter((v) => !(initialValues ?? []).includes(v)),
      confirm: async () => confirmAnswer,
    };
    __setPromptsForTests(fake as unknown as Parameters<typeof __setPromptsForTests>[0]);
  }

  it("(tui-arm-1) cancelling at «¿Crear el contrato?» writes nothing — no config overrides, no contract", async () => {
    scriptedPrompts(false);
    await harnessArmFlow(repo.root);
    await assert.rejects(fs.access(path.join(repo.root, ".harness/config.json")), "rule overrides not persisted");
    await assert.rejects(fs.access(path.join(repo.root, ".harness/state/current/contract.json")));
  });

  it("(tui-arm-2) confirming writes the rule overrides and the contract", async () => {
    scriptedPrompts(true);
    await harnessArmFlow(repo.root);
    const config = JSON.parse(await fs.readFile(path.join(repo.root, ".harness/config.json"), "utf8"));
    assert.ok(Object.keys(config.rules ?? {}).length > 0, "overrides persisted after confirmation");
    const contract = JSON.parse(await fs.readFile(path.join(repo.root, ".harness/state/current/contract.json"), "utf8"));
    assert.equal(contract.goal, "armar arnés");
    assert.equal(contract.taskType, "docs");
  });
});
