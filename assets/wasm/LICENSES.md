# Vendored parser grammar licenses

The `.wasm` files in this directory are prebuilt tree-sitter grammar parsers, vendored
from the [`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms) npm
package (v0.1.13) via `scripts/vendor-wasm.ts` (`npm run vendor:wasm`). See
`checksums.json` for the sha256 of each file as vendored.

## Packaging license

`tree-sitter-wasms` itself is released under the
[Unlicense](https://unlicense.org/) (public domain dedication) — verified against the
package's `LICENSE` file at vendor time. This covers the compiled `.wasm` artifacts as
packaged and redistributed here.

## Per-grammar upstream license

Each grammar is separately maintained upstream. All 12 vendored grammars use the MIT
license (verified against each upstream repository's `LICENSE` file):

| File | Language | Upstream repository | License | Copyright |
|---|---|---|---|---|
| `tree-sitter-python.wasm` | Python | tree-sitter/tree-sitter-python | MIT | (c) 2016 Max Brunsfeld |
| `tree-sitter-javascript.wasm` | JavaScript | tree-sitter/tree-sitter-javascript | MIT | (c) 2014 Max Brunsfeld |
| `tree-sitter-typescript.wasm` | TypeScript | tree-sitter/tree-sitter-typescript | MIT | (c) 2017 Max Brunsfeld |
| `tree-sitter-tsx.wasm` | TSX | tree-sitter/tree-sitter-typescript (same repo, `tsx` grammar) | MIT | (c) 2017 Max Brunsfeld |
| `tree-sitter-go.wasm` | Go | tree-sitter/tree-sitter-go | MIT | (c) 2014 Max Brunsfeld |
| `tree-sitter-java.wasm` | Java | tree-sitter/tree-sitter-java | MIT | (c) 2017 Ayman Nadeem |
| `tree-sitter-c_sharp.wasm` | C# | tree-sitter/tree-sitter-c-sharp | MIT | (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors |
| `tree-sitter-kotlin.wasm` | Kotlin | fwcd/tree-sitter-kotlin | MIT | (c) 2019 fwcd |
| `tree-sitter-rust.wasm` | Rust | tree-sitter/tree-sitter-rust | MIT | (c) 2017 Maxim Sokolov |
| `tree-sitter-ruby.wasm` | Ruby | tree-sitter/tree-sitter-ruby | MIT | (c) 2016 Rob Rix |
| `tree-sitter-php.wasm` | PHP | tree-sitter/tree-sitter-php | MIT | (c) 2017 Josh Vera, GitHub; (c) 2019 Max Brunsfeld, Amaan Qureshi, Christian Frøystad, Caleb White |
| `tree-sitter-yaml.wasm` | YAML (infra extractor fallback source) | tree-sitter-grammars/tree-sitter-yaml | MIT | (c) 2024 tree-sitter-grammars contributors; (c) 2019-2021 Ika |

All are permissive licenses compatible with redistribution inside leina (MIT). No
grammar in this set carries a copyleft or non-redistributable license; none was excluded.

The MIT license text (identical terms across all of the above, verbatim from each
upstream `LICENSE` file) is:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
