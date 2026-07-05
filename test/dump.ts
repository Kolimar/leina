import { readFileSync } from "node:fs";
import { dumpTree } from "../src/infrastructure/extractors/treesitter.ts";
import { detectLang } from "../src/application/graph/detect.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: dump.ts <file>");
  process.exit(1);
}
const lang = detectLang(file);
if (!lang) {
  console.error("no lang for", file);
  process.exit(1);
}
const src = readFileSync(file, "utf8");
const depth = process.argv[3] ? Number(process.argv[3]) : 5;
console.log(`=== ${file} (${lang}) ===`);
console.log(await dumpTree(src, lang, depth));
