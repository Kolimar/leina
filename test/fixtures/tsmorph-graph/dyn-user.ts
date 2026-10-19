import { tools } from "./dyn-target";

export async function shorthand(): Promise<string> {
  const { runTask } = await import("./dyn-target.ts");
  return runTask("a");
}

export async function renamed(): Promise<void> {
  const { stopTask: halt } = await import("./dyn-target");
  halt();
}

export async function namespaced(): Promise<void> {
  const mod = await import("./dyn-target");
  mod.stopTask();
}

export function aliased(): string {
  const run = tools.runTask;
  const api = { run };
  return api.run("b");
}
