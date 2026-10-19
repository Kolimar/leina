// memory-symbol-span.test.ts — locating a graph symbol's source lines for symbol-level
// drift fingerprints (src/domain/memory/symbol-span.ts).
// Run: node --no-warnings --experimental-strip-types --test test/memory-symbol-span.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFileLevelHash,
  isSymbolFingerprint,
  locateSymbolSpan,
  parseLineHint,
  spanText,
  symbolName,
  type LineSpan,
} from "../src/domain/memory/symbol-span.ts";

const lines = (s: LineSpan | null): [number, number] | null => (s === null ? null : [s.start, s.end]);

const TS = [
  "import { x } from './x';", //                                    1
  "", //                                                            2
  "export function alpha(a: number): number {", //                  3
  "  if (a > 0) {", //                                              4
  "    return a;", //                                               5
  "  }", //                                                         6
  "  return -a;", //                                                7
  "}", //                                                           8
  "", //                                                            9
  "export function beta(opts: { n: number }): string {", //         10
  "  return `n=${opts.n}`;", //                                     11
  "}", //                                                           12
  "", //                                                            13
  "export const gamma = (s: string) => {", //                       14
  "  return s.replace(/[{}'\"]/g, \"\");", //                       15
  "};", //                                                          16
  "export const LIMIT = 5;", //                                     17
  "export type Kind = 'a' | 'b'", //                                18
  "export interface Shape {", //                                    19
  "  kind: Kind;", //                                               20
  "}", //                                                           21
].join("\n");

test("(span-1) a TS function spans from its declaration to its closing brace", () => {
  assert.deepEqual(lines(locateSymbolSpan(TS, "src/a.ts", "alpha()", 3)), [3, 8]);
  // A brace inside the parameter list does not end the span early.
  assert.deepEqual(lines(locateSymbolSpan(TS, "src/a.ts", "beta()", 10)), [10, 12]);
});

test("(span-2) arrow consts, one-line consts, semicolon-less types and interfaces", () => {
  // The regex literal holds braces and quotes; it must not derail the bracket scan.
  assert.deepEqual(lines(locateSymbolSpan(TS, "src/a.ts", "gamma()", 14)), [14, 16]);
  assert.deepEqual(lines(locateSymbolSpan(TS, "src/a.ts", "LIMIT", 17)), [17, 17]);
  assert.deepEqual(lines(locateSymbolSpan(TS, "src/a.ts", "Kind", 18)), [18, 18]);
  assert.deepEqual(lines(locateSymbolSpan(TS, "src/a.ts", "Shape", 19)), [19, 21]);
});

test("(span-3) a stale hint still lands on the nearest line naming the symbol", () => {
  // The graph was built before 4 lines were inserted above `beta`: hint 6 → found at 10.
  assert.deepEqual(lines(locateSymbolSpan(TS, "src/a.ts", "beta()", 6)), [10, 12]);
  // Out-of-range hints are clamped.
  assert.deepEqual(lines(locateSymbolSpan(TS, "src/a.ts", "Shape", 999)), [19, 21]);
});

test("(span-4) methods, qualified labels and multi-line signatures", () => {
  const src = [
    "export class Store {", //                 1
    "  private cache = new Map<string, number>();", // 2
    "  get(", //                               3
    "    key: string,", //                     4
    "  ): number | undefined {", //            5
    "    return this.cache.get(key);", //      6
    "  }", //                                  7
    "  // close() releases nothing", //        8
    "  close(): void {}", //                   9
    "}", //                                    10
  ].join("\n");
  assert.deepEqual(lines(locateSymbolSpan(src, "store.ts", "get()", 3)), [3, 7]);
  assert.deepEqual(lines(locateSymbolSpan(src, "store.ts", "Store.close()", 9)), [9, 9]);
  assert.deepEqual(lines(locateSymbolSpan(src, "store.ts", "Store", 1)), [1, 10]);
  // A comment naming the symbol is never taken for its declaration.
  assert.deepEqual(lines(locateSymbolSpan(src, "store.ts", "close()", 8)), [9, 9]);
});

