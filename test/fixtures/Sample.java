package demo;

import demo.auth.TokenFactory;

interface Service {
    String ping();
}

class BaseService implements Service {
    public String ping() {
        return "ok";
    }
}

public class UserService extends BaseService {
    private TokenFactory factory;

    public String login(String user) {
        String token = factory.make(user);
        return store(token);
    }

    private String store(String token) {
        return token;
    }
}

class App {
    public static void main(String[] args) {
        UserService svc = new UserService();
        System.out.println(svc.login("alice"));
    }
}
