// readPackageVersion() is the single source of truth for the version the CLI reports and the MCP
// server advertises. Assert it matches package.json so they can never drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPackageVersion } from "../src/version.ts";

test("(ver-a) readPackageVersion returns the version from package.json", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.equal(readPackageVersion(), pkg.version);
  assert.match(readPackageVersion(), /^\d+\.\d+\.\d+/, "looks like a semver");
});
