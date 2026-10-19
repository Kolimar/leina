// Declarations whose ids collide once case-folded (B3). The first registered
// declaration keeps the plain id; later distinct ones get `:<kind>` appended.
export interface HostSpec {
  id: string;
}

export function hostSpec(id: string): HostSpec | undefined {
  return id ? { id } : undefined;
}

export class Parser {
  parse(): void {
    // no-op
  }
}

export function parser(): Parser {
  return new Parser();
}

export class Factory {
  static create(): Factory {
    return new Factory();
  }

  create(): Factory {
    return Factory.create();
  }
}
