// Verify fixture for `leina sidecar verify java`: shipped in the package so the check runs
// from an installed leina. One interface, one implementation, one cross-method call.
interface Greeter {
    String greet(String name);
}

public class Sample implements Greeter {
    public String greet(String name) {
        return format(name);
    }

    private static String format(String name) {
        return "hello " + name;
    }

    public static String run() {
        return new Sample().greet("leina");
    }
}