test("(span-5) Allman braces (C#/Java) and Python indentation blocks", () => {
  const cs = [
    "public class Greeter", //                 1
    "{", //                                    2
    "    public string Greet(string name)", // 3
    "    {", //                                4
    "        return \"hi \" + name;", //       5
    "    }", //                                6
    "}", //                                    7
  ].join("\n");
  assert.deepEqual(lines(locateSymbolSpan(cs, "Greeter.cs", "Greet()", 3)), [3, 6]);
  assert.deepEqual(lines(locateSymbolSpan(cs, "Greeter.cs", "Greeter", 1)), [1, 7]);

  const py = [
    "class Service:", //                       1
    "    def login(self,", //                  2
    "              user):", //                 3
    "        token = make(user)", //           4
    "", //                                     5
    "        return token", //                 6
    "", //                                     7
    "    def logout(self):", //                8
    "        pass", //                         9
    "", //                                     10
    "def helper():", //                        11
    "    return 1", //                         12
  ].join("\n");
  assert.deepEqual(lines(locateSymbolSpan(py, "svc.py", "login()", 2)), [2, 6]);
  assert.deepEqual(lines(locateSymbolSpan(py, "svc.py", "Service", 1)), [1, 9]);
  assert.deepEqual(lines(locateSymbolSpan(py, "svc.py", "helper()", 11)), [11, 12]);
});

test("(span-6) Rust lifetimes are not char literals", () => {
  const rs = [
    "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {", // 1
    "    if x.len() > y.len() { x } else { y }", //            2
    "}", //                                                    3
    "fn other() {}", //                                        4
  ].join("\n");
  assert.deepEqual(lines(locateSymbolSpan(rs, "src/lib.rs", "longest()", 1)), [1, 3]);
});

test("(span-7) no span: unknown language, non-identifier label, absent name, empty file", () => {
  assert.equal(locateSymbolSpan("verify:\n  run: x\n", ".github/workflows/ci.yml", "verify", 1), null);
  assert.equal(locateSymbolSpan(TS, "src/a.ts", "src/a.ts", 1), null);
  assert.equal(locateSymbolSpan(TS, "src/a.ts", "nowhere()", 3), null);
  assert.equal(locateSymbolSpan("", "src/a.ts", "alpha()", 1), null);
});

test("(span-8) the fingerprinted text ignores indentation and blank lines, not tokens", () => {
  const a = "function f() {\n  return 1;\n}\n";
  const reindented = "function f() {\n\n        return 1;\n}\n";
  const changed = "function f() {\n  return 2;\n}\n";
  const span = (s: string) => locateSymbolSpan(s, "f.ts", "f()", 1)!;
  assert.equal(spanText(a, span(a)), spanText(reindented, span(reindented)));
  assert.notEqual(spanText(a, span(a)), spanText(changed, span(changed)));
});

test("(span-9) label, hint and hash-format helpers", () => {
  assert.equal(symbolName("computeTotal()"), "computeTotal");
  assert.equal(symbolName("Foo.bar()"), "bar");
  assert.equal(symbolName("Ns::Type"), "Type");
  assert.equal(symbolName("src/a.ts"), null);
  assert.equal(parseLineHint("L42"), 42);
  assert.equal(parseLineHint(undefined), undefined);
  assert.equal(parseLineHint("L0"), undefined);
  assert.equal(parseLineHint("42"), undefined);
  assert.equal(isSymbolFingerprint(`sym1:${"a".repeat(64)}`), true);
  assert.equal(isSymbolFingerprint("a".repeat(64)), false);
  assert.equal(isFileLevelHash("a".repeat(64)), true);
  assert.equal(isFileLevelHash(`sym1:${"a".repeat(64)}`), false);
  assert.equal(isFileLevelHash("H1"), false);
});
