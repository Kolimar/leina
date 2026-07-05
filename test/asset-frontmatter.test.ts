// asset-frontmatter.test.ts — schema gate for bundled asset frontmatter (WS2).
//
// Every SKILL.md and agent .md that ships in assets/ must parse with the shared
// frontmatter parser and satisfy the minimal schema below. This is the CI tripwire
// that keeps the 35 assets from drifting back into mixed licenses, list-vs-string
// allowed-tools, or name/path mismatches. Asset↔catalog coverage lives in
// catalog.test.ts (cat-a*); this file owns frontmatter shape only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../src/application/install/frontmatter.ts";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const SKILLS = join(ASSETS, "skills");
const AGENTS = join(ASSETS, "agents");

function skillDirs(): string[] {
  return readdirSync(SKILLS).filter((e) => statSync(join(SKILLS, e)).isDirectory());
}

function agentFiles(): string[] {
  return readdirSync(AGENTS).filter((e) => e.endsWith(".md"));
}

test("(fm-s1) every SKILL.md parses and its name matches the directory", () => {
  const violations: string[] = [];
  for (const dir of skillDirs()) {
    const raw = readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8");
    const { meta } = parseFrontmatter(raw);
    if (Object.keys(meta).length === 0) violations.push(`${dir}: no frontmatter block`);
    else if (meta.name !== dir) violations.push(`${dir}: name "${meta.name}" ≠ dir`);
  }
  assert.deepEqual(violations, []);
});

test("(fm-s2) every SKILL.md has a non-empty description", () => {
  const violations: string[] = [];
  for (const dir of skillDirs()) {
    const { meta } = parseFrontmatter(readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8"));
    if (!meta.description?.trim()) violations.push(`${dir}: empty/missing description`);
  }
  assert.deepEqual(violations, []);
});

test("(fm-s3) skill licenses are uniform MIT (the package license)", () => {
  const violations: string[] = [];
  for (const dir of skillDirs()) {
    const { meta } = parseFrontmatter(readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8"));
    if (meta.license !== "MIT") violations.push(`${dir}: license "${meta.license ?? "(none)"}"`);
  }
  assert.deepEqual(violations, []);
});

test("(fm-s4) allowed-tools, when present, is a single-line comma-separated value", () => {
  // A YAML list form parses to an empty string with the flat parser — exactly the
  // ambiguity this gate rejects: two syntaxes for the same field across skills.
  const violations: string[] = [];
  for (const dir of skillDirs()) {
    const { meta } = parseFrontmatter(readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8"));
    if ("allowed-tools" in meta && !meta["allowed-tools"]?.trim()) {
      violations.push(`${dir}: allowed-tools uses YAML-list form (use "a, b, c")`);
    }
  }
  assert.deepEqual(violations, []);
});

test("(fm-a1) every agent .md parses, name matches filename, description non-empty", () => {
  const violations: string[] = [];
  for (const file of agentFiles()) {
    const base = file.slice(0, -3);
    const { meta } = parseFrontmatter(readFileSync(join(AGENTS, file), "utf8"));
    if (Object.keys(meta).length === 0) violations.push(`${file}: no frontmatter block`);
    if (meta.name !== base) violations.push(`${file}: name "${meta.name}" ≠ filename`);
    if (!meta.description?.trim()) violations.push(`${file}: empty/missing description`);
  }
  assert.deepEqual(violations, []);
});

test("(fm-a2) agent model, when present, is a bare model id", () => {
  const violations: string[] = [];
  for (const file of agentFiles()) {
    const { meta } = parseFrontmatter(readFileSync(join(AGENTS, file), "utf8"));
    if (meta.model !== undefined && !/^[a-z][\w-]*$/.test(meta.model)) {
      violations.push(`${file}: model "${meta.model}"`);
    }
  }
  assert.deepEqual(violations, []);
});
