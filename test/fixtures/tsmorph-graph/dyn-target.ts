// Target of dynamic imports and local renames (B1).
export function runTask(name: string): string {
  return name;
}

export function stopTask(): void {}

export const tools = { runTask };
