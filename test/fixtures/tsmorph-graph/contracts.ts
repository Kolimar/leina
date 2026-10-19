// Member-level contracts: implemented interface members and overridden base members (B2).
export interface Store {
  load(id: string): string;
  save: (id: string, v: string) => void;
}

export interface AuditedStore extends Store {
  audit(): number;
}

export type Clock = { now(): number };

export abstract class BaseStore {
  abstract load(id: string): string;
  describe(): string {
    return "base";
  }
}

export class MemoryStore extends BaseStore implements AuditedStore {
  load(id: string): string {
    return id;
  }
  save = (id: string, v: string): void => {
    this.load(id + v);
  };
  audit(): number {
    return 1;
  }
  describe(): string {
    return "memory";
  }
  static create(): MemoryStore {
    return new MemoryStore();
  }
}

export class CachedStore extends MemoryStore {
  load(id: string): string {
    return super.load(id);
  }
}

export const systemClock: Clock = {
  now(): number {
    return 0;
  },
};

export const fakeStore = {
  load: (id: string): string => id,
  save(): void {},
} satisfies Store;

export function useStore(s: Store): void {
  s.save("k", s.load("k"));
}
