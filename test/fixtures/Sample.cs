using System;
using Demo.Auth;

namespace Demo
{
    interface IService
    {
        string Ping();
    }

    class BaseService : IService
    {
        public string Ping()
        {
            return "ok";
        }
    }

    public class UserService : BaseService
    {
        private TokenFactory factory;

        public string Login(string user)
        {
            var token = factory.Make(user);
            return Store(token);
        }

        private string Store(string token)
        {
            return token;
        }
    }

    class App
    {
        static void Main()
        {
            var svc = new UserService();
            Console.WriteLine(svc.Login("alice"));
        }
    }
}
