import { makeToken } from "./auth";

interface Service {
  ping(): string;
}

class BaseService implements Service {
  ping(): string {
    return "ok";
  }
}

export class UserService extends BaseService {
  login(user: string): string {
    const token = makeToken(user);
    return this.store(token);
  }

  store(token: string): string {
    return token;
  }
}

export function bootstrap(): string {
  const svc = new UserService();
  return svc.login("alice");
}
