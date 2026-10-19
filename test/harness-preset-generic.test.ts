// harness-preset-generic.test.ts — the rule presets (recipes.ts): the
// `generic` preset must carry ZERO leina-coupled rules (nothing that requires
// running a leina command), `leina-native` must be generic + exactly the
// leina-* suite, and the generated `.harness/config.json` for `generic` must
// actually disable those rules when resolved by the real resolver.
//
// Run: node --no-warnings --experimental-strip-types --test test/harness-preset-generic.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  RULE_PRESETS,
  isLeinaCoupledRuleId,
  isRulePreset,
  presetConfig,
  presetRuleIds,
  presetRuleOverrides,
} from "../src/application/harness/recipes.ts";
import { loadResolvedRules } from "../src/application/harness/resolver.ts";
import { makeTmpRepo, isolateLeinaHome, type TmpRepo } from "./helpers/harness-tmprepo.ts";

/** The rule NAME (id slug) — the finding's contract is about the `leina-` name prefix. */
function slugOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

describe("rule presets — shape", () => {
  it("exposes exactly the two presets: generic and leina-native", () => {
    assert.deepEqual([...RULE_PRESETS].sort(), ["generic", "leina-native"]);
    assert.equal(isRulePreset("generic"), true);
    assert.equal(isRulePreset("leina-native"), true);
    assert.equal(isRulePreset("full"), false);
  });

  it("generic includes NO rule whose name starts with 'leina-'", async () => {
    const ids = await presetRuleIds("generic");
    assert.ok(ids.length > 0, "generic preset must not be empty");
    const leinaCoupled = ids.filter((id) => slugOf(id).startsWith("leina-"));
    assert.deepEqual(leinaCoupled, [], `generic preset leaked leina-coupled rules: ${leinaCoupled.join(", ")}`);
  });

  it("generic still includes the generic value rules (tests-pass, no-secrets, diff-in-scope)", async () => {
    const ids = await presetRuleIds("generic");
    for (const expected of ["harness/tests-pass", "harness/no-secrets", "harness/diff-in-scope"]) {
      assert.ok(ids.includes(expected), `generic preset must include ${expected} (got: ${ids.join(", ")})`);
    }
  });

  it("leina-native = generic + exactly the leina-coupled rules", async () => {
    const generic = new Set(await presetRuleIds("generic"));
    const native = await presetRuleIds("leina-native");
    const extras = native.filter((id) => !generic.has(id));

    // Everything leina-native adds over generic is leina-coupled — nothing else.
    assert.ok(extras.length > 0, "leina-native must add the leina-coupled rules");
    for (const id of extras) {
      assert.ok(isLeinaCoupledRuleId(id), `leina-native extra "${id}" is not leina-coupled`);
    }
    // The four rules the harness ships today are all present (new leina-* rules may join).
    for (const expected of [
      "harness/leina-graph-consult",
      "harness/leina-graph-fresh",
      "harness/leina-memory-first",
      "harness/leina-session-summary",
    ]) {
      assert.ok(extras.includes(expected), `leina-native must include ${expected}`);
    }
  });
});

describe("rule presets — generated config", () => {
  it("presetConfig('leina-native') is the pristine `{}` seed", async () => {
    assert.equal(await presetConfig("leina-native"), "{}\n");
    assert.deepEqual(await presetRuleOverrides("leina-native"), {});
  });

  it("presetConfig('generic') disables every leina-coupled builtin rule and nothing else", async () => {
    const config = JSON.parse(await presetConfig("generic")) as {
      rules?: Record<string, { enabled?: boolean }>;
    };
    const rules = config.rules ?? {};
    const disabledIds = Object.keys(rules).sort();

    assert.ok(disabledIds.length > 0, "generic config must disable the leina-coupled rules");
    for (const id of disabledIds) {
      assert.ok(isLeinaCoupledRuleId(id), `generic config disables non-leina rule "${id}"`);
      assert.equal(rules[id]?.enabled, false, `override for ${id} must be enabled:false`);
    }

    // The disabled set is exactly the delta between the two presets.
    const generic = new Set(await presetRuleIds("generic"));
    const delta = (await presetRuleIds("leina-native")).filter((id) => !generic.has(id)).sort();
    assert.deepEqual(disabledIds, delta);
  });
});

describe("rule presets — resolved through the real resolver", () => {
  let repo: TmpRepo;
  let restoreHome: () => void;

  beforeEach(async () => {
    repo = await makeTmpRepo(false); // fs-only — resolution never needs git
    restoreHome = isolateLeinaHome(path.join(repo.root, "no-user-config"));
  });

  afterEach(async () => {
    restoreHome();
    await repo.cleanup();
  });

  it("with the generic config, no ENABLED resolved rule has a leina- name", async () => {
    await repo.write(".harness/config.json", await presetConfig("generic"));
    const resolution = await loadResolvedRules(repo.root);
    assert.deepEqual(resolution.errors, [], resolution.errors.join("; "));

    const enabledLeina = resolution.rules
      .filter((r) => r.enabled && slugOf(r.id).startsWith("leina-"))
      .map((r) => r.id);
    assert.deepEqual(enabledLeina, [], `generic preset left leina rules enabled: ${enabledLeina.join(", ")}`);

    // And the generic value rules survive enabled.
    const enabled = new Set(resolution.rules.filter((r) => r.enabled).map((r) => r.id));
    assert.ok(enabled.has("harness/tests-pass"));
    assert.ok(enabled.has("harness/no-secrets"));
  });

  it("with the leina-native config ({}), the leina rules stay enabled (the historical default)", async () => {
    await repo.write(".harness/config.json", await presetConfig("leina-native"));
    const resolution = await loadResolvedRules(repo.root);
    assert.deepEqual(resolution.errors, [], resolution.errors.join("; "));

    const enabled = new Set(resolution.rules.filter((r) => r.enabled).map((r) => r.id));
    assert.ok(enabled.has("harness/leina-memory-first"), "leina-native must keep leina-memory-first enabled");
    assert.ok(enabled.has("harness/leina-graph-fresh"), "leina-native must keep leina-graph-fresh enabled");
  });
});
