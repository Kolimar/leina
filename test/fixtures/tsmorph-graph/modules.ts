// Module dependencies (B5): re-export, type-only import, import-equals, dynamic import.
export { runTask } from "./dyn-target";
import type { Store } from "./contracts";
import kinds = require("./data-kinds");
import { readFileSync } from "node:fs";

export async function later(s: Store): Promise<number> {
  const mod = await import("./data-default");
  const name = "./collisions";
  await import(name);
  if (s.load("x") === "") readFileSync("x");
  return mod.default(kinds.LIMIT);
}
