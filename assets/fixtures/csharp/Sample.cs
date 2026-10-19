// Verify fixture for `leina sidecar verify csharp`: shipped in the package so the check runs
// from an installed leina. One interface, one implementation, one cross-method call.
namespace VerifyFixture
{
    public interface IGreeter
    {
        string Greet(string name);
    }

    public class Greeter : IGreeter
    {
        public string Greet(string name)
        {
            return Format(name);
        }

        private static string Format(string name)
        {
            return "hello " + name;
        }
    }

    public static class Program
    {
        public static string Run()
        {
            return new Greeter().Greet("leina");
        }
    }
}
