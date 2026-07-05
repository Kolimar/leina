//! crate_b: a small binary crate depending on crate_a, exercising a
//! cross-crate call (`describe`) that a SINGLE `rust-analyzer scip .`
//! invocation over the whole workspace must resolve correctly.

use crate_a::{describe, Bar, Foo};

fn main() {
    let foo = Foo { name: "a".to_string() };
    let bar = Bar { name: "b".to_string() };
    println!("{}", describe(&foo, &bar));
}
