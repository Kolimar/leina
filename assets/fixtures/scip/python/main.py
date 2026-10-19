"""Entry point exercising: nested homonymous closures, a class instantiated
from an imported module, and a cross-file call — see README.md."""

import pkg.helper


def outer_a():
    def helper():
        return 1
    return helper()


def outer_b():
    def helper():
        return 2
    return helper()


def main():
    greeter = pkg.helper.Greeter()
    print(greeter.greet("world"))
    print(pkg.helper.add(1, 2))
    print(outer_a(), outer_b())


if __name__ == "__main__":
    main()
