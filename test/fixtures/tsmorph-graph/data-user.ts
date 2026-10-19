import double from "./data-default";
import { Account, Color, handlers, LIMIT, type Status, User } from "./data-kinds";

export function useKinds(s: Status): number {
  const a = new Account();
  a.balance = LIMIT;
  handlers.build("x");
  if (s === "open" && User.kind === "user") return double(Color.Red);
  return handlers.query("q") + a.balance;
}

export function asUser(u: User): User {
  return u;
}
