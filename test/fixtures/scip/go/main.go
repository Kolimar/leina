package fixture

// Foo is a top-level function called from Bar.Greet.
func Foo() string {
	return "foo"
}

// Greeter is implemented by Bar.
type Greeter interface {
	Greet() string
}

// Bar is a struct implementing Greeter.
type Bar struct {
	Name string
}

// Greet implements Greeter for Bar. It calls Foo.
func (b *Bar) Greet() string {
	return Foo() + b.Name
}
