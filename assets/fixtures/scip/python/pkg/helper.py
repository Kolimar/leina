"""A class with a method, and a plain top-level function — both imported and
called cross-file from main.py."""


class Greeter:
    def greet(self, name):
        return f"hello {name}"


def add(a, b):
    return a + b
