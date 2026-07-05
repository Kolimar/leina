// Single source of truth for the running package version. Resolved relative to this file so it
// works in dev (.ts) and built (.js) layouts alike (this module lives one level under the package
// root, next to dist/). Used by the CLI and the doctor command so they never drift from
// package.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function readPackageVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg: unknown = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8"));
    if (
      pkg &&
      typeof pkg === "object" &&
      "version" in pkg &&
      typeof (pkg).version === "string"
    ) {
      return (pkg as { version: string }).version;
    }
  } catch {
    // fall through
  }
  return "0.0.0-unknown";
}
