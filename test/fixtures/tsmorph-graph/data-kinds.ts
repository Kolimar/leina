// Declaration kinds with nodes besides classes, interfaces and functions (B4).
export type Status = "open" | "closed";

export enum Color {
  Red,
  Green,
}

export const LIMIT = 10;

export const SAVE_RE = /save/;

export const User = { kind: "user" };
export type User = typeof User;

export const handlers = {
  build(input: string): string {
    return input.trim();
  },
  query: (q: string): number => q.length,
};

export class Account {
  #balance = 0;
  get balance(): number {
    return this.#balance;
  }
  set balance(v: number) {
    this.#balance = v;
  }
}
