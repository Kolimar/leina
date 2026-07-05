//! crate_a: exercises Rust's impl/trait/enum/union shapes for the SCIP
//! id-parity gate. Two impl blocks share this file — Foo's inherent impl and
//! Bar's trait impl — both declaring a same-named method `greet`, so
//! `normalizeImpl`'s owner-rewrite (the synthetic `impl#[SelfType]`
//! descriptor rewritten to the Self type itself) must keep them apart
//! instead of colliding under a shared invented `impl` owner.

/// Foo has an inherent method `greet`.
pub struct Foo {
    pub name: String,
}

impl Foo {
    /// Foo's own greet — no trait involved (inherent impl -> `impl#[Foo]`).
    pub fn greet(&self) -> String {
        format!("Foo says hi, {}", self.name)
    }
}

/// Greeter is implemented by Bar; the trait itself owns a distinct `greet`
/// definition too (no synthetic `impl` descriptor here — a trait body's
/// members attach directly to `Greeter#`, not through an `impl` block).
pub trait Greeter {
    fn greet(&self) -> String;
}

/// Bar implements Greeter — same method NAME as Foo's inherent `greet`, on a
/// different owner (trait impl -> `impl#[Bar][Greeter]`, rewritten to `Bar`).
pub struct Bar {
    pub name: String,
}

impl Greeter for Bar {
    fn greet(&self) -> String {
        format!("Bar says hi, {}", self.name)
    }
}

/// Direction is a plain enum (SCIP `Enum` kind -> class, same node kind as
/// struct/union — mirrors treesitter.ts's rust `classTypes`).
pub enum Direction {
    North,
    South,
}

/// Number is a union (SCIP `Union` kind -> class).
pub union Number {
    pub i: i32,
    pub f: f32,
}

/// Top-level function (no owner) that calls both `greet` methods — also
/// exercised cross-crate from `crate_b`'s binary.
pub fn describe(foo: &Foo, bar: &Bar) -> String {
    format!("{} / {}", foo.greet(), bar.greet())
}
