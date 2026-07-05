from auth.tokens import make_token


class BaseService:
    def ping(self):
        return "ok"


class UserService(BaseService):
    def login(self, user):
        token = make_token(user)
        return self.store(token)

    def store(self, token):
        return token


def bootstrap():
    svc = UserService()
    return svc.login("alice")
