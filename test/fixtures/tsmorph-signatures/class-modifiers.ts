// Methods with explicit access modifiers + an arrow-function property field.
export class Service {
  public publicMethod(x: number): number {
    return x;
  }

  private privateHelper(): void {
    /* noop */
  }

  protected protectedStep(name: string): string {
    return name;
  }

  // Arrow field — should still register a method node with a signature.
  handler = (n: number): boolean => n > 0;
}
