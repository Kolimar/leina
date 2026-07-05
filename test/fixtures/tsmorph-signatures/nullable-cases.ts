// One function per nullability scenario.

// Return type contains null.
export function findUser(id: string): { id: string } | null {
  return id ? { id } : null;
}

// Parameter type contains undefined (union with undefined).
export function logMaybe(msg: string | undefined): void {
  if (msg) console.log(msg);
}

// Optional parameter via `?:` — nullable (because `?` makes it T | undefined),
// AND optional flag must be true.
export function withOptional(x: number, y?: string): string {
  return y ?? String(x);
}

// Default-valued parameter — optional flag true, but type is NOT nullable.
export function withDefault(x: number, y: string = "fallback"): string {
  return y + String(x);
}
