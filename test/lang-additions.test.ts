// lang-additions.test.ts — Kotlin, Rust, Ruby and PHP tree-sitter extraction contracts.
// Each language asserts the three things the graph depends on: definition nodes with the
// right kind, containment/method edges, and raw calls with correct callee names —
// including each grammar's quirk (kotlin: no field names; rust: impl_item names its Self
// type; ruby: callee in field "method"; php: identifier node type is "name").
// Run: node --no-warnings --experimental-strip-types --test test/lang-additions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile } from "../src/infrastructure/extractors/treesitter.ts";
import { detectLang } from "../src/application/graph/detect.ts";

test("(lang-detect) extensions map to the new languages", () => {
  assert.equal(detectLang("a/b.kt"), "kotlin");
  assert.equal(detectLang("a/b.kts"), "kotlin");
  assert.equal(detectLang("a/b.rs"), "rust");
  assert.equal(detectLang("a/b.rb"), "ruby");
  assert.equal(detectLang("a/b.php"), "php");
});

test("(lang-kotlin) classes/objects/functions + calls despite the grammar having no name fields", async () => {
  const src = `
import com.acme.util.Helper
interface Greeter { fun greet(): String }
class Foo(val h: Helper) : Greeter {
    override fun greet(): String { return h.assist() }
    fun run() { greet(); Bar().go() }
}
object Single { fun only() {} }
fun topLevel() { Single.only() }
`;
  const r = await extractFile("src/s.kt", src, "kotlin");
  const labels = r.nodes.map((n) => n.label);
  assert.ok(labels.includes("Foo"), "class Foo");
  assert.ok(labels.includes("Single"), "object Single as class");
  assert.ok(labels.includes("topLevel()"), "top-level function");
  assert.ok(labels.includes("greet()"), "method greet");
  const callees = r.rawCalls.map((c) => c.callee);
  assert.ok(callees.includes("greet"), "bare call greet()");
  assert.ok(callees.includes("go"), "navigation call .go()");
  assert.ok(callees.includes("only"), "Single.only()");
});

test("(lang-rust) impl block methods attach to the Self TYPE, not the trait", async () => {
  const src = `
use crate::util::helper;
pub trait Greeter { fn greet(&self) -> String; }
pub struct Foo { x: i32 }
impl Greeter for Foo {
    fn greet(&self) -> String { helper(); other(self.x) }
}
pub fn top_level() { println!("x"); }
enum Color { Red }
`;
  const r = await extractFile("src/s.rs", src, "rust");
  const byLabel = new Map(r.nodes.map((n) => [n.label, n]));
  assert.equal(byLabel.get("Greeter")?.kind, "interface", "trait → interface");
  assert.ok(byLabel.has("Foo"), "struct Foo");
  assert.ok(byLabel.has("Color"), "enum Color");
  // THE contract: `impl Greeter for Foo` methods land under Foo. (The trait's own
  // signature ALSO yields a greeter:greet method edge — that one is correct too.)
  const methodSources = r.edges.filter((e) => e.relation === "method" && e.target.endsWith(":greet")).map((e) => e.source);
  assert.ok(methodSources.some((s) => s.endsWith(":foo")), `impl methods belong to Foo (got sources: ${methodSources.join(", ")})`);
  const callees = r.rawCalls.map((c) => c.callee);
  assert.ok(callees.includes("helper"), "bare call");
  assert.ok(callees.includes("println"), "macro_invocation captured");
});

test("(lang-ruby) modules/classes/methods + callee via the 'method' field", async () => {
  const src = `
module Greeting
  class Foo
    def greet
      assist()
      Bar.new.go
    end
  end
end
def top_level
  Foo.new.greet
end
`;
  const r = await extractFile("src/s.rb", src, "ruby");
  const labels = r.nodes.map((n) => n.label);
  assert.ok(labels.includes("Greeting"), "module as container");
  assert.ok(labels.includes("Foo"), "class Foo");
  assert.ok(labels.includes("greet()"), "method greet");
  const calls = r.rawCalls;
  assert.ok(calls.some((c) => c.callee === "assist" && !c.isMember), "bare call assist()");
  assert.ok(calls.some((c) => c.callee === "greet" && c.isMember), "receiver call .greet");
  assert.ok(calls.some((c) => c.callee === "new" && c.isMember), "Foo.new");
});

test("(lang-php) interfaces/classes/methods + bare, member and new calls", async () => {
  const src = `<?php
use Acme\\Util\\Helper;
interface Greeter { public function greet(): string; }
class Foo implements Greeter {
    public function greet(): string { return assist(); }
    public function run() { $this->greet(); (new Bar())->go(); }
}
function topLevel() { $f = new Foo(); $f->greet(); }
`;
  const r = await extractFile("src/s.php", src, "php");
  const byLabel = new Map(r.nodes.map((n) => [n.label, n]));
  assert.equal(byLabel.get("Greeter")?.kind, "interface");
  assert.ok(byLabel.has("Foo"), "class Foo");
  assert.ok(byLabel.has("topLevel()"), "top-level function");
  const calls = r.rawCalls;
  assert.ok(calls.some((c) => c.callee === "assist" && !c.isMember), "bare call (identifier node type 'name')");
  assert.ok(calls.some((c) => c.callee === "greet" && c.isMember), "$this->greet()");
  assert.ok(calls.some((c) => c.callee === "Foo" && !c.isMember), "new Foo() as constructor call");
});
